import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LLM_MODEL, LLM_GATEWAY, llmApiKey, llmHeaders, LLM_USAGE_INCLUDE } from "../_shared/llm.ts";

function logAiUsage(clinicTokenId: string | null, functionName: string, model: string, usage: any) {
  if (!usage) return;
  const pricing: Record<string, { input: number; output: number }> = {
    "google/gemini-2.5-flash-lite": { input: 0.075 / 1e6, output: 0.30 / 1e6 },
    "google/gemini-3-flash-preview": { input: 0.15 / 1e6, output: 0.6 / 1e6 },
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

// Janela de silêncio 20h–7h (SP): nada de mensagem de madrugada/noite. Mesma
// regra e mesmos limites do motor da lista de espera — lá isso já valia, aqui
// não. Cada função tem sua cópia porque as edge functions não compartilham
// módulo entre si.
const QUIET_HOUR_START = 20;
const QUIET_HOUR_END = 7;
function getNowSPHour(): number {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  });
  return Number(fmt.formatToParts(new Date()).find((p) => p.type === "hour")?.value ?? "12");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Normalize phone for matching webhook_messages.sender_phone (which is digits-only with 55 prefix)
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

// Check ticket status via AvanceAI to avoid messaging when human is handling
async function isTicketOpen(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  phone: string,
): Promise<boolean> {
  try {
    const url = `${baseUrl}/api/${apiId}/tickets/showticket?number=${encodeURIComponent(phone)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) return true; // fail-CLOSED: treat API errors as "human active" to avoid interrupting
    const data = await res.json();
    const status = (data?.status || data?.ticket?.status || "").toString().toLowerCase();
    return status === "open" || status === "unknown";
  } catch {
    return true; // fail-CLOSED: on network error, assume human may be active
  }
}

async function sendWhatsApp(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  channelId: number | null,
  phone: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const sendUrl = `${baseUrl}/api/${apiId}/messages/send`;
  const payload: Record<string, unknown> = { number: phone, body: message, externalKey: crypto.randomUUID(), isClosed: false };
  if (channelId) {
    payload.whatsappId = channelId;
    payload.channelId = channelId;
  }
  try {
    const res = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function resolveChannelId(activeChannel: string | null): number | null {
  if (!activeChannel) return null;
  try {
    const channels = JSON.parse(activeChannel);
    if (Array.isArray(channels) && channels.length > 0) {
      return parseInt(channels[0].id, 10);
    }
  } catch { /* ignore */ }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Authenticate cron requests via shared secret
  const cronSecret = req.headers.get("x-cron-secret");
  if (!cronSecret || cronSecret !== Deno.env.get("CRON_SECRET")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // JANELA DE SILÊNCIO 20h–7h (SP), 06/08. O motor da lista de espera já
  // respeitava; estes dois follow-ups, não — um que vencesse às 23:00 era
  // enviado às 23:00. Aqui só ADIA: no primeiro ciclo depois das 7h ele sai.
  const _sp = getNowSPHour();
  if (_sp >= QUIET_HOUR_START || _sp < QUIET_HOUR_END) {
    return new Response(JSON.stringify({ skipped: "quiet_hours", hour_sp: _sp }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // Esta função apontava para api.lovable.dev, um host DIFERENTE das outras
    // cinco — por isso ficava para trás em toda troca de gateway. Agora usa o
    // mesmo módulo compartilhado que todo mundo.
    const lovableApiKey = llmApiKey();
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // FOLLOW-UP VENCIDO DEMAIS NUNCA É ENVIADO (06/08). Havia 40 registros
    // parados em 'pending' desde 20–22/04 — o cron os relia a cada 5 minutos e a
    // consulta não tinha teto de atraso. Bastava uma mudança no caminho de erro
    // para 40 pacientes receberem "conseguiu agendar pelo link?" sobre uma
    // conversa de abril. O follow-up do widget é um empurrãozinho de minutos:
    // depois de ~16h ele não faz mais sentido, então expira em vez de acumular.
    // Limpa antes de ler — assim a fila se mantém sozinha, sem faxina manual.
    // O teto tem de ser MAIOR que a janela de silêncio (20h→7h = 11h), senão o
    // follow-up que vence às 20:05 e só é adiado até as 7h seria expirado no
    // caminho — o adiamento viraria descarte. 16h dá folga para a janela inteira
    // mais um atraso de cron, e ainda barra qualquer coisa do dia anterior.
    const RECOVERY_MAX_ATRASO_H = 16;
    const _limiteAtraso = new Date(Date.now() - RECOVERY_MAX_ATRASO_H * 3600_000).toISOString();
    const { data: _expirados } = await supabase
      .from("pending_follow_ups")
      .update({ status: "expired" })
      .eq("status", "pending")
      .lt("execute_at", _limiteAtraso)
      .select("id");
    if (_expirados && _expirados.length > 0) {
      console.log(
        `[patient-recovery] ${_expirados.length} follow-up(s) com mais de ${RECOVERY_MAX_ATRASO_H}h de atraso expirados sem envio`,
      );
    }

    // Fetch all pending follow-ups (any type) that are due
    const { data: pending, error: fetchErr } = await supabase
      .from("pending_follow_ups")
      .select("*")
      .eq("status", "pending")
      .lte("execute_at", new Date().toISOString())
      .gte("execute_at", _limiteAtraso)
      .limit(20);

    if (fetchErr) {
      console.error("[patient-recovery] Error fetching pending:", fetchErr);
      return new Response(JSON.stringify({ error: fetchErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[patient-recovery] Processing ${pending.length} pending follow-ups`);

    let sent = 0;
    let skipped = 0;

    for (const record of pending) {
      const followUpType = (record as any).follow_up_type || "inactivity";

      try {
        // ─────────────────────────────────────────────────────────────
        // BRANCH: widget_link (10-min check after sending widget URL)
        // ─────────────────────────────────────────────────────────────
        if (followUpType === "widget_link") {
          const phoneDigits = normalizePhone(record.phone);

          // 1. Pre-check: did patient send any incoming message after follow-up creation?
          const { data: incomingMsgs } = await supabase
            .from("webhook_messages")
            .select("id")
            .eq("conversation_id", record.conversation_id)
            .eq("direction", "incoming")
            .gt("created_at", record.created_at)
            .limit(1);

          if (incomingMsgs && incomingMsgs.length > 0) {
            console.log(`[patient-recovery][widget_link] Patient ${phoneDigits} already replied, skipping`);
            await supabase.from("pending_follow_ups").update({ status: "skipped" }).eq("id", record.id);
            skipped++;
            continue;
          }

          // 2. Check if a successful booking happened (widget OR whatsapp) since follow-up creation
          const { data: bookings } = await supabase
            .from("webhook_messages")
            .select("id, booking_source, ai_intent")
            .eq("clinic_token_id", record.clinic_token_id)
            .eq("sender_phone", phoneDigits)
            .eq("action_status", "success")
            .gt("created_at", record.created_at)
            .or("booking_source.eq.widget,ai_intent.eq.agendar")
            .limit(1);

          const didBook = !!(bookings && bookings.length > 0);

          // 3. Get clinic credentials
          const { data: clinicToken } = await supabase
            .from("clinic_tokens")
            .select("avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel")
            .eq("id", record.clinic_token_id)
            .maybeSingle();

          if (!clinicToken?.avanceai_base_url || !clinicToken?.avanceai_api_id || !clinicToken?.avanceai_bearer_token) {
            console.log(`[patient-recovery][widget_link] No WhatsApp credentials, skipping`);
            await supabase.from("pending_follow_ups").update({ status: "skipped" }).eq("id", record.id);
            skipped++;
            continue;
          }

          // 4. Pre-check ticket status: if open (human handling), skip
          const ticketOpen = await isTicketOpen(
            clinicToken.avanceai_base_url,
            clinicToken.avanceai_api_id,
            clinicToken.avanceai_bearer_token,
            phoneDigits,
          );
          if (ticketOpen) {
            console.log(`[patient-recovery][widget_link] Ticket open (human handling), skipping`);
            await supabase.from("pending_follow_ups").update({ status: "skipped" }).eq("id", record.id);
            skipped++;
            continue;
          }

          // 5. Build deterministic message (no LLM)
          // NOME DE VERDADE OU NENHUM (regra do dono, 11/08). `contact_name` é o
          // pushName do WhatsApp — auto-declarado, muitas vezes apelido, nome de
          // loja, ou o nome do dono do aparelho quando quem escreve é outra
          // pessoa da casa. O webhook já proíbe usá-lo para tratar o paciente
          // (regra Tema 4); estes follow-ups estavam furando essa regra e
          // chamando gente por nome errado. Sem nome confiável, cumprimenta sem
          // nome — nunca inventa.
          const message = didBook
            ? `Que bom que conseguiu agendar! 🎉 Sua consulta está confirmada. Qualquer coisa, é só me chamar por aqui.`
            : `Oi! E aí, conseguiu agendar pelo link? 😊 Se tiver qualquer dificuldade, me conta aqui que eu te ajudo a encontrar o melhor horário.`;

          // 6. Send via Z-PRO
          const channelId = resolveChannelId(clinicToken.avanceai_active_channel);
          console.log(`[patient-recovery][widget_link] Sending ${didBook ? "thanks" : "nudge"} to ${phoneDigits}`);
          const sendResult = await sendWhatsApp(
            clinicToken.avanceai_base_url,
            clinicToken.avanceai_api_id,
            clinicToken.avanceai_bearer_token,
            channelId,
            phoneDigits,
            message,
          );

          if (sendResult.ok) {
            await supabase.from("pending_follow_ups").update({ status: "sent" }).eq("id", record.id);

            // Save to webhook_messages history
            const { data: webhook } = await supabase
              .from("user_webhooks")
              .select("id")
              .eq("user_id", record.user_id)
              .eq("clinic_token_id", record.clinic_token_id)
              .maybeSingle();

            if (webhook) {
              await supabase.from("webhook_messages").insert({
                user_id: record.user_id,
                webhook_id: webhook.id,
                clinic_token_id: record.clinic_token_id,
                sender_phone: phoneDigits,
                sender_name: record.contact_name,
                message_text: message,
                direction: "outgoing",
                conversation_id: record.conversation_id,
                action_status: "success",
                ai_intent: didBook ? "widget_followup_thanks" : "widget_followup_nudge",
              });
            }
            sent++;
          } else {
            console.error(`[patient-recovery][widget_link] Send failed: ${sendResult.error}`);
            await supabase.from("pending_follow_ups").update({ status: "failed" }).eq("id", record.id);
          }
          continue;
        }

        // ─────────────────────────────────────────────────────────────
        // BRANCH: inactivity (legacy 24h recovery flow)
        // ─────────────────────────────────────────────────────────────
        // Check if patient has responded or booked since the follow-up was created
        const { data: recentMsgs } = await supabase
          .from("webhook_messages")
          .select("id, ai_intent, action_status, created_at")
          .eq("conversation_id", record.conversation_id)
          .gt("created_at", record.created_at)
          .limit(5);

        if (recentMsgs && recentMsgs.length > 0) {
          // Patient already interacted — skip
          console.log(`[patient-recovery] Patient ${record.phone} already responded, skipping`);
          await supabase
            .from("pending_follow_ups")
            .update({ status: "skipped" })
            .eq("id", record.id);
          skipped++;
          continue;
        }

        // Check if patient already has a successful booking
        const { data: bookings } = await supabase
          .from("webhook_messages")
          .select("id")
          .eq("conversation_id", record.conversation_id)
          .eq("ai_intent", "agendar")
          .eq("action_status", "success")
          .limit(1);

        if (bookings && bookings.length > 0) {
          console.log(`[patient-recovery] Patient ${record.phone} already booked, skipping`);
          await supabase
            .from("pending_follow_ups")
            .update({ status: "skipped" })
            .eq("id", record.id);
          skipped++;
          continue;
        }

        // Get clinic token info for sending
        const { data: clinicToken } = await supabase
          .from("clinic_tokens")
          .select("avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, clinic_name, recovery_enabled")
          .eq("id", record.clinic_token_id)
          .maybeSingle();

        if (!clinicToken || !clinicToken.recovery_enabled) {
          console.log(`[patient-recovery] Clinic ${record.clinic_token_id} recovery disabled or not found, skipping`);
          await supabase
            .from("pending_follow_ups")
            .update({ status: "skipped" })
            .eq("id", record.id);
          skipped++;
          continue;
        }

        if (!clinicToken.avanceai_base_url || !clinicToken.avanceai_api_id || !clinicToken.avanceai_bearer_token) {
          console.log(`[patient-recovery] No WhatsApp credentials for clinic, skipping`);
          await supabase
            .from("pending_follow_ups")
            .update({ status: "skipped" })
            .eq("id", record.id);
          skipped++;
          continue;
        }

        // Generate a delicate follow-up message using AI
        const patientName = record.contact_name?.split(" ")[0] || "";
        const clinicName = clinicToken.clinic_name || "nossa clínica";

        let followUpMessage = "";

        if (lovableApiKey) {
          try {
            const aiRes = await fetch(LLM_GATEWAY, {
              method: "POST",
              headers: llmHeaders(),
              body: JSON.stringify({
                model: LLM_MODEL,
                usage: LLM_USAGE_INCLUDE,
                messages: [
                  {
                    role: "system",
                    content: `Você é uma assistente de clínica médica. Gere uma mensagem curta e delicada de follow-up para um paciente que iniciou uma conversa sobre agendamento mas não finalizou. A mensagem deve:
- Ser gentil e não invasiva
- Perguntar se o paciente ainda gostaria de agendar
- Ser curta (2-3 frases no máximo)
- Usar o primeiro nome do paciente se disponível
- Mencionar o nome da clínica
- NÃO usar emojis em excesso (máximo 1)
- Soar natural, como uma pessoa real escrevendo`,
                  },
                  {
                    role: "user",
                    content: `Gere uma mensagem de follow-up para: ${patientName ? `paciente "${patientName}"` : "um paciente"}, clínica "${clinicName}". A conversa anterior não resultou em agendamento.`,
                  },
                ],
                temperature: 0.8,
                max_tokens: 200,
              }),
            });

            if (aiRes.ok) {
              const aiData = await aiRes.json();
              followUpMessage = aiData.choices?.[0]?.message?.content?.trim() || "";
              logAiUsage(record.clinic_token_id, "patient-recovery", LLM_MODEL, aiData.usage);
            }
          } catch (e) {
            console.log(`[patient-recovery] AI generation failed: ${(e as Error).message}`);
          }
        }

        // Fallback if AI didn't generate
        if (!followUpMessage) {
          followUpMessage = patientName
            ? `Olá ${patientName}! Notamos que você entrou em contato com ${clinicName} mas não chegou a finalizar o agendamento. Caso ainda tenha interesse, estamos à disposição para ajudar! 😊`
            : `Olá! Notamos que você entrou em contato com ${clinicName} mas não chegou a finalizar o agendamento. Caso ainda tenha interesse, estamos à disposição para ajudar! 😊`;
        }

        // Determine channel ID
        const channelId = resolveChannelId(clinicToken.avanceai_active_channel);

        // Send via Z-PRO
        const phone = record.phone.replace(/\D/g, "");
        console.log(`[patient-recovery] Sending follow-up to ${phone}`);

        const sendResult = await sendWhatsApp(
          clinicToken.avanceai_base_url,
          clinicToken.avanceai_api_id,
          clinicToken.avanceai_bearer_token,
          channelId,
          phone,
          followUpMessage,
        );

        if (sendResult.ok) {
          console.log(`[patient-recovery] Follow-up sent to ${phone}`);
          await supabase
            .from("pending_follow_ups")
            .update({ status: "sent" })
            .eq("id", record.id);

          // Save the follow-up message to webhook_messages for history
          const { data: webhook } = await supabase
            .from("user_webhooks")
            .select("id")
            .eq("user_id", record.user_id)
            .eq("clinic_token_id", record.clinic_token_id)
            .maybeSingle();

          if (webhook) {
            await supabase
              .from("webhook_messages")
              .insert({
                user_id: record.user_id,
                webhook_id: webhook.id,
                clinic_token_id: record.clinic_token_id,
                sender_phone: phone,
                sender_name: record.contact_name,
                message_text: followUpMessage,
                direction: "outgoing",
                conversation_id: record.conversation_id,
                action_status: "success",
              });
          }

          sent++;
        } else {
          console.error(`[patient-recovery] Failed to send to ${phone}: ${sendResult.error}`);
          await supabase
            .from("pending_follow_ups")
            .update({ status: "failed" })
            .eq("id", record.id);
        }
      } catch (e) {
        console.error(`[patient-recovery] Error processing record ${record.id}:`, e);
        await supabase
          .from("pending_follow_ups")
          .update({ status: "failed" })
          .eq("id", record.id);
      }
    }

    return new Response(
      JSON.stringify({ sent, skipped, total: pending.length }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[patient-recovery] Unhandled error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
