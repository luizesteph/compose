import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LLM_MODEL, LLM_GATEWAY, llmApiKey, llmHeaders, LLM_USAGE_INCLUDE } from "../_shared/llm.ts";

function logAiUsage(clinicTokenId: string | null, functionName: string, model: string, usage: any) {
  if (!usage) return;
  const pricing: Record<string, { input: number; output: number }> = {
    "google/gemini-3-flash-preview": { input: 0.15 / 1e6, output: 0.60 / 1e6 },
    "google/gemini-3.7-flash": { input: 0.75 / 1e6, output: 3.75 / 1e6 },
    "google/gemini-3.6-flash": { input: 0.75 / 1e6, output: 3.75 / 1e6 },
  };
  const p = pricing[model] || { input: 0.50 / 1e6, output: 1.50 / 1e6 };
  const pt = usage.prompt_tokens || 0, ct = usage.completion_tokens || 0;
  const cost = pt * p.input + ct * p.output;
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  createClient(url, key).from("ai_usage_logs").insert({
    clinic_token_id: clinicTokenId, function_name: functionName, model,
    prompt_tokens: pt, completion_tokens: ct, total_tokens: usage.total_tokens || pt + ct,
    estimated_cost_usd: cost,
  }).then(({ error }) => { if (error) console.error("[AI Usage Log]", error.message); });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { raw_text, current_notes, clinic_token_id } = await req.json();

    if (!llmApiKey()) throw new Error("OPENROUTER_API_KEY is not configured");

    const systemPrompt = `Você é um assistente especializado em organizar informações de clínicas médicas de forma hierárquica e clara.

Sua tarefa:
1. Receber informações soltas/bagunçadas sobre uma clínica
2. Mesclar com os dados de referência já existentes (se houver)
3. Organizar tudo em uma estrutura hierárquica bem definida usando markdown

## Estrutura obrigatória (use apenas as seções que tiverem dados):

### \`## Equipe Médica\`
Para CADA médico mencionado, crie uma sub-seção:
\`\`\`
### Dr(a). [Nome Completo]
- **Especialidade:** [especialidade]
- **Subespecialidade:** [se houver]
- **Dias de atendimento:** [dias e horários específicos]
- **Procedimentos:** [lista do que realiza]
- **Convênios:** [se aceita convênios específicos diferentes dos gerais]
- **Observações:** [qualquer info específica deste médico]
\`\`\`

### \`## Convênios e Planos\`
Lista de convênios aceitos pela clínica como um todo. Se um convênio for aceito apenas por médico(s) específico(s), indique na seção do médico.

### \`## Procedimentos e Exames\`
Procedimentos gerais da clínica (não específicos de um médico). Inclua local/andar se informado.

### \`## Regras e Políticas\`
Cancelamento, antecedência, documentos necessários, políticas de atraso, etc.

### \`## Infraestrutura\`
Salas, andares, equipamentos, laboratório próprio, etc.

### \`## Contato e Localização\`
Telefones, endereço detalhado, como chegar, estacionamento.

### \`## Observações Gerais\`
Qualquer informação que não se encaixe nas categorias acima.

Regras RÍGIDAS:
- NÃO invente dados. Organize APENAS o que foi fornecido.
- Use hierarquia markdown: \`##\` para seções principais, \`###\` para sub-seções (médicos)
- Cada médico DEVE ter sua própria sub-seção dentro de "Equipe Médica"
- Se houver dados existentes, MESCLE sem duplicar
- Se uma informação nova contradiz uma existente, PRIORIZE a nova
- Remova seções vazias — só inclua o que tem dados
- Responda APENAS com o texto organizado, sem explicações ou comentários adicionais`;

    const userMessage = current_notes
      ? `## Dados de referência atuais:\n${current_notes}\n\n## Novas informações para incorporar:\n${raw_text}`
      : `## Informações para organizar:\n${raw_text}`;

    const response = await fetch(LLM_GATEWAY, {
      method: "POST",
      headers: llmHeaders(),
      body: JSON.stringify({
        model: LLM_MODEL,
        usage: LLM_USAGE_INCLUDE,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requisições excedido, tente novamente em instantes." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes. Adicione créditos ao workspace." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      throw new Error("Erro ao chamar IA");
    }

    const result = await response.json();
    logAiUsage(clinic_token_id || null, "organize-clinic-data", LLM_MODEL, result.usage);
    const organized_data = result.choices?.[0]?.message?.content || "";

    return new Response(JSON.stringify({ organized_data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("organize-clinic-data error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
