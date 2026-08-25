import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LLM_MODEL, LLM_GATEWAY, llmApiKey, llmHeaders, LLM_USAGE_INCLUDE } from "../_shared/llm.ts";

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "google/gemini-3-flash-preview": { input: 0.15 / 1e6, output: 0.60 / 1e6 },
  "google/gemini-3.7-flash": { input: 0.75 / 1e6, output: 3.75 / 1e6 },
  "google/gemini-3.6-flash": { input: 0.75 / 1e6, output: 3.75 / 1e6 },
};

function logAiUsage(clinicTokenId: string | null, functionName: string, model: string, usage: any) {
  if (!usage) return;
  const pricing = MODEL_PRICING[model] || { input: 0.50 / 1e6, output: 1.50 / 1e6 };
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  const cost = promptTokens * pricing.input + completionTokens * pricing.output;
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, key);
  admin.from("ai_usage_logs").insert({
    clinic_token_id: clinicTokenId,
    function_name: functionName,
    model, prompt_tokens: promptTokens, completion_tokens: completionTokens,
    total_tokens: totalTokens, estimated_cost_usd: cost,
  }).then(({ error }) => { if (error) console.error("[AI Usage Log]", error.message); });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST required" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { current_script, instruction } = await req.json();

    if (!current_script || !instruction) {
      return new Response(JSON.stringify({ error: "current_script and instruction are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!llmApiKey()) {
      return new Response(JSON.stringify({ error: "AI not configured (defina OPENROUTER_API_KEY)" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const systemPrompt = `Você é um assistente especialista em engenharia de prompts para sistemas de IA de clínicas médicas.

Sua tarefa é modificar o script/prompt de classificação de intenções de acordo com a instrução do usuário.

Regras:
- Mantenha a estrutura geral do script original
- Aplique APENAS a modificação solicitada
- Preserve todas as regras e funcionalidades existentes que não foram mencionadas
- O resultado deve ser um prompt completo e funcional, não um diff
- Retorne APENAS o texto do script modificado, sem explicações, comentários ou formatação markdown
- Não adicione crases, aspas ou qualquer delimitador ao redor do texto`;

    const response = await fetch(LLM_GATEWAY, {
      method: "POST",
      headers: llmHeaders(),
      body: JSON.stringify({
        model: LLM_MODEL,
        usage: LLM_USAGE_INCLUDE,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Script atual:\n\n${current_script}\n\n---\n\nInstrução de modificação: ${instruction}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns minutos." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes. Adicione créditos no workspace." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error("[AI Script Editor] Gateway error:", response.status, errorText);
      return new Response(JSON.stringify({ error: "Erro ao processar com IA" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await response.json();
    logAiUsage(null, "ai-script-editor", LLM_MODEL, result.usage);
    const modifiedScript = result.choices?.[0]?.message?.content || "";

    return new Response(JSON.stringify({ modified_script: modifiedScript.trim() }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[AI Script Editor] Error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
