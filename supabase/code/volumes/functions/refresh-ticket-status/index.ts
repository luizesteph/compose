import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ShowTicketResponse {
  status?: string;
  userId?: number | string | null;
  user?: { id?: number | string | null; name?: string | null } | null;
}

interface Channel {
  id?: string | number;
  name?: string;
  baseUrl?: string;
  apiId?: string;
  bearerToken?: string;
  enabled?: boolean;
}

function parseChannels(raw: any, clinic: any): Channel[] {
  // avanceai_active_channel can be: JSON array string, plain channel id string, or null
  if (!raw) {
    // Fallback to clinic-level credentials
    if (clinic?.avanceai_base_url && clinic?.avanceai_api_id && clinic?.avanceai_bearer_token) {
      return [{
        baseUrl: clinic.avanceai_base_url,
        apiId: clinic.avanceai_api_id,
        bearerToken: clinic.avanceai_bearer_token,
        enabled: true,
      }];
    }
    return [];
  }

  let parsed: any = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    } else {
      // Plain id string — fallback to clinic-level creds + that channel id
      if (clinic?.avanceai_base_url && clinic?.avanceai_api_id && clinic?.avanceai_bearer_token) {
        return [{
          id: trimmed,
          baseUrl: clinic.avanceai_base_url,
          apiId: clinic.avanceai_api_id,
          bearerToken: clinic.avanceai_bearer_token,
          enabled: true,
        }];
      }
      return [];
    }
  }

  const arr: Channel[] = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const enabled = arr.filter((c) => c && c.enabled !== false && c.apiId && c.bearerToken);
  return enabled.length > 0 ? enabled : arr.filter((c) => c && c.apiId && c.bearerToken);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const cronSecret = req.headers.get("x-cron-secret");
    const isCronAuth = cronSecret && cronSecret === Deno.env.get("CRON_SECRET");

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token && !isCronAuth) {
      return new Response(JSON.stringify({ error: "missing_auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // FIX (04/07): o caminho de CRON morria aqui — getUser() rodava mesmo com
    // CRON_SECRET valido e retornava invalid_auth. O cron nunca sincronizou.
    let userId: string | null = null;
    if (!isCronAuth) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: "invalid_auth" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = userData.user.id;
    }

    const body = await req.json().catch(() => ({}));
    const conversationIds: string[] = Array.isArray(body?.conversation_ids)
      ? body.conversation_ids.slice(0, 30)
      : [];
    if (conversationIds.length === 0 && !isCronAuth) {
      return new Response(JSON.stringify({ error: "no_ids" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    let convsQuery = admin
      .from("chat_conversations")
      .select("id, phone, clinic_token_id, user_id, ticket_status, assigned_agent_name");
    if (conversationIds.length > 0) {
      convsQuery = convsQuery.in("id", conversationIds);
      if (userId) convsQuery = convsQuery.eq("user_id", userId);
    } else {
      // Cron sem ids: pega as 40 conversas com status mais desatualizado,
      // priorizando as com mensagem recente (as que a equipe esta olhando).
      convsQuery = convsQuery
        .gte("last_message_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
        .order("ticket_status_refreshed_at", { ascending: true, nullsFirst: true })
        .limit(40);
    }
    const { data: convs } = await convsQuery;

    if (!convs || convs.length === 0) {
      return new Response(JSON.stringify({ refreshed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clinicIds = Array.from(
      new Set(convs.map((c: any) => c.clinic_token_id).filter(Boolean)),
    );
    const { data: clinics } = await admin
      .from("clinic_tokens")
      .select(
        "id, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel",
      )
      .in("id", clinicIds);

    const clinicChannels = new Map<string, Channel[]>();
    (clinics || []).forEach((c: any) => {
      clinicChannels.set(c.id, parseChannels(c.avanceai_active_channel, c));
    });

    let refreshed = 0;
    let unchanged = 0;
    let errors = 0;

    // Per-request cache: `${apiId}:${userId}` -> human name
    const userNameCache = new Map<string, string>();
    const listedChannels = new Set<string>();

    async function callShowTicket(channel: Channel, fullPhone: string) {
      const baseUrl = channel.baseUrl || "https://wpp.avanceai.com.br";
      const showUrl = `${baseUrl}/v2/api/external/${channel.apiId}/showticket`;
      const payload: Record<string, unknown> = { number: fullPhone };
      if (channel.id) {
        const chId = Number(channel.id);
        if (Number.isFinite(chId) && chId > 0) {
          payload.channelId = chId;
          payload.whatsappId = chId;
        }
      }
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 7000);
      try {
        const res = await fetch(showUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${channel.bearerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        return res;
      } catch (e) {
        clearTimeout(tid);
        throw e;
      }
    }

    // Resolve userId -> human name via /listUsers (cached per request, one call per channel)
    async function resolveUserName(channel: Channel, uid: number | string): Promise<string | null> {
      const key = `${channel.apiId}:${String(uid)}`;
      if (userNameCache.has(key)) return userNameCache.get(key) || null;
      if (!listedChannels.has(channel.apiId!)) {
        listedChannels.add(channel.apiId!);
        try {
          const baseUrl = channel.baseUrl || "https://wpp.avanceai.com.br";
          const url = `${baseUrl}/v2/api/external/${channel.apiId}/listUsers?pageNumber=1`;
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 6000);
          const res = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${channel.bearerToken}` },
            signal: ctrl.signal,
          });
          clearTimeout(tid);
          if (res.ok) {
            const data: any = await res.json();
            const users: any[] = Array.isArray(data) ? data : (data?.users || data?.data || []);
            for (const u of users) {
              const id = u?.id ?? u?.userId;
              const nm = String(u?.name || "").trim();
              if (id != null && nm) userNameCache.set(`${channel.apiId}:${String(id)}`, nm);
            }
          } else {
            console.log(`[refresh-ticket-status] listUsers ch=${channel.id} status=${res.status}`);
          }
        } catch (e) {
          console.log(`[refresh-ticket-status] listUsers err ch=${channel.id}: ${(e as any)?.message}`);
        }
      }
      return userNameCache.get(key) || null;
    }

    async function processOne(conv: any) {
      const channels = clinicChannels.get(conv.clinic_token_id) || [];
      if (channels.length === 0) return;

      const cleanPhone = String(conv.phone || "").replace(/\D/g, "");
      if (!cleanPhone) return;
      const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;

      let nextStatus: string | null = null;
      let nextAgent: string | null = null;
      let foundOpen = false;
      let any404 = false;
      let anyOk = false;

      // Try each enabled channel; first one with a real assigned ticket wins.
      for (const channel of channels) {
        try {
          const res = await callShowTicket(channel, fullPhone);
          if (res.status === 404) {
            any404 = true;
            continue;
          }
          if (!res.ok) {
            continue;
          }
          anyOk = true;
          const data = (await res.json()) as ShowTicketResponse;
          const status = String(data?.status || "").toLowerCase();
          const realUserId = data?.userId ?? data?.user?.id ?? null;
          let userName = String(data?.user?.name || "").trim();

          // If assigned but name missing, resolve via /listUsers (cached)
          if (status === "open" && realUserId && Number(realUserId) > 0 && !userName) {
            const resolved = await resolveUserName(channel, realUserId);
            if (resolved) userName = resolved;
          }

          if (status === "open" && realUserId && Number(realUserId) > 0 && userName) {
            nextStatus = "open";
            nextAgent = userName;
            foundOpen = true;
            break; // best match — stop searching channels
          } else if (status === "open") {
            // Open but no resolvable agent — keep status as open, agent null
            if (!nextStatus) {
              nextStatus = "open";
              nextAgent = null;
            }
          } else if (status === "pending") {
            if (!nextStatus) {
              nextStatus = "pending";
              nextAgent = null;
            }
          } else if (status === "closed" || status === "resolved") {
            if (!nextStatus) {
              nextStatus = status === "resolved" ? "resolved" : "closed";
              nextAgent = null;
            }
          }
        } catch (e) {
          errors++;
          console.log(
            `[refresh-ticket-status] channel error conv=${conv.id} ch=${channel.id}: ${(e as any)?.message}`,
          );
        }
      }

      // If nothing usable came back but every channel returned 404 -> treat as closed
      if (!nextStatus && !anyOk && any404) {
        nextStatus = "closed";
        nextAgent = null;
      }

      if (nextStatus === null) return;

      // Estado identico: carimba so o refreshed_at (UI mostra "atualizado ha X"
      // e o cron ordena pelos mais antigos). Estado novo: atualiza tudo.
      if (
        (conv.ticket_status || null) === nextStatus &&
        (conv.assigned_agent_name || null) === nextAgent
      ) {
        unchanged++;
        await admin
          .from("chat_conversations")
          .update({ ticket_status_refreshed_at: new Date().toISOString() })
          .eq("id", conv.id);
        return;
      }

      const { error: updErr } = await admin
        .from("chat_conversations")
        .update({
          ticket_status: nextStatus,
          assigned_agent_name: nextAgent,
          ticket_status_refreshed_at: new Date().toISOString(),
        })
        .eq("id", conv.id);

      if (updErr) {
        console.log(`[refresh-ticket-status] update err conv=${conv.id}: ${updErr.message}`);
        return;
      }
      // AUDITORIA (política 21/07): troca de atendente feita DIRETO no Z-PRO
      // (invisível pros nossos fluxos) é observada aqui quando o agente muda de
      // um nome para OUTRO nome — vira linha 'zpro_observado' na transfer_audit.
      const prevAgent = conv.assigned_agent_name || null;
      if (prevAgent && nextAgent && prevAgent !== nextAgent) {
        try {
          await admin.from("transfer_audit").insert({
            clinic_token_id: conv.clinic_token_id,
            conversation_id: conv.id,
            phone: String(conv.phone || "").replace(/\D/g, "") || null,
            from_attendant: prevAgent,
            to_attendant: nextAgent,
            initiated_by: "zpro_observado",
            trigger: "troca_observada",
            reason: "assigned_agent_mudou_no_zpro",
          });
        } catch (_e) { /* non-blocking */ }
      }
      refreshed++;
      console.log(
        `[refresh-ticket-status] ${conv.id} (${conv.phone}) -> ${nextStatus}${nextAgent ? ` / ${nextAgent}` : ""}${foundOpen ? " [matched]" : ""}`,
      );
    }

    // Concurrency-limited worker pool
    const CONCURRENCY = 5;
    const queue = [...convs];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const c = queue.shift();
            if (!c) break;
            await processOne(c);
          }
        })(),
      );
    }
    await Promise.all(workers);

    return new Response(
      JSON.stringify({ refreshed, unchanged, errors, total: convs.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[refresh-ticket-status] fatal:", e);
    return new Response(
      JSON.stringify({ error: (e as any)?.message || "internal_error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
