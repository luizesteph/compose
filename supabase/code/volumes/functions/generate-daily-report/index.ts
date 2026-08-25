import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LLM_MODEL, LLM_GATEWAY, llmApiKey, llmHeaders, LLM_USAGE_INCLUDE } from "../_shared/llm.ts";

function logAiUsage(clinicTokenId: string | null, functionName: string, model: string, usage: any) {
  if (!usage) return;
  // Preço do 3.6/3.7 Flash (promocional até 31/12/2026; dobra em 01/01/2027).
  // Estava fixo no preço do gemini-3-flash-preview (0,15/0,60) e, depois da troca
  // de modelo, subnotificaria o custo em 5x — o relatório mentiria justo no mês
  // em que o gasto mudou.
  const p = { input: 0.75 / 1e6, output: 3.75 / 1e6 };
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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { clinic_token_id, date } = await req.json();
    if (!clinic_token_id || !date) {
      return new Response(JSON.stringify({ error: "clinic_token_id and date are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build date range
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    // Fetch ALL messages with keyset pagination (slim columns to avoid timeout)
    const PAGE_SIZE = 500;
    let allMessages: any[] = [];
    let page = 0;
    let hasMore = true;
    let lastCreatedAt = startOfDay;
    let lastId: string | null = null;

    const fetchPage = async (after: string, afterId: string | null) => {
      let q = supabase
        .from("webhook_messages")
        .select("id, conversation_id, direction, sender_phone, sender_name, message_text, ai_intent, ai_response, action_status, action_error, created_at")
        .eq("clinic_token_id", clinic_token_id)
        .lte("created_at", endOfDay)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(PAGE_SIZE);
      q = afterId ? q.gt("created_at", after).or(`and(created_at.eq.${after},id.gt.${afterId})`) : q.gte("created_at", after);
      return await q;
    };

    while (hasMore && page < 20) {
      let batch: any[] | null = null;
      let lastErr: any = null;
      // Retry up to 3 times on transient pg errors
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data, error } = await supabase
          .from("webhook_messages")
          .select("id, conversation_id, direction, sender_phone, sender_name, message_text, ai_intent, ai_response, action_status, action_error, created_at")
          .eq("clinic_token_id", clinic_token_id)
          .gte("created_at", lastCreatedAt)
          .lte("created_at", endOfDay)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(0, PAGE_SIZE - 1);
        if (!error) { batch = data || []; lastErr = null; break; }
        lastErr = error;
        console.warn(`[report] page ${page} attempt ${attempt + 1} failed:`, error.message);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }

      if (lastErr) {
        console.error("Error fetching messages page", page, lastErr);
        return new Response(JSON.stringify({ error: `Failed to fetch messages: ${lastErr.message || "timeout"}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Skip already-seen rows (overlap on lastCreatedAt boundary)
      const fresh = lastId ? (batch || []).filter((r: any) => !(r.created_at === lastCreatedAt && r.id <= lastId!)) : (batch || []);
      allMessages = allMessages.concat(fresh);
      hasMore = (batch?.length || 0) === PAGE_SIZE;
      if (hasMore && batch && batch.length > 0) {
        const last = batch[batch.length - 1];
        lastCreatedAt = last.created_at;
        lastId = last.id;
      }
      page++;
    }

    const messages = allMessages;
    console.log(`Fetched ${messages.length} messages across ${page} page(s)`);

    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ report: `# Relatório do dia ${date}\n\nNenhuma conversa encontrada para este dia.` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch AI scripts (rules)
    const { data: scripts } = await supabase
      .from("ai_scripts")
      .select("script_content, script_type")
      .eq("clinic_token_id", clinic_token_id)
      .eq("is_active", true);

    // Fetch clinic info
    const { data: clinicInfo } = await supabase
      .from("clinic_info")
      .select("*")
      .eq("clinic_token_id", clinic_token_id)
      .maybeSingle();

    // Fetch clinic name
    const { data: clinicToken } = await supabase
      .from("clinic_tokens")
      .select("clinic_name")
      .eq("id", clinic_token_id)
      .maybeSingle();

    // Group messages by conversation
    const conversations: Record<string, typeof messages> = {};
    for (const msg of messages) {
      const convId = msg.conversation_id || "sem-conversa";
      if (!conversations[convId]) conversations[convId] = [];
      conversations[convId].push(msg);
    }

    // Format conversations for the prompt
    let conversationsText = "";
    let convIndex = 0;
    for (const [convId, msgs] of Object.entries(conversations)) {
      convIndex++;
      const contactName = msgs.find((m) => m.sender_name)?.sender_name || "Desconhecido";
      const contactPhone = msgs.find((m) => m.sender_phone)?.sender_phone || "N/A";
      conversationsText += `\n### Conversa ${convIndex} — ${contactName} (${contactPhone})\n`;
      for (const m of msgs) {
        const time = new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        if (m.direction === "incoming") {
          conversationsText += `[${time}] 📩 Paciente: ${m.message_text || "(sem texto)"}\n`;
          if (m.ai_intent) conversationsText += `       → Intent: ${m.ai_intent}\n`;
          if (m.action_status && m.action_status !== "pending") conversationsText += `       → Ação: ${m.action_status}${m.action_error ? ` (erro: ${m.action_error})` : ""}\n`;
        } else {
          conversationsText += `[${time}] 🤖 IA: ${m.ai_response || m.message_text || "(sem resposta)"}\n`;
        }
      }
    }

    // Build rules text
    let rulesText = "";
    if (scripts && scripts.length > 0) {
      for (const s of scripts) {
        rulesText += `\n--- Script (${s.script_type}) ---\n${s.script_content}\n`;
      }
    }

    // Build clinic context
    let clinicContext = "";
    if (clinicInfo) {
      clinicContext = `
Clínica: ${clinicToken?.clinic_name || "N/A"}
Horário: ${clinicInfo.business_hours || "N/A"}
Descrição: ${clinicInfo.clinic_description || "N/A"}
Especialidade: ${clinicInfo.specialty || "N/A"}
Endereço: ${clinicInfo.address || "N/A"}
Notas: ${clinicInfo.custom_notes || "N/A"}
Regras de roteamento: ${JSON.stringify(clinicInfo.routing_rules) || "N/A"}
`;
    }

    const totalConversations = Object.keys(conversations).length;
    const totalMessages = messages.length;
    const incomingCount = messages.filter((m) => m.direction === "incoming").length;
    const outgoingCount = messages.filter((m) => m.direction === "outgoing").length;

    const systemPrompt = `Você é um auditor especializado em atendimento automatizado por IA para clínicas médicas. Sua tarefa é analisar TODAS as conversas do dia e gerar um relatório completo de performance.

CONTEXTO DA CLÍNICA:
${clinicContext}

REGRAS E SCRIPTS CONFIGURADOS PARA A IA:
${rulesText || "Nenhum script configurado."}

ESTATÍSTICAS DO DIA:
- Total de conversas: ${totalConversations}
- Total de mensagens: ${totalMessages} (${incomingCount} recebidas, ${outgoingCount} enviadas)

Gere um relatório em Markdown com EXATAMENTE estas seções:

# 📊 Relatório de Performance — ${date}

## 1. Resumo do Dia
Visão geral com números: total de conversas, mensagens, agendamentos realizados, intenções identificadas, etc.

## 2. Avaliação por Conversa
Para CADA conversa, avalie:
- O que o paciente queria
- Como a IA respondeu
- Se seguiu as regras configuradas
- Nota de 1 a 10

## 3. ⚠️ Problemas Identificados
Liste TODOS os momentos em que a IA:
- Não seguiu alguma regra
- Deu informação incorreta
- Teve comportamento inadequado
- Errou uma ação (action_error)
- Respondeu de forma genérica quando deveria ser específica
Destaque cada problema com ⚠️ e explique o que deveria ter sido feito.

## 4. Regras vs. Comportamento Real
Compare as regras configuradas com o que a IA realmente fez. Use uma tabela ou lista comparativa.

## 5. 💡 Sugestões de Melhoria

### 5a. 🔧 Correções de Código (infraestrutura/lógica)
Liste problemas que exigem alteração no código da edge function, lógica de roteamento, integração com APIs externas, batching, ou qualquer componente técnico. Especifique qual parte do sistema precisa ser alterada.

### 5b. 📝 Correções de Script/Prompt (tom/regras/texto)
Liste ajustes no texto dos scripts de IA, tom de resposta, regras de classificação de intent, ou instruções do prompt. Seja específico — diga EXATAMENTE o que mudar no texto do script, citando o trecho atual e a versão corrigida sugerida.

## 6. Nota Geral do Dia
Dê uma nota geral de 0 a 10 com justificativa.

Seja rigoroso, detalhista e construtivo. O objetivo é melhorar continuamente o atendimento.`;

    const userPrompt = `Aqui estão TODAS as conversas do dia ${date}:\n${conversationsText}`;

    // Chamada ao gateway de LLM (OpenRouter desde 24/08)
    if (!llmApiKey()) {
      return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResponse = await fetch(LLM_GATEWAY, {
      method: "POST",
      headers: llmHeaders(),
      body: JSON.stringify({
        model: LLM_MODEL,
        usage: LLM_USAGE_INCLUDE,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("AI Gateway error:", aiResponse.status, errText);

      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns minutos." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes. Adicione créditos ao workspace." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Erro ao gerar relatório com IA" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    logAiUsage(clinic_token_id, "generate-daily-report", LLM_MODEL, aiData.usage);
    const report = aiData.choices?.[0]?.message?.content || "Erro: nenhum conteúdo gerado.";

    // Save report to daily_reports table using service role
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData } = await supabase.auth.getUser();

    await adminClient.from("daily_reports").upsert(
      {
        clinic_token_id: clinic_token_id,
        user_id: userData?.user?.id || null,
        report_date: date,
        report_content: report,
        report_type: "operational",
      },
      { onConflict: "clinic_token_id,report_date,report_type" }
    );

    return new Response(JSON.stringify({ report }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-daily-report error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
