// Transferência manual de ticket a partir do painel Mensagens (04/07).
// Recebe { conversation_id, attendant_id, attendant_name }, valida que a
// conversa pertence ao usuário logado, localiza o ticket no AvanceAI
// (showticket) e o atribui ao atendente via updateticketinfo — desligando os
// bots do Z-PRO no ticket, como o transferTicketToHuman do webhook faz.
// A regra "não transferir para atendente offline" é aplicada na UI (lista da
// list-attendants); aqui aceitamos o id que vier para não bloquear exceções
// deliberadas da equipe (ex: atribuir para alguém que está chegando).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Channel = { apiId: string; baseUrl: string; bearerToken: string; id?: string };

function parseChannels(raw: unknown, clinic: Record<string, unknown>): Channel[] {
  // Mesmo formato usado pelo refresh-ticket-status: avanceai_active_channel
  // pode ser JSON de canais; fallback = credenciais planas da clínica.
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .filter((c: Record<string, unknown>) => c && c.apiId && c.baseUrl)
        .map((c: Record<string, unknown>) => ({
          apiId: String(c.apiId),
          baseUrl: String(c.baseUrl),
          bearerToken: String(c.bearerToken || clinic.avanceai_bearer_token || ""),
          id: c.id != null ? String(c.id) : undefined,
        }));
    }
  } catch { /* fallback abaixo */ }
  if (clinic.avanceai_base_url && clinic.avanceai_api_id) {
    return [{
      apiId: String(clinic.avanceai_api_id),
      baseUrl: String(clinic.avanceai_base_url),
      bearerToken: String(clinic.avanceai_bearer_token || ""),
    }];
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "missing_auth" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "invalid_auth" }, 401);

    const body = await req.json().catch(() => ({}));
    const conversationId = String(body?.conversation_id || "");
    const attendantId = Number(body?.attendant_id || 0);
    const attendantName = String(body?.attendant_name || "").slice(0, 80);
    if (!conversationId || !attendantId) return json({ error: "missing_params" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: conv } = await admin
      .from("chat_conversations")
      .select("id, phone, clinic_token_id, user_id")
      .eq("id", conversationId)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!conv) return json({ error: "conversation_not_found" }, 404);

    const { data: clinic } = await admin
      .from("clinic_tokens")
      .select("id, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel")
      .eq("id", conv.clinic_token_id)
      .maybeSingle();
    if (!clinic) return json({ error: "clinic_not_found" }, 404);

    const channels = parseChannels(clinic.avanceai_active_channel, clinic as Record<string, unknown>);
    if (channels.length === 0) return json({ error: "no_avanceai_config" }, 400);

    const cleanPhone = String(conv.phone || "").replace(/\D/g, "");
    const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;

    let lastDetail = "";
    for (const ch of channels) {
      try {
        // 1) localizar o ticket
        const showRes = await fetch(`${ch.baseUrl}/v2/api/external/${ch.apiId}/showticket`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ch.bearerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            number: fullPhone,
            ...(ch.id ? { channelId: Number(ch.id), whatsappId: Number(ch.id) } : {}),
          }),
        });
        if (!showRes.ok) {
          lastDetail = `showticket ${showRes.status}`;
          continue;
        }
        const ticket = await showRes.json();
        const ticketId = ticket?.id;
        if (!ticketId) {
          lastDetail = "ticket sem id";
          continue;
        }
        // 2) atribuir ao atendente e desligar bots
        const updRes = await fetch(`${ch.baseUrl}/v2/api/external/${ch.apiId}/updateticketinfo`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ch.bearerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            ticketId: Number(ticketId),
            status: "open",
            userId: attendantId,
            chatgptStatus: false,
            n8nStatus: false,
            typebotStatus: false,
            dialogflowStatus: false,
            difyStatus: false,
            ...(ch.id ? { channelId: Number(ch.id), whatsappId: Number(ch.id) } : {}),
          }),
        });
        const updBody = await updRes.text();
        console.log(`[transfer-ticket] conv=${conversationId} ticket=${ticketId} -> user=${attendantId} status=${updRes.status} ${updBody.substring(0, 200)}`);
        if (updRes.ok) {
          // 3) refletir imediatamente no painel (realtime atualiza a lista)
          await admin
            .from("chat_conversations")
            .update({
              ticket_status: "open",
              assigned_agent_name: attendantName || null,
              ticket_status_refreshed_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
          // AUDITORIA (política 21/07): transferência manual do painel vira linha
          // na transfer_audit — a aba Transferências mostra quem iniciou e por quê.
          try {
            await admin.from("transfer_audit").insert({
              clinic_token_id: conv.clinic_token_id,
              conversation_id: conversationId,
              phone: String(conv.phone || "").replace(/\D/g, "") || null,
              to_attendant: attendantName || String(attendantId),
              initiated_by: "painel",
              trigger: "manual_painel",
              reason: "transferencia_manual_dashboard",
            });
          } catch (_e) { /* non-blocking */ }
          return json({ ok: true, ticket_id: ticketId, attendant: attendantName });
        }
        lastDetail = `updateticketinfo ${updRes.status}: ${updBody.substring(0, 150)}`;
      } catch (e) {
        lastDetail = (e as Error).message;
      }
    }
    return json({ error: "transfer_failed", detail: lastDetail }, 502);
  } catch (e) {
    console.error(`[transfer-ticket] erro: ${(e as Error).message}`);
    return json({ error: "internal", detail: (e as Error).message }, 500);
  }
});
