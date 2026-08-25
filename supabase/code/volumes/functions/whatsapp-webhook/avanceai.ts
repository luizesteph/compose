// avanceai.ts — Modularizacao M3 (04/07).
// TODA a comunicacao com o AvanceAI/Z-PRO (WhatsApp) vive aqui: envio de
// mensagens (sempre com externalKey+isClosed), indicador "digitando"
// (sendPresence), consulta e transferencia de tickets (updateticketinfo com
// bots desligados) e lista de atendentes online (com filtro de ferias).
// Extraido byte a byte do index.ts — comportamento identico. Sem @ts-nocheck.
import { stripAccents } from "./helpers.ts";

export type AttendantUser = { id: any; name: string; online?: boolean; status?: string; profile?: string; role?: string };

export interface TransferResult {
  ok: boolean;
  httpStatus: number;
  attempt: "number" | "ticketId" | "none" | "already_human_owned";
  ticketId?: string;
  errorDetail?: string;
}

// Nomes que NÃO devem receber pacientes. Aceita duas listas em clinic_info.custom_notes:
//   "Atendentes de Férias: Fulana, Beltrana"   (afastamento longo)
//   "Atendentes Ausentes: Fulana"              (faltou HOJE — caso Lidiane 27/07)
// A segunda existe porque o sinal de online/offline do Z-PRO se mostrou inútil (a
// equipe inteira aparecia disponível 100% do tempo) e a clínica precisa de uma
// alavanca determinística, sob controle humano, para o dia em que alguém falta.
// As duas listas somam; nomes repetidos não atrapalham (é filtro por nome).
export function parseVacationNames(customNotes?: string | null): string[] {
  if (!customNotes) return [];
  const nomes: string[] = [];
  const capturar = (re: RegExp) => {
    const m = customNotes.match(re);
    if (!m) return;
    for (const parte of m[1].split(",")) {
      const limpo = stripAccents(parte.trim().replace(/[*_`.;]/g, "").trim().toLowerCase());
      if (limpo) nomes.push(limpo);
    }
  };
  capturar(/Atendentes\s+de\s+F[eé]rias\s*:\s*([^\n]+)/i);
  capturar(/Atendentes\s+Ausentes(?:\s+Hoje)?\s*:\s*([^\n]+)/i);
  return nomes;
}

function extractTicketIdForTransfer(raw: any): string | null {
  const candidates: any[] = [];

  const collect = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") candidates.push(item);
      }
      return;
    }
    if (typeof value === "object") candidates.push(value);
  };

  collect(raw);
  collect(raw?.ticket);
  collect(raw?.data);
  collect(raw?.tickets);
  collect(raw?.rows);

  const withId = candidates.filter((t) => t && t.id !== undefined && t.id !== null);
  if (withId.length === 0) return null;

  const preferred =
    withId.find((t) => {
      const status = String(t?.status || "").toLowerCase();
      return status === "pending" || status === "open";
    }) || withId[0];

  return preferred?.id !== undefined && preferred?.id !== null ? String(preferred.id) : null;
}

// Presença REAL de um atendente (caso Lidiane 27/07). O listUsers do Z-PRO não traz
// `online` de forma confiável, então a equipe inteira aparecia como disponível o
// tempo todo. Este endpoint é por-atendente e é o que a documentação do projeto já
// recomendava (docs/avanceai-api-reference.md, "Bugs Conhecidos" #3).
//
// Contrato PROPOSITALMENTE de três estados:
//   false → a API afirmou que está offline (única situação que tira alguém do rodízio)
//   true  → a API afirmou que está online
//   null  → não deu para saber (erro, timeout, formato desconhecido) → NADA muda
// Como o formato exato da resposta não pôde ser verificado do sandbox (sem acesso de
// rede à AvanceAI), a leitura aceita as variações usuais e, na dúvida, devolve null.
export async function isAttendantOnline(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  userId: string | number,
): Promise<boolean | null> {
  try {
    if (userId === undefined || userId === null || String(userId) === "") return null;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `${baseUrl}/v2/api/external/${apiId}/getUserStatus?userId=${encodeURIComponent(String(userId))}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearerToken}` }, signal: ctrl.signal },
    ).finally(() => clearTimeout(tid));
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    return readOnlineFlag(raw);
  } catch {
    return null; // rede/timeout/JSON inválido: mantém o comportamento atual
  }
}

// Lê o "está online?" de um payload de formato desconhecido. Exportada para teste.
export function readOnlineFlag(raw: unknown): boolean | null {
  const cand: unknown[] = [];
  const push = (v: unknown) => { if (v && typeof v === "object") cand.push(v); };
  push(raw);
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    push(o.data); push(o.user); push(o.status);
    if (o.data && typeof o.data === "object") {
      const d = o.data as Record<string, unknown>;
      push(d.user); push(d.status);
    }
  }
  for (const obj of cand) {
    const o = obj as Record<string, unknown>;
    for (const chave of ["online", "isOnline", "is_online"]) {
      if (typeof o[chave] === "boolean") return o[chave] as boolean;
      if (o[chave] === "true") return true;
      if (o[chave] === "false") return false;
    }
    const st = typeof o.status === "string" ? o.status.toLowerCase().trim() : "";
    if (st === "offline") return false;
    if (st === "online") return true;
  }
  // string pura: alguns endpoints devolvem só "online"/"offline"
  if (typeof raw === "string") {
    const s = raw.toLowerCase().trim();
    if (s === "offline" || s === '"offline"') return false;
    if (s === "online" || s === '"online"') return true;
  }
  return null; // formato desconhecido → não interfere
}

export async function fetchOnlineAttendants(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  opts?: { excludeNames?: string[] },
): Promise<{ all: AttendantUser[]; online: AttendantUser[]; ok: boolean; error?: string; vacationExcluded?: string[] }> {
  // (implementação abaixo; isAttendantOnline é usada no final desta função)
  try {
    const listUsersUrl = `${baseUrl}/v2/api/external/${apiId}/listUsers`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(listUsersUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(tid));
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[fetchOnlineAttendants] listUsers failed: ${res.status} - ${errText.slice(0, 200)}`);
      return { all: [], online: [], ok: false, error: `listUsers ${res.status}` };
    }
    const usersData: any = await res.json();
    let users: AttendantUser[] = [];
    if (Array.isArray(usersData)) users = usersData;
    else if (Array.isArray(usersData?.users)) users = usersData.users;
    else if (Array.isArray(usersData?.data)) users = usersData.data;
    // Filter out admin profiles — never receive patient chats
    let nonAdmin = users.filter((u) => {
      const profile = String((u as any).profile || (u as any).role || "").toLowerCase();
      return profile !== "admin";
    });
    // Filter out users disabled/inactive in AvanceAI (Z-PRO disabled flag varies by field name)
    nonAdmin = nonAdmin.filter((u: any) => {
      if (u.active === false) return false;
      if (u.enabled === false) return false;
      if (u.disabled === true) return false;
      if (u.deletedAt) return false;
      const st = String(u.status || "").toLowerCase();
      if (st === "disabled" || st === "inactive" || st === "blocked") return false;
      return true;
    });
    // Filter vacation list (matches by normalized name substring/exact)
    const vacationExcluded: string[] = [];
    const excludeNames = (opts?.excludeNames || []).filter(Boolean);
    if (excludeNames.length > 0) {
      const isVacation = (name: string) => {
        const n = stripAccents(String(name || "").toLowerCase().trim());
        return excludeNames.some((v) => n === v || n.includes(v) || v.includes(n));
      };
      nonAdmin = nonAdmin.filter((u) => {
        if (isVacation(u.name)) {
          vacationExcluded.push(u.name);
          return false;
        }
        return true;
      });
    }
    let online = nonAdmin.filter((u) => {
      if ((u as any).online === false) return false;
      if (typeof (u as any).status === "string" && String((u as any).status).toLowerCase() === "offline") return false;
      return true;
    });

    // ── PRESENÇA REAL (caso Lidiane, 27/07) ────────────────────────────────────
    // O filtro acima é FAIL-OPEN: só exclui quem vem com online===false explícito.
    // Como o listUsers do Z-PRO não traz esse campo de forma confiável, TODA a
    // equipe era considerada online 100% do tempo — medido em attendant_routing_log:
    // online_count = total_count = 5 em 100% das decisões de 9 dias, madrugadas e
    // fins de semana inclusive. Resultado: 9 pacientes foram encaminhados para uma
    // atendente que não veio trabalhar (um deles às 06:08 da manhã).
    // A doc do projeto já apontava o caminho certo (docs/avanceai-api-reference.md,
    // "Bugs Conhecidos" #3): getUserStatus é o endpoint preciso por atendente.
    // Confirmamos um a um, em paralelo, e SÓ removemos quem responder
    // inequivocamente "offline" — resposta ambígua, erro ou timeout mantêm a pessoa
    // (fail-open, comportamento idêntico ao de hoje). Nunca esvazia a lista.
    try {
      const checagens = await Promise.all(
        online.map(async (u) => ({ user: u, presente: await isAttendantOnline(baseUrl, apiId, bearerToken, (u as any).id) })),
      );
      const offlineConfirmados = checagens.filter((c) => c.presente === false);
      if (offlineConfirmados.length > 0 && offlineConfirmados.length < checagens.length) {
        const nomes = offlineConfirmados.map((c) => String(c.user.name || c.user.id)).join(", ");
        console.log(`[fetchOnlineAttendants] getUserStatus confirmou OFFLINE: ${nomes} — fora do rodízio`);
        online = checagens.filter((c) => c.presente !== false).map((c) => c.user);
      } else if (offlineConfirmados.length === checagens.length && checagens.length > 0) {
        // Todas offline (fora do expediente ou API mudou de contrato): não zera a
        // lista aqui — quem decide o que fazer sem ninguém é a escada de seleção.
        console.log(`[fetchOnlineAttendants] getUserStatus diz que TODAS estão offline — mantendo a lista (decisão é da escada)`);
      }
    } catch (e) {
      console.log(`[fetchOnlineAttendants] checagem de presença falhou (non-blocking): ${(e as Error).message}`);
    }

    return { all: nonAdmin, online, ok: true, vacationExcluded };
  } catch (e) {
    console.error(`[fetchOnlineAttendants] error: ${(e as Error).message}`);
    return { all: [], online: [], ok: false, error: (e as Error).message };
  }
}

export async function sendTypingIndicator(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  ticketId: string | number | null | undefined,
  channelId?: string | null,
): Promise<void> {
  if (!ticketId) {
    console.log(`[Webhook] Typing indicator skipped — sem ticketId no payload`);
    return;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const body: Record<string, unknown> = { ticketId: Number(ticketId), state: "typing" };
    if (channelId) body.channelId = Number(channelId);
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}/sendPresence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    console.log(`[Webhook] Typing indicator (sendPresence) ticket=${ticketId} status=${res.status}`);
  } catch (e: any) {
    console.log(`[Webhook] Typing indicator error (non-fatal): ${e.message}`);
  }
}

export async function sendAvanceaiReply(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  phone: string,
  text: string,
  channelId?: string | null,
): Promise<boolean> {
  const cleanPhone = phone.replace(/\D/g, "");
  const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;

  try {
    const payload: Record<string, unknown> = {
      number: fullPhone,
      body: text,
      externalKey: crypto.randomUUID(),
      isClosed: false,
    };

    // Include channelId AND whatsappId so the reply goes through the same channel
    // Z-PRO may use whatsappId internally (same as ticket.whatsappId from incoming webhooks)
    if (channelId) {
      payload.channelId = Number(channelId);
      payload.whatsappId = Number(channelId);
    }

    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      let resBody = "";
      try {
        resBody = await res.text();
      } catch {
        /* ignore */
      }
      console.log(
        `[Webhook] Reply sent via AvanceAI to ${fullPhone}${channelId ? ` (channel: ${channelId})` : ""} — response: ${resBody.substring(0, 300)}`,
      );
      return true;
    }
    const errText = await res.text();
    console.log(`[Webhook] AvanceAI reply failed: ${res.status} - ${errText}`);
    return false;
  } catch (e: any) {
    console.log(`[Webhook] AvanceAI reply error: ${e.message}`);
    return false;
  }
}

export async function checkTicketIsHumanOwned(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  phone: string,
  channelId?: string | null,
): Promise<{ isHumanOwned: boolean; status: string; userId: string | number | null; userName: string }> {
  const cleanPhone = phone.replace(/\D/g, "");
  const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
  const showUrl = `${baseUrl}/v2/api/external/${apiId}/showticket`;
  const payload: Record<string, unknown> = { number: fullPhone };
  if (channelId) {
    payload.channelId = Number(channelId);
    payload.whatsappId = Number(channelId);
  }

  const attempts = [
    { timeoutMs: 4000, label: "1/3" },
    { timeoutMs: 6000, label: "2/3" },
    { timeoutMs: 8000, label: "3/3" },
  ];

  let lastErrCode = "";
  for (let i = 0; i < attempts.length; i++) {
    const { timeoutMs, label } = attempts[i];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(showUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        const status = String(data?.status || "");
        const userId = data?.userId ?? data?.user?.id ?? null;
        const userName = String(data?.user?.name || "");
        if (status === "open" && (!userId || Number(userId) === 0) && !userName) {
          console.log(
            `[TicketCheck:${label}] Ticket status="open" but no real agent (userId=${userId}) — ORPHAN (not human-owned)`,
          );
          return { isHumanOwned: false, status: "open_orphan", userId, userName };
        }
        if (status === "pending" || status === "closed") {
          console.log(`[TicketCheck:${label}] Ticket status="${status}" — NOT human-owned`);
          return { isHumanOwned: false, status, userId, userName };
        }
        if (status === "open") {
          console.log(`[TicketCheck:${label}] Ticket status="open", agent="${userName}" (userId=${userId}) — HUMAN-OWNED`);
          return { isHumanOwned: true, status, userId, userName };
        }
        console.log(`[TicketCheck:${label}] Ticket status="${status}" (unknown variant) — treating as NOT human-owned`);
        return { isHumanOwned: false, status, userId, userName };
      }
      // 404 → no ticket exists, no need to retry, fail-open
      if (res.status === 404) {
        console.log(`[TicketCheck:${label}] showticket 404 — FAIL-OPEN: no ticket (new patient)`);
        return { isHumanOwned: false, status: "no_ticket", userId: null, userName: "" };
      }
      // 401/403 → auth problem, retrying won't help, fail-safe immediately
      if (res.status === 401 || res.status === 403) {
        console.log(`[TicketCheck:${label}] showticket ${res.status} — AUTH ERROR, no retry, FAIL-SAFE`);
        return { isHumanOwned: true, status: "auth_error_blocked", userId: null, userName: "" };
      }
      // 5xx or other transient — retry
      lastErrCode = `http_${res.status}`;
      console.log(`[TicketCheck:${label}] showticket returned ${res.status} — transient, will retry`);
    } catch (e: any) {
      lastErrCode = e.name === "AbortError" ? "timeout" : (e.message || "network");
      console.log(`[TicketCheck:${label}] showticket error: ${lastErrCode} — transient, will retry`);
    }
    // Backoff before next attempt: 800ms, 1600ms (no wait after last)
    if (i < attempts.length - 1) {
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, i)));
    }
  }

  console.log(`[TicketCheck] ⛔ All 3 attempts failed (last: ${lastErrCode}) — FAIL-SAFE: blocking AI`);
  return { isHumanOwned: true, status: "api_error_blocked", userId: null, userName: "" };
}

export async function transferTicketToHuman(opts: {
  baseUrl: string;
  apiId: string;
  bearerToken: string;
  phone: string; // already formatted with 55 prefix
  userId?: number | string;
  channelId?: string | null;
  // Caso (06/07): transferencia DIRIGIDA por regra (exames->Vania)
  // ficava presa na dona antiga do ticket ("preserving owner"). Quando o caller
  // tem um alvo explicito e o dono atual e OUTRA pessoa, forceReassign=true
  // re-atribui. Seguro: o pipeline so chega aqui com a IA ativa, ou seja, o
  // dono atual esta stale (guard humano de 8h ja teria silenciado a IA).
  forceReassign?: boolean;
}): Promise<TransferResult> {
  const { baseUrl, apiId, bearerToken, phone, userId, channelId, forceReassign } = opts;

  const buildLookupPayload = () => ({
    number: phone,
    ...(channelId ? { channelId: Number(channelId), whatsappId: Number(channelId) } : {}),
  });

  const updateByTicketId = async (
    ticketId: string,
    source: "showticket" | "showallticket",
  ): Promise<TransferResult> => {
    const updateUrl = `${baseUrl}/v2/api/external/${apiId}/updateticketinfo`;
    const payload: Record<string, unknown> = {
      ticketId: Number(ticketId),
      status: "open",
      chatgptStatus: false,
      n8nStatus: false,
      typebotStatus: false,
      dialogflowStatus: false,
      difyStatus: false,
    };

    if (userId) payload.userId = Number(userId);
    if (channelId) {
      payload.channelId = Number(channelId);
      payload.whatsappId = Number(channelId);
    }

    const res = await fetch(updateUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    console.log(`[Transfer] updateticketinfo (${source}) response: ${res.status} — ${body.substring(0, 300)}`);

    if (res.ok) {
      return { ok: true, httpStatus: res.status, attempt: "ticketId", ticketId };
    }

    return {
      ok: false,
      httpStatus: res.status,
      attempt: "ticketId",
      ticketId,
      errorDetail: `updateticketinfo (${source}) ${res.status}: ${body.substring(0, 200)}`,
    };
  };

  let lastHttpStatus = 0;
  let lastErrorDetail = "";

  // ── Attempt A: showticket (v2) with retry → ticketId → updateticketinfo ──
  const showUrl = `${baseUrl}/v2/api/external/${apiId}/showticket`;
  const MAX_SHOW_RETRIES = 3;
  for (let showAttempt = 1; showAttempt <= MAX_SHOW_RETRIES; showAttempt++) {
    console.log(
      `[Transfer] Attempt A (try ${showAttempt}/${MAX_SHOW_RETRIES}) — showticket (v2) for number=${phone}, channelId=${channelId || "none"}`,
    );
    try {
      const showRes = await fetch(showUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildLookupPayload()),
      });
      const showBody = await showRes.text();
      console.log(`[Transfer] showticket response: ${showRes.status} — ${showBody.substring(0, 400)}`);

      let showData: any;
      try {
        showData = JSON.parse(showBody);
      } catch {
        showData = null;
      }

      if (showRes.ok) {
        // ── IDEMPOTENT CHECK: only preserve owner if ticket is currently "open" with a human agent.
        // Closed/pending tickets often carry a stale userId from the last attendant — if we preserved
        // those too, transfers would silently no-op and leave the patient unattended.
        const currentStatus = String(showData?.status || "");
        const currentUserId = showData?.userId ?? showData?.user?.id ?? null;
        const incomingUserId = userId ? Number(userId) : null;
        if (currentStatus === "open" && currentUserId && Number(currentUserId) > 0) {
          const currentUserName = String(showData?.user?.name || `userId=${currentUserId}`);
          const wantsDifferentOwner =
            forceReassign && incomingUserId !== null && Number(currentUserId) !== incomingUserId;
          if (wantsDifferentOwner) {
            // Transferencia dirigida por regra: o dono atual e outra pessoa (e esta
            // stale, senao a IA nem estaria ativa) — re-atribui para o alvo correto.
            console.log(
              `[Transfer] 🔁 REASSIGN forced — ticket open with "${currentUserName}" (userId=${currentUserId}) but rule targets userId=${incomingUserId}; overwriting owner`,
            );
          } else {
            console.log(
              `[Transfer] ⛔ Ticket open with agent "${currentUserName}" (userId=${currentUserId}) — preserving owner, not overwriting (wanted userId=${incomingUserId ?? "<none>"})`,
            );
            return {
              ok: true,
              httpStatus: 200,
              attempt: "already_human_owned",
              ticketId: String(showData?.id || showData?.ticketId || ""),
            };
          }
        }
        console.log(
          `[Transfer] 🔄 Ticket status="${currentStatus}" (userId=${currentUserId ?? "null"}) — proceeding to assign userId=${incomingUserId ?? "<none>"}.`,
        );


        const ticketId = extractTicketIdForTransfer(showData);
        if (ticketId) {
          const updated = await updateByTicketId(ticketId, "showticket");
          if (updated.ok) return updated;
          lastHttpStatus = updated.httpStatus;
          lastErrorDetail = updated.errorDetail || "";
        } else {
          lastHttpStatus = showRes.status;
          lastErrorDetail = "showticket sem ticketId";
        }
        break; // Got a valid response (even if no ticketId), don't retry
      } else {
        lastHttpStatus = showRes.status;
        lastErrorDetail = `showticket ${showRes.status}: ${showBody.substring(0, 200)}`;
        if (showAttempt < MAX_SHOW_RETRIES) {
          console.log(`[Transfer] showticket failed (${showRes.status}), retrying in ${showAttempt * 2}s...`);
          await new Promise((r) => setTimeout(r, showAttempt * 2000));
          continue;
        }
      }
    } catch (errA: any) {
      lastHttpStatus = 0;
      lastErrorDetail = `showticket network: ${errA.message}`;
      console.log(`[Transfer] Attempt A network error: ${errA.message}`);
      if (showAttempt < MAX_SHOW_RETRIES) {
        console.log(`[Transfer] Retrying showticket in ${showAttempt * 2}s...`);
        await new Promise((r) => setTimeout(r, showAttempt * 2000));
        continue;
      }
    }
    break; // Only reach here if we got a valid but unsuccessful response
  }

  // ── Attempt B: showallticket (v2) → ticketId → updateticketinfo ──
  const showAllUrl = `${baseUrl}/v2/api/external/${apiId}/showallticket`;
  console.log(`[Transfer] Attempt B — showallticket (v2) for number=${phone}, channelId=${channelId || "none"}`);
  try {
    const showAllRes = await fetch(showAllUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildLookupPayload()),
    });
    const showAllBody = await showAllRes.text();
    console.log(`[Transfer] showallticket response: ${showAllRes.status} — ${showAllBody.substring(0, 400)}`);

    let showAllData: any;
    try {
      showAllData = JSON.parse(showAllBody);
    } catch {
      showAllData = null;
    }

    if (showAllRes.ok) {
      // ── IDEMPOTENT CHECK on showallticket too: only preserve owner if ticket is currently "open" ──
      const allCurrentStatus = String(showAllData?.status || "");
      const allCurrentUserId = showAllData?.userId ?? showAllData?.user?.id ?? null;
      const incomingUserIdB = userId ? Number(userId) : null;
      if (allCurrentStatus === "open" && allCurrentUserId && Number(allCurrentUserId) > 0) {
        const allCurrentUserName = String(showAllData?.user?.name || `userId=${allCurrentUserId}`);
        console.log(
          `[Transfer] ⛔ (showallticket) Ticket open with agent "${allCurrentUserName}" (userId=${allCurrentUserId}) — preserving owner, not overwriting (wanted userId=${incomingUserIdB ?? "<none>"})`,
        );
        return {
          ok: true,
          httpStatus: 200,
          attempt: "already_human_owned",
          ticketId: String(showAllData?.id || showAllData?.ticketId || ""),
        };
      }
      console.log(
        `[Transfer] 🔄 (showallticket) Ticket status="${allCurrentStatus}" — proceeding to assign userId=${incomingUserIdB ?? "<none>"}.`,
      );


      const ticketId = extractTicketIdForTransfer(showAllData);
      if (ticketId) {
        return await updateByTicketId(ticketId, "showallticket");
      }
      lastHttpStatus = showAllRes.status;
      lastErrorDetail = "showallticket sem ticketId";
    } else {
      lastHttpStatus = showAllRes.status;
      lastErrorDetail = `showallticket ${showAllRes.status}: ${showAllBody.substring(0, 200)}`;
    }
  } catch (errB: any) {
    lastHttpStatus = 0;
    lastErrorDetail = `showallticket network: ${errB.message}`;
    console.log(`[Transfer] Attempt B network error: ${errB.message}`);
  }

  return {
    ok: false,
    httpStatus: lastHttpStatus || 404,
    attempt: "none",
    errorDetail: lastErrorDetail || "Ticket não encontrado para transferência",
  };
}
