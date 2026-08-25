// AvanceAI Webhook - Gateway that validates token, parses Z-PRO payload,
// then forwards to whatsapp-webhook for full AI processing pipeline.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Quick pre-filter: returns true if this payload should be skipped (not a user text message)
function shouldSkipPayload(payload: Record<string, unknown>): { skip: boolean; reason: string } {
  const method = payload.method as string | undefined;

  // Z-PRO "method" format
  if (method === "message" && payload.msg && typeof payload.msg === "object") {
    const msg = payload.msg as Record<string, unknown>;
    // BUG-FIX: do NOT skip fromMe — downstream whatsapp-webhook captures
    // human-attendant outbound messages (Vânia, Lidiane etc.) with dedup
    // against our own UI/AI outbound. Skipping here loses agent replies.
    const rawFrom = (msg.chatid as string) || (msg.from as string) || "";
    if (rawFrom.includes("@g.us")) return { skip: true, reason: "zpro-group" };
    if (rawFrom.includes("@broadcast")) return { skip: true, reason: "zpro-broadcast" };
    // Has phone + (text OR mediaUrl) → don't skip
    const phone = rawFrom.replace(/@.*$/, "").replace(/\D/g, "");
    // Handle content being an object (Z-PRO media with URL inside)
    const contentIsMedia = msg.content && typeof msg.content === "object" && (msg.content as any).URL;
    const text = contentIsMedia ? "" : ((msg.text as string) || (typeof msg.content === "string" ? (msg.content as string) : "") || (msg.body as string) || "");
    const mediaUrl = contentIsMedia ? (msg.content as any).URL : ((msg.mediaUrl as string) || (msg.fileUrl as string) || (msg.media as string) || "");
    if (!phone || (!text && !mediaUrl)) return { skip: true, reason: "zpro-no-phone-or-text" };
    return { skip: false, reason: mediaUrl && !text ? "zpro-audio" : "zpro-method" };
  }

  // Z-PRO outbound wrappers used when an attendant replies via Z-PRO UI:
  //   - method === "message_send_uazapi"
  //   - other "message_send*" variants
  // We try to forward them if they carry a phone + text/caption, so the
  // human-attendant reply gets persisted by whatsapp-webhook.
  if (method && (method === "message_send_uazapi" || method.startsWith("message_send"))) {
    // Phone may live in many places depending on Z-PRO build
    const ticket = (payload.ticket as Record<string, unknown> | undefined) || undefined;
    const msgObj = (payload.msg as Record<string, unknown> | undefined) || undefined;
    const rawTo =
      ((msgObj?.chatid as string) ||
        (msgObj?.chatId as string) ||
        (msgObj?.to as string) ||
        (msgObj?.remoteJid as string) ||
        (payload.to as string) ||
        (payload.chatid as string) ||
        (payload.remoteJid as string) ||
        ((ticket?.contact as Record<string, unknown> | undefined)?.number as string) ||
        ((ticket?.contact as Record<string, unknown> | undefined)?.phone as string) ||
        "") as string;
    if (rawTo.includes("@g.us")) return { skip: true, reason: `zpro-${method}-group` };
    if (rawTo.includes("@broadcast")) return { skip: true, reason: `zpro-${method}-broadcast` };
    const phone = rawTo.replace(/@.*$/, "").replace(/\D/g, "");
    // Try to find some text/caption
    const candidates: any[] = [
      msgObj?.text, msgObj?.content, msgObj?.body, msgObj?.caption, msgObj?.message,
      (msgObj?.extendedTextMessage as any)?.text, (msgObj?.conversation as any),
      payload.text, payload.body, payload.caption, payload.message,
    ];
    let txt = "";
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) { txt = c; break; }
      if (c && typeof c === "object") {
        const inner = (c as any).body || (c as any).text || (c as any).message;
        if (typeof inner === "string" && inner.trim()) { txt = inner; break; }
      }
    }
    if (!phone || !txt) return { skip: true, reason: `zpro-${method}-no-phone-or-text` };
    return { skip: false, reason: `zpro-${method}-outbound` };
  }

  // Other Z-PRO non-message methods (contact, chat, ticket, etc.)
  if (method && method !== "message") return { skip: true, reason: `zpro-method-${method}` };

  // Uazapi EventType
  const eventType = payload.EventType as string | undefined;
  if (eventType && eventType !== "messages") return { skip: true, reason: `uazapi-event-${eventType}` };

  // BUG-FIX: do NOT skip generic fromMe either — same reasoning as above.


  // Fall through — let whatsapp-webhook handle the full parsing
  return { skip: false, reason: "passthrough" };
}

const GATEWAY_VERSION = "v2026-04-16-cta-sync";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  console.log(`[AvanceAI-GW] 🟢 Request received — version=${GATEWAY_VERSION}`);

  try {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    if (!token) {
      console.log("[AvanceAI-GW] No token in query string");
      return jsonResponse({ error: "Token is required" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Validate token → clinic
    // First try clinic-level apiId match
    let clinic: { id: string; user_id: string; avanceai_enabled: boolean; avanceai_active_channel: string | null } | null = null;
    let channelCreds: { baseUrl: string; apiId: string; bearerToken: string } | null = null;

    const { data: clinicByApiId, error: clinicError } = await supabase
      .from("clinic_tokens")
      .select("id, user_id, avanceai_enabled, avanceai_active_channel")
      .eq("avanceai_api_id", token)
      .eq("avanceai_enabled", true)
      .maybeSingle();

    if (clinicError) {
      console.error("[AvanceAI-GW] DB error:", clinicError.message);
      return jsonResponse({ error: "DB error" }, 500);
    }

    if (clinicByApiId) {
      clinic = clinicByApiId;
      console.log(`[AvanceAI-GW] Token matched clinic-level apiId → clinic=${clinic.id}`);
    } else {
      // Search inside avanceai_active_channel JSON for per-channel apiId
      const { data: clinicsByChannel, error: chError } = await supabase
        .from("clinic_tokens")
        .select("id, user_id, avanceai_enabled, avanceai_active_channel")
        .eq("avanceai_enabled", true)
        .ilike("avanceai_active_channel", `%"apiId":"${token}"%`);

      if (chError) {
        console.error("[AvanceAI-GW] DB error searching channels:", chError.message);
        return jsonResponse({ error: "DB error" }, 500);
      }

      // Validate in memory — skip entries with empty apiId or disabled, use last match (most recent)
      for (const candidate of (clinicsByChannel || [])) {
        try {
          const channels = JSON.parse(candidate.avanceai_active_channel || "[]");
          if (Array.isArray(channels)) {
            // Iterate backward to find the most recent valid entry
            for (let i = channels.length - 1; i >= 0; i--) {
              const ch = channels[i];
              if (ch && ch.apiId && ch.apiId === token && ch.enabled !== false) {
                clinic = candidate;
                channelCreds = { baseUrl: ch.baseUrl, apiId: ch.apiId, bearerToken: ch.bearerToken };
                console.log(`[AvanceAI-GW] Token matched channel ${ch.id} in clinic=${clinic!.id}`);
                break;
              }
            }
            if (clinic) break;
          }
        } catch { /* ignore parse errors */ }
      }
    }

    if (!clinic) {
      console.log("[AvanceAI-GW] Invalid/inactive token:", token);
      return jsonResponse({ error: "Invalid token" }, 403);
    }

    console.log(`[AvanceAI-GW] Token OK → clinic=${clinic.id}, user=${clinic.user_id}`);

    // 2. Read raw payload
    const rawPayload = await req.json();
    console.log(`[AvanceAI-GW] Payload keys: ${Object.keys(rawPayload).join(", ")}`);

    // 2b. SYNC DE STATUS EM TEMPO REAL (04/07): todo evento Z-PRO carrega
    // ticket.status — gravar AQUI (antes do skip) torna o badge da pagina
    // Mensagens tempo-real, inclusive fechamento/transferencia de ticket, que
    // chegam como eventos SEM mensagem e eram 100% descartados no pre-filtro.
    try {
      const t = rawPayload.ticket as Record<string, unknown> | undefined;
      const tStatus = String(t?.status || "").toLowerCase();
      if (t && ["open", "pending", "closed", "resolved"].includes(tStatus)) {
        const contact = (t.contact as Record<string, unknown> | undefined) || {};
        const rawNum = String(contact.number || contact.phone || "").replace(/\D/g, "");
        if (rawNum.length >= 10) {
          const agentName = String((t.user as Record<string, unknown> | undefined)?.name || "").trim() || null;
          const upd: Record<string, unknown> = {
            ticket_status: tStatus,
            ticket_status_refreshed_at: new Date().toISOString(),
          };
          if (tStatus === "open" && agentName) upd.assigned_agent_name = agentName;
          if (tStatus === "pending" || tStatus === "closed" || tStatus === "resolved") upd.assigned_agent_name = null;
          const variants = rawNum.startsWith("55") ? [rawNum, rawNum.slice(2)] : [rawNum, `55${rawNum}`];
          await supabase
            .from("chat_conversations")
            .update(upd)
            .eq("clinic_token_id", clinic.id)
            .in("phone", variants);
          console.log(`[AvanceAI-GW] ticket-status sync: ${rawNum} -> ${tStatus}${agentName ? ` (${agentName})` : ""}`);
        }
      }
    } catch (e) {
      console.log(`[AvanceAI-GW] ticket-status sync error (non-blocking): ${(e as Error).message}`);
    }

    // 3. Pre-filter (skip non-message events quickly)
    const { skip, reason } = shouldSkipPayload(rawPayload);
    if (skip) {
      console.log(`[AvanceAI-GW] Skip: ${reason}`);
      return jsonResponse({ success: true, skipped: true, reason });
    }
    console.log(`[AvanceAI-GW] Pre-filter passed: ${reason}`);

    // 3b. Channel filter: only process messages from enabled channels.
    // Extract channelId from many possible payload locations (Z-PRO variants).
    let incomingChannelId: string | null = null;
    {
      const msg = (rawPayload.msg as Record<string, unknown> | undefined) || undefined;
      const ticket = (rawPayload.ticket as Record<string, unknown> | undefined) || undefined;
      const candidates: any[] = [
        ticket?.whatsappId,
        ticket?.channelId,
        (ticket?.whatsapp as Record<string, unknown> | undefined)?.id,
        msg?.channelId,
        msg?.whatsappId,
        (rawPayload as any).whatsappId,
        (rawPayload as any).channelId,
      ];
      for (const c of candidates) {
        if (c !== undefined && c !== null && String(c).trim() !== "") {
          incomingChannelId = String(c);
          break;
        }
      }
    }

    // Parse allowed channels from clinic config (only enabled ones)
    let allowedChannels: string[] = [];
    if (clinic.avanceai_active_channel) {
      try {
        const parsed = JSON.parse(clinic.avanceai_active_channel);
        if (Array.isArray(parsed)) {
          allowedChannels = parsed
            .filter((ch: any) => !(ch && typeof ch === "object" && ch.enabled === false))
            .map((ch: any) => {
              const id = (ch && typeof ch === "object" && ch.id != null) ? ch.id : ch;
              return String(id);
            })
            .filter((id: string) => id && id !== "undefined" && id !== "null");
        } else {
          allowedChannels = [String(parsed)];
        }
      } catch {
        allowedChannels = [String(clinic.avanceai_active_channel)];
      }
    }
    console.log(`[AvanceAI-GW] Allowed channels (enabled only): [${allowedChannels.join(",")}], incomingChannelId=${incomingChannelId ?? "<none>"}`);

    if (allowedChannels.length > 0 && incomingChannelId) {
      if (!allowedChannels.includes(String(incomingChannelId))) {
        console.log(`[AvanceAI-GW] Channel ${incomingChannelId} not in allowed list — skipping`);
        return jsonResponse({ success: true, skipped: true, reason: "channel_not_enabled" });
      }
      console.log(`[AvanceAI-GW] Channel ${incomingChannelId} is allowed ✓`);
    } else if (allowedChannels.length > 0 && !incomingChannelId) {
      if (allowedChannels.length === 1) {
        incomingChannelId = allowedChannels[0];
        console.log(`[AvanceAI-GW] No channelId in payload, single enabled channel → auto-using ${incomingChannelId}`);
      } else {
        console.log(`[AvanceAI-GW] No channelId in payload, ${allowedChannels.length} channels enabled — BLOCKING to prevent wrong-channel send`);
        return jsonResponse({ success: true, skipped: true, reason: "ambiguous_channel_multi" });
      }
    }

    // 3c. Forward ticket info to whatsapp-webhook (it handles human-agent logic AFTER transcription)
    const ticket = rawPayload.ticket as Record<string, unknown> | undefined;
    const ticketStatus = (ticket?.status as string) || "";
    const ticketUserId = ticket?.userId ?? null;
    if (ticketStatus || ticketUserId) {
      console.log(`[AvanceAI-GW] Ticket info — status="${ticketStatus}", userId=${ticketUserId} — forwarding (transcription always runs)`);
    }

    // 4. Find active webhook with key for this clinic
    const { data: webhook, error: whError } = await supabase
      .from("user_webhooks")
      .select("id, webhook_key")
      .eq("clinic_token_id", clinic.id)
      .eq("user_id", clinic.user_id)
      .eq("is_active", true)
      .maybeSingle();

    if (whError) {
      console.error("[AvanceAI-GW] DB error finding webhook:", whError.message);
      return jsonResponse({ error: "DB error" }, 500);
    }
    if (!webhook) {
      console.log("[AvanceAI-GW] No active webhook for clinic:", clinic.id);
      return jsonResponse({ success: true, skipped: true, reason: "no_active_webhook" });
    }

    console.log(`[AvanceAI-GW] Forwarding to whatsapp-webhook (key=${webhook.webhook_key.substring(0, 8)}...)`);

    // 5. Forward payload to whatsapp-webhook for full AI pipeline
    // If we found per-channel credentials, pass them as query params so whatsapp-webhook uses them
    const channelParam = incomingChannelId ? `&channelId=${encodeURIComponent(incomingChannelId)}` : "";
    let credsParams = "";
    if (channelCreds) {
      credsParams = `&chBaseUrl=${encodeURIComponent(channelCreds.baseUrl)}&chApiId=${encodeURIComponent(channelCreds.apiId)}&chBearerToken=${encodeURIComponent(channelCreds.bearerToken)}`;
    } else if (incomingChannelId && clinic.avanceai_active_channel) {
      // Try to find channel-specific creds for this channelId — skip empty entries, search backward
      try {
        const channels = JSON.parse(clinic.avanceai_active_channel);
        if (Array.isArray(channels)) {
          for (let i = channels.length - 1; i >= 0; i--) {
            const ch = channels[i];
            if (ch && String(ch.id) === String(incomingChannelId) && ch.apiId && ch.baseUrl && ch.enabled !== false) {
              credsParams = `&chBaseUrl=${encodeURIComponent(ch.baseUrl)}&chApiId=${encodeURIComponent(ch.apiId)}&chBearerToken=${encodeURIComponent(ch.bearerToken)}`;
              console.log(`[AvanceAI-GW] Found per-channel creds for channel ${incomingChannelId} (entry ${i})`);
              break;
            }
          }
        }
      } catch { /* ignore */ }
    }
    const forwardUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-webhook?key=${webhook.webhook_key}${channelParam}${credsParams}`;
    let forwardRes: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout
      forwardRes = await fetch(forwardUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rawPayload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (fetchErr: any) {
      // Forward failed — save fallback message so we don't lose data
      console.error(`[AvanceAI-GW] Forward FAILED: ${fetchErr.message}`);
      await saveFallbackMessage(supabase, clinic, webhook.id, rawPayload, fetchErr.message);
      return jsonResponse({ success: false, reason: "forward_failed", error: fetchErr.message }, 502);
    }

    // 6. Read forward response
    let forwardData: any = {};
    try {
      forwardData = await forwardRes.json();
    } catch { /* ignore parse errors */ }

    if (!forwardRes.ok) {
      console.error(`[AvanceAI-GW] Forward returned ${forwardRes.status}:`, JSON.stringify(forwardData));
      // Save fallback on non-OK
      await saveFallbackMessage(supabase, clinic, webhook.id, rawPayload, `whatsapp-webhook returned ${forwardRes.status}`);
      return jsonResponse({ success: false, reason: "forward_error", status: forwardRes.status, detail: forwardData }, 502);
    }

    console.log(`[AvanceAI-GW] ✅ Forward OK — pipeline result:`, JSON.stringify(forwardData).substring(0, 200));
    return jsonResponse({ success: true, format: reason, pipeline: forwardData });
  } catch (e) {
    console.error("[AvanceAI-GW] Unhandled error:", e);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});

// Fallback: save minimal message when forwarding fails so we don't lose data
async function saveFallbackMessage(
  supabase: any,
  clinic: { id: string; user_id: string },
  webhookId: string,
  rawPayload: Record<string, unknown>,
  errorMsg: string
) {
  try {
    // Extract minimal info for fallback
    let phone = "";
    let name = "";
    let text = "";

    const method = rawPayload.method as string | undefined;
    if (method === "message" && rawPayload.msg && typeof rawPayload.msg === "object") {
      const msg = rawPayload.msg as Record<string, unknown>;
      const rawFrom = (msg.chatid as string) || (msg.from as string) || "";
      phone = rawFrom.replace(/@.*$/, "").replace(/\D/g, "");
      name = (msg.senderName as string) || (msg.pushName as string) || "";
      text = (msg.text as string) || (msg.content as string) || "";
    }

    // Upsert conversation
    let conversationId: string | null = null;
    if (phone) {
      const { data: conv } = await supabase
        .from("chat_conversations")
        .select("id")
        .eq("user_id", clinic.user_id)
        .eq("phone", phone)
        .eq("clinic_token_id", clinic.id)
        .maybeSingle();

      if (conv) {
        conversationId = conv.id;
      } else {
        const { data: newConv } = await supabase
          .from("chat_conversations")
          .insert({
            user_id: clinic.user_id,
            phone,
            contact_name: name || phone,
            last_message: text,
            last_message_at: new Date().toISOString(),
            unread_count: 1,
            clinic_token_id: clinic.id,
          })
          .select("id")
          .single();
        conversationId = newConv?.id || null;
      }
    }

    await supabase.from("webhook_messages").insert({
      user_id: clinic.user_id,
      webhook_id: webhookId,
      clinic_token_id: clinic.id,
      sender_phone: phone || "unknown",
      sender_name: name || phone || "unknown",
      message_text: text || "(payload não parseado)",
      direction: "incoming",
      conversation_id: conversationId,
      raw_payload: rawPayload,
      action_status: "failed",
      action_error: `Forward falhou: ${errorMsg}`,
    });
    console.log("[AvanceAI-GW] Fallback message saved");
  } catch (fallbackErr) {
    console.error("[AvanceAI-GW] Fallback save also failed:", fallbackErr);
  }
}
