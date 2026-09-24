import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { chamadaDeCronAutorizada } from "../_shared/cron.ts";
import { canalVivo, enviarTexto, situacaoDoTicket } from "../_shared/zpro.ts";
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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// ─────────────────────────────────────────────────────────────────────────────
// O LEMBRETE NUNCA TINHA SAÍDO (medido em 23/09)
// ─────────────────────────────────────────────────────────────────────────────
// Zero linhas com status 'sent' desde que a tabela existe. Quem sobrevivia a
// "paciente respondeu" e "marcou pelo site" morria na conferência do ticket como
// `human_active_unknown` (52 em 60 dias): ela chamava o showticket com as
// credenciais PLANAS da clinic_tokens — canal 143, desligado — e, mesmo quando
// respondia, lia `status` na raiz, e o Z-PRO devolve {success, data:{status}}.
// O envio também ia pelas credenciais planas, sem channelId. Agora canal, ticket
// e envio saem de _shared/zpro.ts, o mesmo módulo da Recuperação.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth: aceita x-cron-secret (preferencial) OU apikey/Authorization (gateway já validou).
  // Função é idempotente e não aceita parâmetros do caller, então o gate de apikey é suficiente.
  // Só o pg_cron (x-cron-secret) ou a chave de SERVIÇO entram — ver _shared/cron.ts.
  if (!chamadaDeCronAutorizada(req, Deno.env.get("CRON_SECRET"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))) {
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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // FOLLOW-UP VENCIDO DEMAIS NUNCA É ENVIADO (06/08). O sistema legado deixou 40
  // registros parados em 'pending' desde abril porque a consulta não tinha teto de
  // atraso — e o cron os relia a cada 5 minutos. Aqui vale a mesma regra: o
  // empurrãozinho do link é coisa de minutos; passadas ~16h ele não faz sentido e
  // expira, em vez de virar uma mensagem fora de hora meses depois.
  // O teto tem de ser MAIOR que a janela de silêncio (20h→7h = 11h), senão o
  // follow-up que vence às 20:05 e só é adiado até as 7h seria expirado no
  // caminho — o adiamento viraria descarte. 16h dá folga para a janela inteira
  // mais um atraso de cron, e ainda barra qualquer coisa do dia anterior.
  const FOLLOWUP_MAX_ATRASO_H = 16;
  const _limiteAtraso = new Date(Date.now() - FOLLOWUP_MAX_ATRASO_H * 3600_000).toISOString();
  const { data: _expirados } = await supabase
    .from("pending_followups")
    .update({ status: "expired" })
    .eq("status", "pending")
    .lt("scheduled_at", _limiteAtraso)
    .select("id");
  if (_expirados && _expirados.length > 0) {
    console.log(
      `[FollowUp] ${_expirados.length} follow-up(s) com mais de ${FOLLOWUP_MAX_ATRASO_H}h de atraso expirados sem envio`,
    );
  }

  // 1. Buscar follow-ups pendentes vencidos
  const { data: due, error: dueErr } = await supabase
    .from("pending_followups")
    .select(`
      id, phone, conversation_id, clinic_token_id, type, scheduled_at, metadata, created_at,
      clinic_tokens:clinic_token_id (
        avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, user_id
      )
    `)
    .eq("status", "pending")
    .eq("type", "widget_link")
    .lte("scheduled_at", new Date().toISOString())
    .gte("scheduled_at", _limiteAtraso)
    .limit(20);

  if (dueErr) {
    console.error("[FollowUp] Query error:", dueErr);
    return new Response(JSON.stringify({ error: dueErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!due || due.length === 0) {
    return new Response(JSON.stringify({ processed: 0, sent: 0, skipped: 0, errors: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let sent = 0,
    skipped = 0,
    errors = 0;

  for (const fu of due as any[]) {
    try {
      const cleanPhone = String(fu.phone).replace(/\D/g, "");
      const phoneVariants = Array.from(new Set([
        cleanPhone,
        cleanPhone.length === 10 ? "55" + cleanPhone : cleanPhone,
        cleanPhone.startsWith("55") ? cleanPhone.slice(2) : cleanPhone,
      ]));
      const linkSentAt = (fu.metadata?.link_sent_at as string) || fu.created_at;

      // === GUARD 1: paciente já agendou pelo widget? ===
      const { data: bookedViaWidget } = await supabase
        .from("webhook_messages")
        .select("id")
        .in("sender_phone", phoneVariants)
        .eq("booking_source", "widget")
        .gte("created_at", linkSentAt)
        .limit(1)
        .maybeSingle();

      if (bookedViaWidget) {
        await supabase
          .from("pending_followups")
          .update({
            status: "cancelled",
            cancelled_reason: "patient_booked_via_widget",
            processed_at: new Date().toISOString(),
          })
          .eq("id", fu.id);
        console.log(`[FollowUp] ${fu.id}: cancelled (patient_booked_via_widget)`);
        skipped++;
        continue;
      }

      // === GUARD 2: paciente respondeu? ===
      const { data: pacienteRespondeu } = await supabase
        .from("webhook_messages")
        .select("id")
        .in("sender_phone", phoneVariants)
        .eq("direction", "incoming")
        .gte("created_at", linkSentAt)
        .limit(1)
        .maybeSingle();

      if (pacienteRespondeu) {
        await supabase
          .from("pending_followups")
          .update({
            status: "cancelled",
            cancelled_reason: "patient_replied",
            processed_at: new Date().toISOString(),
          })
          .eq("id", fu.id);
        console.log(`[FollowUp] ${fu.id}: cancelled (patient_replied)`);
        skipped++;
        continue;
      }

      // === GUARD 3: atendente no caso? (23/09) ===
      // Canal vivo, resposta do showticket lida em `data`, e "sem ticket" é livre.
      const creds = fu.clinic_tokens;
      const canal = canalVivo(fu.clinic_tokens);
      if (!canal) {
        await supabase
          .from("pending_followups")
          .update({
            status: "skipped",
            cancelled_reason: "sem_canal_unico",
            processed_at: new Date().toISOString(),
          })
          .eq("id", fu.id);
        console.log(`[FollowUp] ${fu.id}: skipped (sem canal único ligado)`);
        skipped++;
        continue;
      }

      // atendente respondeu depois do link? então a conversa é dela
      if (fu.conversation_id) {
        const { data: falouGente } = await supabase
          .from("webhook_messages")
          .select("id")
          .eq("conversation_id", fu.conversation_id)
          .eq("direction", "outgoing")
          .eq("ai_intent", "manual_reply")
          .gte("created_at", linkSentAt)
          .limit(1)
          .maybeSingle();
        if (falouGente) {
          await supabase
            .from("pending_followups")
            .update({
              status: "cancelled",
              cancelled_reason: "human_replied",
              processed_at: new Date().toISOString(),
            })
            .eq("id", fu.id);
          console.log(`[FollowUp] ${fu.id}: cancelled (human_replied)`);
          skipped++;
          continue;
        }
      }

      const situacao = await situacaoDoTicket(canal, fu.phone);
      if (situacao !== "livre") {
        await supabase
          .from("pending_followups")
          .update({
            status: "skipped",
            cancelled_reason: `human_active_${situacao === "atendente" ? "open" : "unknown"}`,
            processed_at: new Date().toISOString(),
          })
          .eq("id", fu.id);
        console.log(`[FollowUp] ${fu.id}: skipped (ticket=${situacao})`);
        skipped++;
        continue;
      }

      // === Buscar nome do paciente ===
      const { data: lastConv } = await supabase
        .from("chat_conversations")
        .select("contact_name")
        .in("phone", phoneVariants)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      // NOME DE VERDADE OU NENHUM (regra do dono, 11/08): `contact_name` é o
      // pushName do WhatsApp — auto-declarado e não confiável (apelido, nome de
      // loja, ou o dono do aparelho quando quem escreve é outra pessoa da casa).
      // O webhook já proíbe usá-lo para tratar o paciente; aqui estava escapando.
      const greeting = "Oi!";

      const msg =
        `${greeting} Tudo bem?\n\n` +
        `Vi que mandei o link de agendamento mais cedo — conseguiu marcar por lá?\n\n` +
        `Se preferir, posso te ajudar a agendar por aqui mesmo: é só me dizer qual ` +
        `médico você procura ou o que está sentindo, que eu busco os horários disponíveis ` +
        `pra você. 😊`;

      const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
      const envio = await enviarTexto(canal, fullPhone, msg);

      if (envio.ok) {
        await supabase.from("webhook_messages").insert({
          clinic_token_id: fu.clinic_token_id,
          user_id: creds.user_id || null,
          sender_phone: fu.phone,
          sender_name: patientName || null,
          message_text: msg,
          direction: "outgoing",
          ai_intent: "widget_followup",
          action_status: "success",
          conversation_id: fu.conversation_id,
        });

        await supabase
          .from("pending_followups")
          .update({ status: "sent", processed_at: new Date().toISOString() })
          .eq("id", fu.id);
        sent++;
        console.log(`[FollowUp] ${fu.id}: sent to ${fullPhone}`);
      } else {
        console.log(`[FollowUp] ${fu.id}: AvanceAI ${envio.detalhe}`);
        errors++;
      }
    } catch (err) {
      console.error(`[FollowUp] Error processing ${fu.id}:`, (err as Error).message);
      errors++;
    }
  }

  return new Response(
    JSON.stringify({ processed: due.length, sent, skipped, errors }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
