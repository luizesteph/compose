import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LLM_MODEL, LLM_GATEWAY, llmApiKey, llmHeaders, LLM_USAGE_INCLUDE } from "../_shared/llm.ts";

function logAiUsage(clinicTokenId: string | null, functionName: string, model: string, usage: any) {
  if (!usage) return;
  // Preço do 3.6/3.7 Flash (promocional até 31/12/2026; dobra em 01/01/2027).
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

function pct(n: number, total: number) {
  if (!total) return "0.0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { clinic_token_id, date } = await req.json();
    if (!clinic_token_id || !date) {
      return new Response(JSON.stringify({ error: "clinic_token_id and date are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    // ============ Fetch messages (keyset pagination) ============
    const PAGE_SIZE = 500;
    let allMessages: any[] = [];
    let page = 0;
    let hasMore = true;
    let lastCreatedAt = startOfDay;
    let lastId: string | null = null;

    while (hasMore && page < 20) {
      let batch: any[] | null = null;
      let lastErr: any = null;
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
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
      if (lastErr) {
        return new Response(JSON.stringify({ error: `Failed to fetch messages: ${lastErr.message}` }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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

    // ============ Fetch auxiliary technical data in parallel ============
    const [
      { data: aiUsageRows },
      { data: pendingVerifs },
      { data: pendingTickets },
      { data: slotLocks },
      { data: scripts },
      { data: clinicInfo },
      { data: clinicToken },
    ] = await Promise.all([
      supabase.from("ai_usage_logs")
        .select("function_name, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, created_at")
        .eq("clinic_token_id", clinic_token_id)
        .gte("created_at", startOfDay).lte("created_at", endOfDay),
      supabase.from("pending_booking_verifications")
        .select("id, status, attempts, max_attempts, last_error, doctor_name, target_date, target_time, created_at")
        .eq("clinic_token_id", clinic_token_id)
        .gte("created_at", startOfDay).lte("created_at", endOfDay),
      supabase.from("pending_ticket_resolutions")
        .select("id, status, error_message, phone, created_at")
        .eq("clinic_token_id", clinic_token_id)
        .gte("created_at", startOfDay).lte("created_at", endOfDay),
      supabase.from("slot_locks")
        .select("id, doctor_id, slot_date, slot_time, expires_at, locked_at")
        .eq("clinic_token_id", clinic_token_id)
        .gte("locked_at", startOfDay).lte("locked_at", endOfDay),
      supabase.from("ai_scripts")
        .select("script_content, script_type")
        .eq("clinic_token_id", clinic_token_id).eq("is_active", true),
      supabase.from("clinic_info").select("*").eq("clinic_token_id", clinic_token_id).maybeSingle(),
      supabase.from("clinic_tokens")
        .select("clinic_name, ehr_type, ai_enabled, recovery_enabled, avanceai_enabled, avanceai_active_channel")
        .eq("id", clinic_token_id).maybeSingle(),
    ]);

    // ============ Telemetry computations ============
    const totalMessages = messages.length;
    const incoming = messages.filter((m: any) => m.direction === "incoming");
    const outgoing = messages.filter((m: any) => m.direction === "outgoing");
    const conversations = new Map<string, any[]>();
    for (const m of messages) {
      const k = m.conversation_id || `phone:${m.sender_phone || "unknown"}`;
      if (!conversations.has(k)) conversations.set(k, []);
      conversations.get(k)!.push(m);
    }

    // intent distribution
    const intentCounts: Record<string, number> = {};
    for (const m of incoming) {
      const k = m.ai_intent || "(null)";
      intentCounts[k] = (intentCounts[k] || 0) + 1;
    }
    // action_status breakdown
    const statusCounts: Record<string, number> = {};
    for (const m of messages) {
      const k = m.action_status || "(null)";
      statusCounts[k] = (statusCounts[k] || 0) + 1;
    }
    // action_error top
    const errorCounts: Record<string, number> = {};
    for (const m of messages) {
      if (m.action_error) errorCounts[m.action_error] = (errorCounts[m.action_error] || 0) + 1;
    }
    const topErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // latency: gap between incoming and next outgoing per conversation (ms)
    const latencies: number[] = [];
    for (const [, msgs] of conversations) {
      const sorted = [...msgs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].direction === "incoming" && sorted[i + 1].direction === "outgoing") {
          const gap = new Date(sorted[i + 1].created_at).getTime() - new Date(sorted[i].created_at).getTime();
          if (gap > 0 && gap < 10 * 60 * 1000) latencies.push(gap);
        }
      }
    }
    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    // AI usage aggregation
    const usageAgg: Record<string, { fn: string; model: string; pt: number; ct: number; tt: number; cost: number; calls: number }> = {};
    let totalCost = 0;
    for (const r of (aiUsageRows || [])) {
      const k = `${r.function_name}|${r.model}`;
      if (!usageAgg[k]) usageAgg[k] = { fn: r.function_name, model: r.model, pt: 0, ct: 0, tt: 0, cost: 0, calls: 0 };
      usageAgg[k].pt += r.prompt_tokens || 0;
      usageAgg[k].ct += r.completion_tokens || 0;
      usageAgg[k].tt += r.total_tokens || 0;
      usageAgg[k].cost += Number(r.estimated_cost_usd || 0);
      usageAgg[k].calls += 1;
      totalCost += Number(r.estimated_cost_usd || 0);
    }
    const usageTable = Object.values(usageAgg).sort((a, b) => b.cost - a.cost);

    // Verifications breakdown
    const verifBreakdown: Record<string, number> = {};
    for (const v of (pendingVerifs || [])) verifBreakdown[v.status] = (verifBreakdown[v.status] || 0) + 1;
    const failedVerifs = (pendingVerifs || []).filter((v: any) => v.status === "failed" || (v.last_error && v.attempts >= v.max_attempts));

    // Ticket resolutions breakdown
    const ticketBreakdown: Record<string, number> = {};
    for (const t of (pendingTickets || [])) ticketBreakdown[t.status] = (ticketBreakdown[t.status] || 0) + 1;

    // Slot locks active vs expired
    const now = Date.now();
    const lockActive = (slotLocks || []).filter((l: any) => new Date(l.expires_at).getTime() > now).length;
    const lockExpired = (slotLocks || []).length - lockActive;

    // Channels parse
    let channelsCount = 0;
    try {
      const ch = clinicToken?.avanceai_active_channel;
      if (ch) {
        const parsed = typeof ch === "string" ? JSON.parse(ch) : ch;
        channelsCount = Array.isArray(parsed) ? parsed.length : 1;
      }
    } catch { channelsCount = clinicToken?.avanceai_active_channel ? 1 : 0; }

    // Sample critical conversations: those with action_error or skipped/orphan_ack
    const criticalConvs: { id: string; reason: string; transcript: string }[] = [];
    const intentForCritical = new Set(["orphan_ack"]);
    for (const [convId, msgs] of conversations) {
      const hasErr = msgs.some((m: any) => m.action_error);
      const hasOrphan = msgs.some((m: any) => intentForCritical.has(m.ai_intent || ""));
      const hasFail = msgs.some((m: any) => m.action_status === "failed");
      if (hasErr || hasOrphan || hasFail) {
        const sorted = [...msgs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).slice(0, 12);
        const transcript = sorted.map((m: any) => {
          const t = new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
          const dir = m.direction === "incoming" ? "IN" : "OUT";
          const meta = [
            m.ai_intent ? `intent=${m.ai_intent}` : null,
            m.action_status && m.action_status !== "pending" ? `status=${m.action_status}` : null,
            m.action_error ? `err="${m.action_error}"` : null,
          ].filter(Boolean).join(" ");
          return `  [${t}] ${dir} ${meta ? `(${meta})` : ""}\n    ${(m.message_text || m.ai_response || "").slice(0, 240)}`;
        }).join("\n");
        criticalConvs.push({
          id: convId,
          reason: [hasErr && "action_error", hasOrphan && "orphan_ack", hasFail && "failed"].filter(Boolean).join("+"),
          transcript,
        });
        if (criticalConvs.length >= 5) break;
      }
    }

    // ============ Build technical context block ============
    const intentLines = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  - \`${k}\`: ${v} (${pct(v, incoming.length)})`).join("\n");
    const statusLines = Object.entries(statusCounts).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `  - \`${k}\`: ${v} (${pct(v, totalMessages)})`).join("\n");
    const errorLines = topErrors.length
      ? topErrors.map(([msg, n]) => `  - [${n}x] \`${msg.slice(0, 200)}\``).join("\n")
      : "  - (nenhum erro registrado)";
    const usageLines = usageTable.length
      ? usageTable.map(u => `  - \`${u.fn}\` × \`${u.model}\` — ${u.calls} chamadas, ${u.pt}+${u.ct}=${u.tt} tokens, **$${u.cost.toFixed(4)}**`).join("\n")
      : "  - (nenhum log de uso de IA registrado)";
    const verifFailedLines = failedVerifs.length
      ? failedVerifs.slice(0, 10).map((v: any) => `  - id=\`${v.id}\` doctor=${v.doctor_name || "?"} ${v.target_date} ${v.target_time} attempts=${v.attempts}/${v.max_attempts} last_error=\`${(v.last_error || "").slice(0, 160)}\``).join("\n")
      : "  - (nenhuma verificação falhou)";

    const techContext = `
## Métricas Coletadas (pré-computadas)

### Volume
- Total mensagens: **${totalMessages}** (in: ${incoming.length}, out: ${outgoing.length})
- Conversas únicas: **${conversations.size}**
- Razão out/in: ${incoming.length ? (outgoing.length / incoming.length).toFixed(2) : "N/A"}

### Latência IA (incoming → próximo outgoing, ms)
- Amostras: ${latencies.length}
- p50: **${p50}ms** | p95: **${p95}ms** | p99: **${p99}ms**

### Distribuição de intents (sobre ${incoming.length} mensagens incoming)
${intentLines || "  - (vazio)"}

### action_status breakdown (sobre ${totalMessages} mensagens)
${statusLines || "  - (vazio)"}

### Top action_error
${errorLines}

### AI usage agregada (custo total: **$${totalCost.toFixed(4)}**)
${usageLines}

### pending_booking_verifications (${(pendingVerifs || []).length} criadas no dia)
- breakdown por status: ${JSON.stringify(verifBreakdown)}
- falhadas:
${verifFailedLines}

### pending_ticket_resolutions (${(pendingTickets || []).length} no dia)
- breakdown por status: ${JSON.stringify(ticketBreakdown)}

### slot_locks (${(slotLocks || []).length} criados no dia)
- ativos: ${lockActive} | expirados: ${lockExpired}

### Configuração da clínica
- nome: \`${clinicToken?.clinic_name || "?"}\`
- ehr_type: \`${clinicToken?.ehr_type || "?"}\`
- ai_enabled: ${clinicToken?.ai_enabled} | recovery_enabled: ${clinicToken?.recovery_enabled} | avanceai_enabled: ${clinicToken?.avanceai_enabled}
- canais ativos: ${channelsCount}
`;

    // Scripts text
    let rulesText = "";
    if (scripts && scripts.length > 0) {
      for (const s of scripts) rulesText += `\n--- Script (${s.script_type}) ---\n${s.script_content}\n`;
    }

    // Critical samples
    const samplesText = criticalConvs.length
      ? criticalConvs.map((c, i) => `### Amostra ${i + 1} — conv=\`${c.id}\` — motivo: ${c.reason}\n\`\`\`\n${c.transcript}\n\`\`\``).join("\n\n")
      : "_(nenhuma conversa crítica detectada hoje)_";

    const systemPrompt = `Você é um engenheiro sênior auditando um pipeline de IA conversacional para clínicas médicas (WhatsApp + EHR Amigo + provedor AvanceAI/Z-PRO). Sua tarefa é gerar um RELATÓRIO TÉCNICO denso, sem floreios, em Markdown, voltado para outra IA de evolução do produto e para engenheiros.

REGRAS DE TOM:
- Linguagem técnica densa. Sem emojis decorativos no corpo (apenas no H1).
- SEMPRE cite IDs reais (\`message_id\`, \`conversation_id\`, \`pending_verification_id\`) quando disponíveis nas amostras.
- Código, nomes de função, modelos, colunas e arquivos entre crases.
- Valores monetários em USD com 4 casas decimais.
- Hipóteses devem ser etiquetadas (ex: "Hipótese: ...") e separadas de fatos.
- Bugs classificados como **P0** (corrompe dados/derruba pipeline), **P1** (degrada UX/custo), **P2** (cosmético/menor).

USE EXATAMENTE estas seções (não invente outras, não pule nenhuma):

# 🔧 Relatório Técnico — ${date}

## 1. Telemetria
Resuma volume, conversas, taxa de skipped/orphan_ack, distribuição de intents (tabela markdown), action_status breakdown (tabela), latência p50/p95/p99 — use os números pré-computados que recebi.

## 2. Custos & Modelos de IA
Tabela markdown por \`function_name\` × \`model\` com calls, tokens (in/out/total) e USD. Comente outliers (modelos caros, funções com muitas chamadas).

## 3. Falhas & Erros
- Top \`action_error\` agrupados (use os pré-computados).
- Pending verifications falhadas com \`last_error\`.
- Tickets não resolvidos.
Para cada cluster de erro: hipótese de causa raiz + arquivo/função suspeita.

## 4. Guards & Circuit Breakers
Acionamentos de \`orphan_ack\`, greeting-guard, post-booking-guard, anti-saudacao detectados nas conversas. Conversas que aparentam ter batido circuit breaker (3+ unknowns sequenciais, transferência forçada).

## 5. Análise de Pipeline
Pontos onde a IA aparenta ter inventado dados (compare \`ai_response\` com contexto). Gaps entre regra configurada nos scripts e execução real. Cite trechos das amostras.

## 6. Bugs Suspeitos & Hipóteses Técnicas
Lista numerada. Para cada bug:
- Severidade (P0/P1/P2)
- Arquivo/função suspeita (ex: \`whatsapp-webhook/index.ts:classifyIntent\`)
- Evidência (\`message_id\`, \`conversation_id\` real)
- Hipótese de causa raiz
- Impacto observado (ex: "X% dos casos", "Y USD desperdiçados")

## 7. Recomendações de Evolução
### 7a. Mudanças de código
Edge functions, schema, índices DB, retries, timeouts. Seja específico (nome de arquivo + linha aproximada se possível).
### 7b. Mudanças de prompt/script
Cite trecho atual literal do script + versão sugerida. Justifique.
### 7c. Novos guards / observabilidade faltante
Métricas que deveriam existir, alertas, logs estruturados.

## 8. Anexo: amostras críticas
Reproduza 3-5 trechos com IDs reais e diagnóstico curto por amostra.

DADOS RECEBIDOS:
${techContext}

REGRAS E SCRIPTS DA IA:
${rulesText || "(nenhum script configurado)"}
`;

    const userPrompt = `Amostras críticas detectadas hoje:

${samplesText}

---

Gere o relatório técnico completo agora, seguindo rigorosamente a estrutura exigida.`;

    if (!llmApiKey()) {
      return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes. Adicione créditos ao workspace." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Erro ao gerar relatório técnico" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResponse.json();
    logAiUsage(clinic_token_id, "generate-technical-report", LLM_MODEL, aiData.usage);
    const report = aiData.choices?.[0]?.message?.content || "Erro: nenhum conteúdo gerado.";

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: userData } = await supabase.auth.getUser();

    await adminClient.from("daily_reports").upsert(
      {
        clinic_token_id,
        user_id: userData?.user?.id || null,
        report_date: date,
        report_content: report,
        report_type: "technical",
      },
      { onConflict: "clinic_token_id,report_date,report_type" }
    );

    return new Response(JSON.stringify({ report }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-technical-report error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
