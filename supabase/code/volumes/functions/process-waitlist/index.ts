// process-waitlist — cron (10 min): motor da lista de espera por médico.
// 1) Expira ofertas não confirmadas em 1h -> entry volta pro FIM da fila e o
//    próximo ciclo oferece ao próximo.
// 2) Varre a agenda REAL do Amigo (calendar) por clínica com waitlist_enabled;
//    achando vaga em até 6 dias para um médico com fila, notifica o PRIMEIRO
//    (validade 1h). Máx 1 oferta ativa por médico por vez.
// A CONFIRMAÇÃO ("quero"/"sim") é processada pelo whatsapp-webhook (guard
// waitlist-accept), que força o fluxo normal de agendamento — CPF, tipo de
// consulta, convênio, auditoria e verify-booking inclusos.
// IMPORTANTE: a mensagem de oferta NÃO pode instruir o paciente com o verbo
// "responder/confirmar" seguido da palavra afirmativa — o orphan-ACK guard do
// webhook trataria a resposta como confirmação externa e a silenciaria. Por
// isso o texto usa "me diga *quero*". Há teste de regressão cobrindo isso.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const API_URLS = ["https://amigobot-api.amigoapp.com.br", "https://api.amigoapp.com.br"];
const GOOD_SLOT_WINDOW_DAYS = 6; // vaga "boa" = até 6 dias (< threshold do convite, 7)
const OFFER_TTL_MIN = 180; // 3h para confirmar (pedido 19/07: 1h era curto p/ WhatsApp)
const QUIET_HOUR_START = 20; // sem notificações 20h–7h (SP)
const QUIET_HOUR_END = 7;
// Espelho de WAITLIST_ACCEPT_RE (helpers.ts do webhook) — o cron não importa
// daquele módulo. Usado só para NÃO mandar "não deu tempo de confirmar" a quem
// respondeu aceitando (caso 27/07). Ancorado no início, então
// "não quero" não casa. Se um dia divergirem, o pior caso é mandar um aviso a
// mais/a menos — nunca agendar errado.
const WL_ACEITE_RE =
  /^\s*[^\p{L}\p{N}]*\s*(sim+|quero+|aceito|pode\s+ser|confirmo|confirmar|fechado|fechou|bora|vamos|claro|com\s+certeza|perfeito|[óo]timo|top|s)(?![\p{L}\p{N}])/iu;

function getNowSPParts(): { hour: number; minute: number; todayISO: string } {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    todayISO: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function formatDateLabelPt(iso: string): string {
  const weekDays = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} (${weekDays[wd]})`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token JWT inválido");
  let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return JSON.parse(atob(base64));
}

// Mini tryFetch (GET): 2 tentativas × 2 bases, timeout 12s, unwrap {data}.
// Auditoria 10/07: o calendar da clínica inteira é a chamada mais pesada da API
// legada — 1 tentativa de 10s pulava a clínica em horário de pico, sem rastro.
async function amigoGet(endpoint: string, token: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    for (const base of API_URLS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(`${base}/${endpoint}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          let data: unknown = await res.json();
          if (data && typeof data === "object" && !Array.isArray(data) && "data" in (data as Record<string, unknown>)) {
            data = (data as Record<string, unknown>).data;
          }
          return data;
        }
        console.log(`[Waitlist] amigoGet ${base}/${endpoint} -> ${res.status} (attempt ${attempt + 1})`);
      } catch (e) {
        console.log(`[Waitlist] amigoGet ${base}/${endpoint} erro: ${(e as Error).message} (attempt ${attempt + 1})`);
      }
    }
  }
  return null;
}

// PUT no Amigo. Só existe para EFETIVAR um aceite que o paciente já deu por
// escrito (19/08) — o cron não inventa agendamento, ele conclui um que ficou
// pela metade. Mesma cadeia de rotas do reagendar do webhook, que é a que
// funciona em produção: a oficial primeiro, as legadas só em 404/502.
async function amigoPut(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; detalhe: string }> {
  let ultimo = { ok: false, status: 0, detalhe: "sem resposta" };
  for (const base of API_URLS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(`${base}/${endpoint}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const txt = (await res.text()).slice(0, 160);
      if (res.ok) return { ok: true, status: res.status, detalhe: "" };
      ultimo = { ok: false, status: res.status, detalhe: `HTTP ${res.status}: ${txt}` };
      console.log(`[Waitlist] amigoPut ${base}/${endpoint} -> ${res.status}`);
    } catch (e) {
      ultimo = { ok: false, status: 0, detalhe: `exceção: ${(e as Error).message.slice(0, 120)}` };
      console.log(`[Waitlist] amigoPut ${base}/${endpoint} erro: ${(e as Error).message}`);
    }
  }
  return ultimo;
}

// Reagenda uma consulta existente para data/hora nova. Cadeia idêntica à do
// webhook (rota oficial -> `api/attendance/{id}/reschedule` -> update-date-time).
async function amigoReagendar(
  attId: string,
  companyId: string,
  token: string,
  novaDataHora: string,
): Promise<{ ok: boolean; detalhe: string }> {
  const oficial = await amigoPut(`attendances/${attId}/reschedule?company_id=${companyId}`, token, { date: novaDataHora });
  if (oficial.ok) return { ok: true, detalhe: "" };
  if (oficial.status !== 404 && oficial.status !== 502) return { ok: false, detalhe: oficial.detalhe };
  const legada = await amigoPut(`api/attendance/${attId}/reschedule`, token, {
    company_id: Number(companyId), date: novaDataHora,
  });
  if (legada.ok) return { ok: true, detalhe: "" };
  const ultima = await amigoPut(`api/attendance/${attId}/update-date-time`, token, {
    company_id: Number(companyId), date: novaDataHora,
  });
  if (ultima.ok) return { ok: true, detalhe: "" };
  return { ok: false, detalhe: `${oficial.detalhe} | ${legada.detalhe} | ${ultima.detalhe}`.slice(0, 220) };
}

// Mesmo seletor de evento do widget/webhook: consulta NORMAL (nunca "1° VEZ" —
// símbolo de GRAU U+00B0 nos nomes reais da CBT).
function pickConsultaEvent(events: Array<Record<string, unknown>>): Record<string, unknown> | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  const norm = (e: Record<string, unknown>) =>
    String((e as { name?: string; nome?: string }).name || (e as { nome?: string }).nome || "").toLowerCase();
  const isPrimeira = (e: Record<string, unknown>) =>
    /primeir|1\s*[ªº°ao]?\s*vez|1\s*[ªº°]|\b1a\b/.test(norm(e));
  return (
    events.find((e) => norm(e).includes("consulta") && !isPrimeira(e)) ||
    events.find((e) => !isPrimeira(e)) ||
    events[0]
  );
}

// Auditoria 10/07: pular oferta para QUALQUER ticket "open" prendia pacientes
// para sempre — no Z-PRO tickets ficam "open" SEM atendente (órfãos) com
// frequência (semântica open_orphan que o webhook já aprendeu). Só adia a
// oferta se open COM agente humano real (userId > 0).
async function isTicketHumanActive(baseUrl: string, apiId: string, bearerToken: string, phone: string): Promise<boolean> {
  try {
    const cleanPhone = phone.replace(/\D/g, "");
    const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}/showticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ number: fullPhone }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      const status = String(data?.status || "");
      const userId = Number(data?.userId ?? data?.user?.id ?? 0);
      const userName = String(data?.user?.name || "").trim();
      // Paridade com avanceai.ts: agente real = userId>0 OU userName presente
      return status === "open" && (userId > 0 || userName.length > 0);
    }
  } catch (_) { /* fail-safe: não bloquear a oferta por falha do showticket */ }
  return false;
}

// ── Resolução de canal + credenciais (validado ao vivo 19/07, caso Guilherme) ──
// avanceai_active_channel é um ARRAY JSON de canais e CADA canal tem credenciais
// PRÓPRIAS ({id, apiId, baseUrl, bearerToken, enabled}). Enviar com as credenciais
// "planas" da clínica deu ERR_API_REQUIRES_SESSION (sessão morta). O caminho que
// FUNCIONA (webhook) usa as credenciais DO CANAL DO PACIENTE (raw_payload da
// mensagem recebida) e ignora canais enabled===false. Espelhado aqui.
type ChannelCfg = { id?: unknown; apiId?: string; baseUrl?: string; bearerToken?: string; enabled?: boolean };
type SendCreds = { avanceai_base_url: string; avanceai_api_id: string; avanceai_bearer_token: string };

function wlPhoneVariants(raw: string): string[] {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return [];
  const local = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
  const locals = new Set<string>([local]);
  if (local.length === 11 && local[2] === "9") locals.add(local.slice(0, 2) + local.slice(3));
  if (local.length === 10) locals.add(local.slice(0, 2) + "9" + local.slice(2));
  const out = new Set<string>();
  for (const l of locals) { out.add(l); out.add(`55${l}`); }
  return [...out];
}

function parseEnabledChannels(raw: unknown): ChannelCfg[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed.filter((c: ChannelCfg) => c && c.apiId && c.baseUrl && c.enabled !== false);
    }
  } catch { /* ignore */ }
  return [];
}

async function getPatientChannelId(supabase: any, clinicId: string, phone: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("webhook_messages")
      .select("raw_payload")
      .eq("clinic_token_id", clinicId)
      .in("sender_phone", wlPhoneVariants(phone))
      .eq("direction", "incoming")
      .not("raw_payload", "is", null)
      .order("created_at", { ascending: false })
      .limit(5);
    for (const r of (data || []) as Array<{ raw_payload: any }>) {
      const p = r.raw_payload || {};
      const cand = p?.ticket?.whatsappId ?? p?.msg?.whatsappId ?? p?.whatsappId ?? p?.ticket?.channelId ?? p?.channelId;
      const n = Number(cand);
      if (Number.isFinite(n) && n > 0) return String(n);
    }
  } catch { /* sem canal */ }
  return null;
}

async function resolveSendTarget(
  supabase: any,
  clinicId: string,
  phone: string,
  clinic: { avanceai_base_url?: string | null; avanceai_api_id?: string | null; avanceai_bearer_token?: string | null; avanceai_active_channel?: unknown },
): Promise<{ creds: SendCreds; channelId: string | null } | null> {
  const channels = parseEnabledChannels(clinic.avanceai_active_channel);
  const fromCfg = (ch: ChannelCfg): SendCreds => ({
    avanceai_base_url: String(ch.baseUrl),
    avanceai_api_id: String(ch.apiId),
    avanceai_bearer_token: String(ch.bearerToken || clinic.avanceai_bearer_token || ""),
  });
  const patientChan = await getPatientChannelId(supabase, clinicId, phone);
  if (patientChan && channels.length > 0) {
    for (let i = channels.length - 1; i >= 0; i--) {
      if (String(channels[i].id) === patientChan) return { creds: fromCfg(channels[i]), channelId: patientChan };
    }
  }
  if (channels.length === 1) {
    return { creds: fromCfg(channels[0]), channelId: channels[0].id != null ? String(channels[0].id) : null };
  }
  if (channels.length === 0 && clinic.avanceai_base_url && clinic.avanceai_api_id && clinic.avanceai_bearer_token) {
    return {
      creds: {
        avanceai_base_url: String(clinic.avanceai_base_url),
        avanceai_api_id: String(clinic.avanceai_api_id),
        avanceai_bearer_token: String(clinic.avanceai_bearer_token),
      },
      channelId: patientChan,
    };
  }
  return null; // multi-canal sem canal do paciente: não chutar canal errado
}

async function sendWhats(
  creds: { avanceai_base_url: string; avanceai_api_id: string; avanceai_bearer_token: string },
  phone: string,
  msg: string,
  channelId?: string | null,
): Promise<{ ok: boolean; detail: string }> {
  // Auditoria 10/07: exceção de rede aqui derrubava a clínica INTEIRA no ciclo
  // (o catch externo abortava os demais médicos). Agora falha vira {ok:false}.
  try {
    const cleanPhone = phone.replace(/\D/g, "");
    const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
    const payload: Record<string, unknown> = {
      number: fullPhone, body: msg, externalKey: crypto.randomUUID(), isClosed: false,
    };
    // MESMO contrato do envio que funciona: channelId + whatsappId (Z-PRO usa o
    // whatsappId internamente pra rotear pelo canal certo).
    if (channelId) {
      payload.channelId = Number(channelId);
      payload.whatsappId = Number(channelId);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${creds.avanceai_base_url}/v2/api/external/${creds.avanceai_api_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.avanceai_bearer_token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    // Motivo do fracasso vai no errors_detail (logs do Lovable são instáveis).
    const detail = res.ok ? "" : `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
    if (!res.ok) console.log(`[Waitlist] envio falhou ${detail}`);
    return { ok: res.ok, detail };
  } catch (e) {
    const detail = `exceção: ${(e as Error).message.slice(0, 120)}`;
    console.log(`[Waitlist] ${detail}`);
    return { ok: false, detail };
  }
}

// Log de atividade da fila (pedido 22/07): registra CADA ação do motor num audit
// legível (tabela waitlist_events) que o painel mostra como "histórico da fila".
// NUNCA quebra o fluxo — falha ao logar é engolida (o log é secundário à ação).
async function logWaitlistEvent(
  supabase: any,
  ev: {
    clinic_token_id: string; entry_id?: string | null; conversation_id?: string | null;
    phone?: string | null; patient_name?: string | null; doctor_name?: string | null;
    event_type: string; detail: string;
  },
): Promise<void> {
  try {
    await supabase.from("waitlist_events").insert({
      clinic_token_id: ev.clinic_token_id,
      entry_id: ev.entry_id ?? null,
      conversation_id: ev.conversation_id ?? null,
      phone: ev.phone ?? null,
      patient_name: ev.patient_name ?? null,
      doctor_name: ev.doctor_name ?? null,
      event_type: ev.event_type,
      detail: ev.detail,
    });
  } catch (e) {
    console.log(`[Waitlist] log de evento falhou (non-blocking): ${(e as Error).message}`);
  }
}

// ── Leitura da agenda do Amigo: MESMAS variantes que o resto do sistema usa ──
// Bug medido em 19/08: a reconciliação lia `a.start_date` e `a.user_id` SEM as
// alternativas que verify-booking, sync-amigo-cache e booking-widget sempre
// usaram (`|| a.date`, `|| a.user?.id`). Bastava o Amigo devolver a variante
// para nada casar — e nada casou: 0 reconciliações em 23 entradas, seis semanas,
// com Ana e Roberto presos na fila depois de já terem sido atendidos.
// Estes helpers existem para que os dois caminhos que leem agenda (reconciliação
// e efetivação do aceite) nunca mais divirjam entre si.
function attDia(a: any): string {
  return String(a?.start_date || a?.date || a?.scheduledFor || "").slice(0, 10);
}
function attHora(a: any): string {
  const m = String(a?.start_date || a?.date || a?.scheduledFor || "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}
function attMedico(a: any): string {
  return String(a?.user_id ?? a?.user?.id ?? a?.doctor_id ?? a?.doctor?.id ?? "");
}
// Cancelamento no Amigo vem em 4 codificações (regra do CLAUDE.md) — checar só o
// booleano deixaria passar uma consulta CANCELADA como se fosse ativa.
function attCancelada(a: any): boolean {
  const st = String(a?.status || "").toLowerCase();
  return st === "cancelled" || st === "cancelado" || a?.canceled === true || a?.canceled === "true";
}
function attIdDe(a: any): string {
  return String(a?.id ?? a?.attendance_id ?? a?.attendanceId ?? "");
}

// patient_id do paciente da fila. DE PROPÓSITO sem fallback em local_patients:
// aquela tabela é escopada por user_id (não tem clinic_token_id), então casar só
// por TELEFONE poderia devolver o paciente de OUTRA clínica — e leríamos a agenda
// errada. pending_booking_verifications tem clinic_token_id + phone, é a fonte
// segura. Sem ID confiável não se chuta: tenta de novo no próximo ciclo.
async function patientIdDaFila(supabase: any, clinicTokenId: string, phone: string): Promise<string> {
  const { data } = await supabase
    .from("pending_booking_verifications")
    .select("patient_id")
    .eq("clinic_token_id", clinicTokenId)
    .in("phone", wlPhoneVariants(phone))
    .not("patient_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return String((data?.[0] as any)?.patient_id || "");
}

// "YYYY-MM-DD" -> "DD/MM" sem criar Date (sem risco de fuso), pro texto do log.
function ddmm(iso: string | null | undefined): string {
  const [, m, d] = String(iso || "").split("-");
  return d && m ? `${d}/${m}` : String(iso || "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const cronSecret = req.headers.get("x-cron-secret");
  const expectedSecret = Deno.env.get("CRON_SECRET");
  const hasApiKey = !!(req.headers.get("apikey") || req.headers.get("authorization"));
  const cronSecretOk = !!cronSecret && !!expectedSecret && cronSecret === expectedSecret;
  if (!cronSecretOk && !hasApiKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const sp = getNowSPParts();

  // Janela de silêncio: nada de mensagem de madrugada/noite. Expirações também
  // esperam a janela (o webhook rejeita aceites vencidos por expires_at).
  if (sp.hour >= QUIET_HOUR_START || sp.hour < QUIET_HOUR_END) {
    return new Response(JSON.stringify({ skipped: "quiet_hours", hour_sp: sp.hour }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const nowIso = new Date().toISOString();
  let expiredCount = 0, offered = 0, errors = 0, reconciled = 0;
  // Observabilidade (10/07): os logs do Lovable são instáveis — o MOTIVO de cada
  // erro vai no corpo da resposta, visível em net._http_response por SQL.
  const errorsDetail: string[] = [];

  // ── 0) RECONCILIAÇÃO: quem já antecipou POR FORA sai da fila (pedido 27/07) ──
  // Buraco real: toda baixa da fila dependia de um evento DENTRO do bot. Se a
  // atendente (ou a recepção, ou o próprio Amigo) remarca o paciente, nada percebe
  // — ele continua "aguardando vaga" e ainda recebe oferta/aviso. Casos Anderson
  // (21/07) e <paciente> (27/07): a Mardila agendou na mão e a entry ficou.
  // Fonte da VERDADE é o Amigo: GET attendances/{patient_id} (mesma rota que o
  // verify-booking já usa em produção). Se existir consulta ATIVA com o MESMO
  // médico em data ANTERIOR à consulta-base, a antecipação aconteceu → dá baixa.
  // Só LÊ do Amigo e só FECHA entry — nunca agenda, nunca manda mensagem.
  // Teto de chamadas por ciclo para não pesar na API (cron roda de 10 em 10 min).
  const RECONCILE_MAX = 20;
  try {
    const { data: _ativas } = await supabase
      .from("waitlist_entries")
      .select("id, phone, patient_name, doctor_id, doctor_name, status, requested_date, conversation_id, clinic_token_id, created_at, clinic_tokens:clinic_token_id (token, waitlist_enabled)")
      .in("status", ["waiting", "notified", "accepted"])
      .not("requested_date", "is", null)
      .limit(RECONCILE_MAX);

    for (const w of (_ativas || []) as any[]) {
      try {
        const tok = w.clinic_tokens?.token;
        if (!w.clinic_tokens?.waitlist_enabled || !tok) continue;
        const companyId = String(decodeJwtPayload(tok).company_id ?? "");
        if (!companyId) continue;
        const baseDate = String(w.requested_date || "").slice(0, 10);
        if (!baseDate) continue;

        const patientId = await patientIdDaFila(supabase, w.clinic_token_id, w.phone);
        if (!patientId) continue;

        const atts = (await amigoGet(`attendances/${patientId}?company_id=${companyId}`, tok)) as
          | Array<Record<string, unknown>>
          | null;
        if (!Array.isArray(atts) || atts.length === 0) continue;

        // Consulta ATIVA, do MESMO médico, em data ANTERIOR à consulta-base.
        //
        // A janela vai de quando ele ENTROU NA FILA até a consulta-base — não de
        // hoje. Exigir `dia >= hoje` (como era até 19/08) fazia a entrada ficar
        // aberta para sempre assim que o paciente era efetivamente atendido: a
        // Ana antecipou para 11/08 e continuou "aguardando vaga" para o dia 25/08,
        // recebendo oferta nova em 17/08 e tendo que responder "já fiz a consulta
        // na terça". Usar a data de entrada como piso é o que separa "antecipou
        // depois de entrar na fila" de uma consulta antiga qualquer do histórico.
        const pisoISO = String(w.created_at || "").slice(0, 10) || sp.todayISO;
        const antecipada = atts.find((a: any) => {
          if (attCancelada(a)) return false;
          const dia = attDia(a);
          if (!dia || dia < pisoISO || dia >= baseDate) return false;
          return attMedico(a) === String(w.doctor_id);
        });
        if (!antecipada) continue;

        const novaData = attDia(antecipada);
        await supabase.from("waitlist_entries")
          .update({ status: "booked", cancelled_reason: "antecipou_fora_do_bot", updated_at: nowIso })
          .eq("id", w.id);
        reconciled++;
        await logWaitlistEvent(supabase, {
          clinic_token_id: w.clinic_token_id, entry_id: w.id, conversation_id: w.conversation_id,
          phone: w.phone, patient_name: w.patient_name, doctor_name: w.doctor_name,
          event_type: "antecipou",
          detail: `${w.patient_name || "Paciente"} JÁ está com consulta antecipada com ${w.doctor_name} em ${ddmm(novaData)} (era ${ddmm(baseDate)}) — agendada fora do robô, então tirei da fila. ✅`,
        });
      } catch (err) {
        errorsDetail.push(`reconciliacao ${String(w.id).slice(0, 8)}: ${(err as Error).message}`.slice(0, 180));
      }
    }
  } catch (err) {
    errorsDetail.push(`reconciliacao geral: ${(err as Error).message}`.slice(0, 180));
  }

  // ── 0b) ACEITE DADO COM A ATENDENTE NO TICKET: conferir antes de mexer ─────
  // O webhook agora ANOTA o "quero" mesmo quando o guard de humano ativo
  // interrompe a mensagem (19/08) — ele grava status 'accepted' + accepted_at e
  // não responde nada. Quem decide o que fazer é este passo, e a ordem importa:
  //
  //   1. espera 15 minutos (nos casos medidos a atendente que estava no ticket
  //      resolveu em 1 a 3 minutos — <paciente> 27/07 em 1 min, Alexandre
  //      07/08 em 3 min; 15 min dá folga de sobra sem perder a vaga);
  //   2. LÊ a agenda real do Amigo;
  //   3. se a consulta JÁ está marcada (a atendente resolveu, ou o próprio
  //      paciente resolveu por outro caminho) → não faz NADA além de fechar a
  //      entrada. Regra do dono, textual: "se confirmou anteriormente e
  //      confirmou o agendamento, você não faz nada";
  //   4. só se ninguém agendou é que o robô efetiva o que o paciente pediu.
  //
  // Enquanto está 'accepted' a vaga fica reservada: o passo 3 não oferece o
  // mesmo médico a um terceiro (busyDoctors inclui 'accepted').
  const ESPERA_ACEITE_MIN = 15;
  const ACEITE_VALIDADE_H = 24; // depois disso a vaga já não é real — encerra
  try {
    const _corteAceite = new Date(Date.now() - ESPERA_ACEITE_MIN * 60_000).toISOString();
    const { data: _aceitos } = await supabase
      .from("waitlist_entries")
      .select("id, phone, patient_name, doctor_id, doctor_name, requested_date, offered_slot, accepted_at, conversation_id, clinic_token_id, created_at, clinic_tokens:clinic_token_id (token, waitlist_enabled, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel)")
      .eq("status", "accepted")
      .not("accepted_at", "is", null)
      .lte("accepted_at", _corteAceite)
      .limit(10);

    for (const w of (_aceitos || []) as any[]) {
      try {
        const tok = w.clinic_tokens?.token;
        if (!w.clinic_tokens?.waitlist_enabled || !tok) continue;
        const companyId = String(decodeJwtPayload(tok).company_id ?? "");
        const slotData = String(w.offered_slot?.date || "");
        const slotHora = String(w.offered_slot?.time || "");
        if (!companyId || !slotData || !slotHora) continue;

        // Vaga vencida demais: não dá para efetivar um horário que já passou nem
        // ressuscitar uma oferta de ontem. Sai da fila com o motivo escrito.
        const _velho = String(w.accepted_at) < new Date(Date.now() - ACEITE_VALIDADE_H * 3600_000).toISOString();
        if (slotData < sp.todayISO || _velho) {
          await supabase.from("waitlist_entries")
            .update({ status: "waiting", accepted_at: null, requeued_at: nowIso, updated_at: nowIso })
            .eq("id", w.id);
          await logWaitlistEvent(supabase, {
            clinic_token_id: w.clinic_token_id, entry_id: w.id, conversation_id: w.conversation_id,
            phone: w.phone, patient_name: w.patient_name, doctor_name: w.doctor_name,
            event_type: "oferta_expirada",
            detail: `${w.patient_name || "Paciente"} tinha aceitado a vaga de ${ddmm(slotData)} às ${slotHora}, mas não consegui efetivar a tempo — devolvi para a fila em vez de mexer numa vaga vencida.`,
          });
          continue;
        }

        const patientId = await patientIdDaFila(supabase, w.clinic_token_id, w.phone);
        if (!patientId) continue; // sem ID confiável não se chuta; tenta no próximo ciclo
        const atts = (await amigoGet(`attendances/${patientId}?company_id=${companyId}`, tok)) as
          | Array<Record<string, unknown>>
          | null;
        if (!Array.isArray(atts)) continue; // Amigo fora do ar: NÃO conclui às cegas

        const baseDate = String(w.requested_date || "").slice(0, 10);
        const pisoISO = String(w.created_at || "").slice(0, 10) || sp.todayISO;
        const doMedico = (a: any) => !attCancelada(a) && attMedico(a) === String(w.doctor_id);

        // (3) Alguém já resolveu? Duas formas: a consulta está exatamente na vaga
        // ofertada, ou o paciente já foi antecipado para qualquer data anterior à
        // consulta-base. Nos dois casos o robô fica quieto.
        const jaNaVaga = atts.find((a: any) => doMedico(a) && attDia(a) === slotData && attHora(a) === slotHora);
        const jaAntecipado = atts.find((a: any) => {
          if (!doMedico(a)) return false;
          const dia = attDia(a);
          return !!dia && dia >= pisoISO && (!baseDate || dia < baseDate);
        });
        const jaResolvido = jaNaVaga || jaAntecipado;
        if (jaResolvido) {
          await supabase.from("waitlist_entries")
            .update({ status: "booked", cancelled_reason: "ja_agendado_por_fora", accepted_at: null, updated_at: nowIso })
            .eq("id", w.id);
          reconciled++;
          await logWaitlistEvent(supabase, {
            clinic_token_id: w.clinic_token_id, entry_id: w.id, conversation_id: w.conversation_id,
            phone: w.phone, patient_name: w.patient_name, doctor_name: w.doctor_name,
            event_type: "antecipou",
            detail: `${w.patient_name || "Paciente"} aceitou a vaga e a consulta com ${w.doctor_name} JÁ estava marcada para ${ddmm(attDia(jaResolvido))}${attHora(jaResolvido) ? ` às ${attHora(jaResolvido)}` : ""} — não mexi em nada, só tirei da fila. ✅`,
          });
          continue;
        }

        // (4) Ninguém agendou. A consulta-base é a que vai ser remarcada para a
        // vaga: a da data guardada; se não achar, a próxima futura do mesmo médico.
        const base = atts.find((a: any) => doMedico(a) && baseDate && attDia(a) === baseDate)
          || atts.filter((a: any) => doMedico(a) && attDia(a) >= sp.todayISO)
                 .sort((a: any, b: any) => attDia(a).localeCompare(attDia(b)))[0];
        const attId = base ? attIdDe(base) : "";
        if (!attId) {
          errorsDetail.push(`aceite ${String(w.id).slice(0, 8)}: consulta-base não encontrada na agenda`);
          continue; // tenta de novo no próximo ciclo, até ACEITE_VALIDADE_H
        }

        const r = await amigoReagendar(attId, companyId, tok, `${slotData} ${slotHora}`);
        if (!r.ok) {
          errorsDetail.push(`aceite ${String(w.id).slice(0, 8)}: reagendar falhou — ${r.detalhe}`.slice(0, 180));
          continue; // segue 'accepted': a vaga continua reservada e tenta de novo
        }

        await supabase.from("waitlist_entries")
          .update({ status: "booked", accepted_at: null, updated_at: nowIso })
          .eq("id", w.id);
        await logWaitlistEvent(supabase, {
          clinic_token_id: w.clinic_token_id, entry_id: w.id, conversation_id: w.conversation_id,
          phone: w.phone, patient_name: w.patient_name, doctor_name: w.doctor_name,
          event_type: "antecipou",
          detail: `${w.patient_name || "Paciente"} aceitou a vaga e ninguém tinha agendado em ${ESPERA_ACEITE_MIN} min — antecipei a consulta com ${w.doctor_name} para ${ddmm(slotData)} às ${slotHora}. ✅`,
        });

        // O paciente disse "quero" e ficou sem resposta nenhuma até agora. Uma
        // linha factual do que aconteceu — sem tomar a conversa da atendente.
        const alvoMsg = await resolveSendTarget(supabase, w.clinic_token_id, w.phone, w.clinic_tokens);
        if (alvoMsg) {
          await sendWhats(
            alvoMsg.creds,
            w.phone,
            `Confirmado! ✅ Sua consulta com *${w.doctor_name}* foi antecipada para *${ddmm(slotData)} às ${slotHora}*.\n\n` +
              `Qualquer coisa é só falar por aqui.`,
            alvoMsg.channelId,
          );
        }
      } catch (err) {
        errorsDetail.push(`aceite ${String(w.id).slice(0, 8)}: ${(err as Error).message}`.slice(0, 180));
      }
    }
  } catch (err) {
    errorsDetail.push(`aceites geral: ${(err as Error).message}`.slice(0, 180));
  }

  // ── 1) Oferta expirou sem resposta -> SEGUNDA CHANCE (pedido 19/07) ─────────
  // 1º timeout: mantém a posição (a vaga vai pro próximo, mas o paciente segue na
  // frente e recebe a próxima vaga). 2º timeout seguido: vai pro FIM da fila e zera.
  // Recusa explícita ("não posso") continua indo direto pro fim (outro fluxo).
  const { data: overdue } = await supabase
    .from("waitlist_entries")
    .select("id, phone, patient_name, doctor_name, conversation_id, clinic_token_id, miss_count, notified_at, clinic_tokens:clinic_token_id (avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, user_id, waitlist_enabled)")
    .eq("status", "notified")
    .lt("expires_at", nowIso)
    .limit(25);

  for (const e of (overdue || []) as any[]) {
    try {
      const _newMiss = (e.miss_count || 0) + 1;
      const _toEnd = _newMiss >= 2; // 2ª chance esgotada → fim da fila
      // offered_slot fica GUARDADO na expiração (caso Marcia 21/07): é a "última vaga
      // ofertada" que o aceite TARDIO do webhook usa quando o paciente responde
      // "quero" depois do prazo — o fluxo re-valida a vaga na hora. (No fracasso de
      // ENVIO continua sendo limpo — o paciente nunca viu a oferta.)
      await supabase.from("waitlist_entries").update({
        status: "waiting", notified_at: null, expires_at: null,
        updated_at: nowIso,
        // 1ª perda: NÃO mexe em requeued_at (mantém a posição). 2ª: manda pro fim e zera.
        ...(_toEnd ? { requeued_at: nowIso, miss_count: 0 } : { miss_count: _newMiss }),
      }).eq("id", e.id);
      expiredCount++;

      // ── A oferta foi TRATADA por fora? (caso 27/07) ────────────
      // A vaga foi ofertada 09:40; o paciente respondeu "Quero" 09:50 — mas o guard
      // de humano ativo ENGOLIU a resposta (a atendente estava no ticket) e ela
      // agendou na mão 09:51. Às 12:50 o cron mandou "Não deu tempo de confirmar",
      // e a atendente teve que se desculpar ("pode ignorar, foi agendado sim").
      // Sinais de que alguém já cuidou: o paciente respondeu ACEITANDO depois da
      // oferta (mesmo que a mensagem tenha sido skipped), ou uma atendente escreveu
      // no ticket. Nesses casos a entry expira do MESMO jeito (a fila anda), mas o
      // aviso NÃO é enviado — melhor calar do que mentir para quem já foi atendido.
      let _tratadaPorFora = "";
      try {
        const _desdeOferta = e.notified_at || nowIso;
        const _vars = wlPhoneVariants(e.phone);
        const { data: _reacoes } = await supabase
          .from("webhook_messages")
          .select("direction, ai_intent, message_text")
          .eq("clinic_token_id", e.clinic_token_id)
          .in("sender_phone", _vars)
          .gt("created_at", _desdeOferta)
          .lt("created_at", nowIso)
          .limit(40);
        for (const m of (_reacoes || []) as any[]) {
          if (m.direction === "outgoing" && m.ai_intent === "manual_reply") {
            _tratadaPorFora = "uma atendente assumiu a conversa";
            break;
          }
          if (m.direction === "incoming") {
            const t = String(m.message_text || "").trim();
            // aceite curto e sem dígitos — mesmo espírito do guard [WaitlistReply]
            if (t.length <= 40 && !/\d/.test(t) && WL_ACEITE_RE.test(t)) {
              _tratadaPorFora = "o paciente respondeu aceitando";
              break;
            }
          }
        }
      } catch (err) {
        console.log(`[Waitlist] checagem de tratamento externo falhou (non-blocking): ${(err as Error).message}`);
      }

      await logWaitlistEvent(supabase, {
        clinic_token_id: e.clinic_token_id, entry_id: e.id, conversation_id: e.conversation_id,
        phone: e.phone, patient_name: e.patient_name, doctor_name: e.doctor_name,
        event_type: "oferta_expirada",
        detail: _tratadaPorFora
          ? `Oferta a ${e.patient_name || "paciente"} (${e.doctor_name}) venceu, mas ${_tratadaPorFora} — NÃO avisei "não deu tempo" para não contradizer o atendimento.`
          : _toEnd
            ? `Oferta a ${e.patient_name || "paciente"} (${e.doctor_name}) expirou de novo sem resposta — foi pro fim da fila.`
            : `Oferta a ${e.patient_name || "paciente"} (${e.doctor_name}) expirou sem resposta — mantém a posição na frente (2ª chance).`,
      });
      const creds = e.clinic_tokens;
      if (!_tratadaPorFora && creds?.avanceai_base_url && creds?.avanceai_api_id && creds?.avanceai_bearer_token) {
        const msg = _toEnd
          ? `A vaga com ${e.doctor_name} passou de novo sem confirmação, então repassei pro próximo da lista. 🙏\n\n` +
            `Você continua na lista de espera e te aviso quando abrir a próxima!`
          // 31/07: a mensagem dizia "você segue na frente da fila e te aviso na PRÓXIMA
          // vaga" — com a rotação nova isso deixou de ser verdade (a próxima vaga vai
          // para quem está atrás). Promessa que o sistema não cumpre é o tipo de erro
          // que já custou caro aqui, então o texto passa a descrever o que acontece.
          : `Não deu tempo de confirmar a vaga com ${e.doctor_name} (a oferta vale 3h), então passei essa para o próximo da lista. 🙏\n\n` +
            `Você *continua na lista de espera* e volta a receber quando abrir a próxima vaga que der certo para você!`;
        const target = await resolveSendTarget(supabase, e.clinic_token_id, e.phone, creds);
        const send = target
          ? await sendWhats(target.creds, e.phone, msg, target.channelId)
          : { ok: false, detail: "canal não resolvível" };
        if (send.ok) {
          await supabase.from("webhook_messages").insert({
            clinic_token_id: e.clinic_token_id, user_id: creds.user_id || null,
            sender_phone: e.phone, sender_name: e.patient_name || null,
            message_text: msg, direction: "outgoing",
            ai_intent: "waitlist_expired", action_status: "success",
            conversation_id: e.conversation_id,
          });
        }
      }
    } catch (err) {
      console.error(`[Waitlist] expiração ${e.id}:`, (err as Error).message);
      errors++;
      errorsDetail.push(`expiracao ${String(e.id).slice(0, 8)}: ${(err as Error).message}`.slice(0, 180));
    }
  }

  // ── 1b) TETO DE OFERTAS por entrada (caso Marcia 28/07) ────────────────────
  // Ela recebeu 14 ofertas / 24 mensagens automáticas em 9 dias e recusou 3 vezes.
  // A fila do médico tinha só ela: expirava → voltava "pro fim da fila" (ela mesma)
  // → 24h depois passava do cooldown de 20h → mesma vaga de novo, todo dia às 7h.
  // Insistir para sempre não converte, só irrita. Depois de MAX_OFFERS a entrada sai
  // da fila (silenciosamente — mais uma mensagem seria justamente o problema).
  const MAX_OFFERS_PER_ENTRY = 6;
  const { data: _exausted } = await supabase.from("waitlist_entries")
    .update({ status: "expired", cancelled_reason: "limite_de_ofertas_atingido", updated_at: nowIso })
    .eq("status", "waiting")
    .gte("offer_count", MAX_OFFERS_PER_ENTRY)
    .select("id, phone, patient_name, doctor_name, conversation_id, clinic_token_id, offer_count");
  for (const r of (_exausted || []) as any[]) {
    await logWaitlistEvent(supabase, {
      clinic_token_id: r.clinic_token_id, entry_id: r.id, conversation_id: r.conversation_id,
      phone: r.phone, patient_name: r.patient_name, doctor_name: r.doctor_name,
      event_type: "removido",
      detail: `Removido da fila: ${r.patient_name || "paciente"} (${r.doctor_name}) — já recebeu ${r.offer_count} ofertas sem aceitar. Parei de oferecer para não virar insistência.`,
    });
  }

  // ── 2) Higiene: waiting com 30+ dias sai da fila ───────────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: _expired30 } = await supabase.from("waitlist_entries")
    .update({ status: "expired", cancelled_reason: "waitlist_expired_30d", updated_at: nowIso })
    .eq("status", "waiting")
    .lt("created_at", thirtyDaysAgo)
    .select("id, phone, patient_name, doctor_name, conversation_id, clinic_token_id");
  for (const r of (_expired30 || []) as any[]) {
    await logWaitlistEvent(supabase, {
      clinic_token_id: r.clinic_token_id, entry_id: r.id, conversation_id: r.conversation_id,
      phone: r.phone, patient_name: r.patient_name, doctor_name: r.doctor_name,
      event_type: "removido",
      detail: `Removido da fila: ${r.patient_name || "paciente"} (${r.doctor_name}) — 30 dias na lista sem vaga.`,
    });
  }

  // ── 2b) Consulta-base HOJE ou JÁ PASSOU → sai da fila (pedido 19/07; ampliado 22/07) ──
  // A lista de espera existe para ANTECIPAR uma consulta FUTURA. Se a data que o
  // paciente já tinha marcada (requested_date) é HOJE ou ficou no passado, não há
  // mais o que antecipar — o cron só oferta de hoje em diante, não existe "mais
  // cedo" que a consulta dele. Sai da fila. requested_date é texto ISO (YYYY-MM-DD):
  // comparação lexicográfica com hoje (SP) funciona. Cobre waiting E notified
  // (oferta pendente perde o sentido). Caso Alfredo (base 22/07 preso na fila no
  // próprio dia da consulta): <= em vez de < passa a incluir hoje.
  const { data: _basePassed } = await supabase.from("waitlist_entries")
    .update({ status: "expired", cancelled_reason: "consulta_base_ja_passou", updated_at: nowIso })
    .in("status", ["waiting", "notified", "accepted"])
    .not("requested_date", "is", null)
    .lte("requested_date", sp.todayISO)
    .select("id, phone, patient_name, doctor_name, conversation_id, clinic_token_id, requested_date");
  for (const r of (_basePassed || []) as any[]) {
    await logWaitlistEvent(supabase, {
      clinic_token_id: r.clinic_token_id, entry_id: r.id, conversation_id: r.conversation_id,
      phone: r.phone, patient_name: r.patient_name, doctor_name: r.doctor_name,
      event_type: "removido",
      detail: `Removido da fila: ${r.patient_name || "paciente"} (${r.doctor_name}) — a consulta-base (${ddmm(r.requested_date)}) é hoje ou já passou, não há o que antecipar.`,
    });
  }

  // ── 3) Ofertas: varrer agenda por clínica e notificar o 1º da fila ─────────
  const { data: waiting, error: waitingErr } = await supabase
    .from("waitlist_entries")
    .select("id, phone, patient_name, doctor_id, doctor_name, preferred_period, requested_date, conversation_id, clinic_token_id, created_at, requeued_at, offer_count, offered_history, send_fail_count, clinic_tokens:clinic_token_id (token, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, user_id, waitlist_enabled)")
    .eq("status", "waiting")
    .limit(200);
  if (waitingErr) errorsDetail.push(`waiting query: ${waitingErr.message}`);

  const byClinic = new Map<string, any[]>();
  for (const w of (waiting || []) as any[]) {
    if (!w.clinic_tokens?.waitlist_enabled) continue; // flag desligada: fila dorme
    if (!byClinic.has(w.clinic_token_id)) byClinic.set(w.clinic_token_id, []);
    byClinic.get(w.clinic_token_id)!.push(w);
  }

  for (const [clinicId, entries] of byClinic) {
    try {
      const creds = entries[0].clinic_tokens;
      if (!creds?.token || !creds?.avanceai_base_url || !creds?.avanceai_api_id || !creds?.avanceai_bearer_token) continue;

      // Médicos com oferta ativa não recebem outra (1 vaga em jogo por vez).
      // 'accepted' (aceitou, efetivação pendente pela equipe — caso Felipe 19/07)
      // também bloqueia: a vaga está reivindicada, não pode ir pra um 3º.
      const { data: activeNotified } = await supabase
        .from("waitlist_entries")
        .select("doctor_id, status, expires_at")
        .eq("clinic_token_id", clinicId)
        .in("status", ["notified", "accepted"]);
      const busyDoctors = new Set(
        (activeNotified || [])
          .filter((r: any) => r.status === "accepted" || String(r.expires_at || "") >= nowIso)
          .map((r: any) => String(r.doctor_id)),
      );

      const doctorIds = Array.from(new Set(entries.map((w) => String(w.doctor_id)))).filter((d) => !busyDoctors.has(d));
      if (doctorIds.length === 0) continue;

      // 1 chamada de calendar por clínica cobre todos os médicos
      const companyId = String(decodeJwtPayload(creds.token).company_id ?? "");
      if (!companyId) continue;
      const places = (await amigoGet(`places?company_id=${companyId}`, creds.token)) as Array<Record<string, unknown>> | null;
      const events = (await amigoGet(`events?company_id=${companyId}`, creds.token)) as Array<Record<string, unknown>> | null;
      const placeId = Array.isArray(places) && places[0] ? String(places[0].id) : "";
      const consultaEvent = pickConsultaEvent(events || []);
      if (!placeId || !consultaEvent) continue;
      const calendar = (await amigoGet(
        `calendar?company_id=${companyId}&place_id=${placeId}&event_id=${consultaEvent.id}`,
        creds.token,
      )) as Array<{ date: string; slotsByUser?: Array<{ user?: { id?: number | string }; slots?: Array<{ start?: string }> }> }> | null;
      if (!Array.isArray(calendar) || calendar.length === 0) continue;

      const maxISO = addDaysISO(sp.todayISO, GOOD_SLOT_WINDOW_DAYS);
      // Slot de HOJE só com 90min+ de antecedência
      const minTimeToday = `${String(sp.hour + (sp.minute >= 30 ? 2 : 1)).padStart(2, "0")}:${String((sp.minute + 30) % 60).padStart(2, "0")}`;

      // Parser tolerante (auditoria 10/07): mesmas variantes de shape que o resto
      // do sistema aceita — date|day|data e start_time|startTime|start|time|hour|hora,
      // com HH:MM extraído por regex em qualquer posição (cobre "8:00" e ISO).
      const _dayDate = (d: any): string => String(d?.date || d?.day || d?.data || "").slice(0, 10);
      const _slotTime = (s: any): string => {
        const raw = String(s?.start_time || s?.startTime || s?.start || s?.time || s?.hour || s?.hora || "");
        const m = raw.match(/(\d{1,2}):(\d{2})/);
        return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
      };
      const days = (calendar as any[])
        .filter((d) => {
          const dd = _dayDate(d);
          return dd && dd >= sp.todayISO && dd <= maxISO;
        })
        .sort((a, b) => _dayDate(a).localeCompare(_dayDate(b)));

      for (const doctorId of doctorIds) {
        // Todas as vagas boas deste médico na janela, em ordem cronológica
        const goodSlots: Array<{ date: string; time: string }> = [];
        for (const day of days) {
          const dayDate = _dayDate(day);
          const slotsByUser = (day as any).slotsByUser || (day as any).slots_by_user || (day as any).SlotsByUser || [];
          for (const su of slotsByUser) {
            const suId = su?.user?.id ?? su?.user_id ?? su?.userId ?? "";
            if (String(suId) !== doctorId) continue;
            for (const s of su.slots || su.Slots || []) {
              const t = _slotTime(s);
              if (!t) continue;
              if (dayDate === sp.todayISO && t < minTimeToday) continue;
              goodSlots.push({ date: dayDate, time: t });
            }
          }
        }
        if (goodSlots.length === 0) continue;

        // Fila em ordem (expirar/recusar manda pro fim via requeued_at). O
        // PERÍODO PREFERIDO (10/07) filtra: manha < 12:00, tarde >= 12:00,
        // null = qualquer. A oferta vai para o PRIMEIRO da fila que tenha
        // alguma vaga casando com o período dele — ordem da fila respeitada.
        const queue = entries
          .filter((w) => String(w.doctor_id) === doctorId)
          .sort((a, b) => String(a.requeued_at || a.created_at).localeCompare(String(b.requeued_at || b.created_at)));
        // COOLDOWN por paciente (caso Marcia 20/07): numa fila de 1 pessoa, a oferta
        // expirada "repassa ao próximo" — que é ela mesma — e o ciclo re-oferta a cada
        // ~3h (3 ofertas + 3 avisos num dia = spam). Máx 1 oferta por paciente a cada
        // 20h: quem recebeu oferta recente é PULADO (se a fila só tem ele, fica em
        // silêncio até o cooldown passar).
        const OFFER_COOLDOWN_H = 20;
        const _cdCut = new Date(Date.now() - OFFER_COOLDOWN_H * 3600_000).toISOString();
        let _probes = 0;
        const MAX_TICKET_PROBES = 3;

        // ── ENVIO QUE FALHA NÃO É RECUSA DO PACIENTE (medido 05/08) ──────────
        // Em 05/08, às 07:00, 07:10, 07:20 e 07:30 (SP), quatro pacientes foram
        // mandados pro FIM DA FILA sem nenhum evento no histórico. Nenhum deles
        // tinha recebido mensagem: era a MESMA vaga (05/08 10:00) falhando no
        // envio quatro ciclos seguidos, logo na abertura do horário silencioso.
        // O caminho de falha fazia três coisas erradas de uma vez:
        //   1. gravava `requeued_at` — quem nunca foi avisado perdia a vez para
        //      quem tinha ignorado duas ofertas de verdade (era a Paula na 1ª
        //      posição enquanto Fernanda e Alexandre, que nunca receberam nada,
        //      caíam pro fim);
        //   2. deixava a vaga no `offered_history` mesmo sem ela ter saído —
        //      queimava aquele horário para sempre para aquele paciente, e foi
        //      por isso que a fila inteira ficou muda depois: a única vaga boa
        //      já constava como "oferecida" para os quatro;
        //   3. não escrevia evento nenhum — o dono via a fila embaralhar sem
        //      nenhuma linha no histórico explicando.
        // Agora: falha de envio NÃO mexe na posição, desfaz o registro da vaga,
        // aparece no histórico e a MESMA vaga é oferecida ao próximo da fila no
        // mesmo ciclo (o horário não se perde). Só depois de várias falhas
        // seguidas o paciente vai pro fim — que era a proteção original contra
        // número ruim travando a fila (auditoria 19/07), agora sem punir quem
        // caiu numa instabilidade momentânea.
        //
        // QUEDA DO AVANCEAI ≠ NÚMERO RUIM (confirmado pelo dono 06/08: "o sistema
        // de envio estava instável ontem pela manhã, o Avance não estava
        // funcionando"). Numa queda da plataforma TODO envio falha; contar isso
        // contra o paciente faria a fila inteira ser rebaixada em ~50 min e o
        // painel acusaria números BONS de estarem errados. Só conta contra o
        // paciente quando há prova de que a plataforma está de pé: **algum outro
        // envio deu certo no mesmo ciclo**. Sem essa prova, a falha é da
        // plataforma e o contador nem é tocado.
        const MAX_TENTATIVAS_DE_ENVIO = 2;
        const MAX_FALHAS_SEGUIDAS = 5;
        const _falharamAgora = new Set<string>();
        const _falhasDoCiclo: Array<{ entry: any; detalhe: string }> = [];
        let _enviouNesteCiclo = false;

        for (let _tent = 0; _tent < MAX_TENTATIVAS_DE_ENVIO; _tent++) {
        let first: any = null;
        let goodSlot: { date: string; time: string } | null = null;
        let target: { creds: SendCreds; channelId: string | null } | null = null;
        // ROTAÇÃO (queixa do dono 31/07): "já enviou várias vezes pra mesma, ela não
        // respondeu, deveria passar para o outro". A regra de 19/07 ("2ª chance")
        // mantinha quem não respondeu NA FRENTE — e como abre ~1 vaga por dia, ela
        // consumia uma vaga atrás da outra: Jandira levou 2 ofertas enquanto Matheus,
        // Paula, Fernanda e Alexandre nunca receberam nenhuma.
        // Agora a fila é varrida em DUAS PASSADAS: primeiro quem está com a vez limpa
        // (miss_count = 0); só se ninguém aí for elegível é que quem deixou passar
        // volta a concorrer. Assim a 2ª chance continua existindo (ela não vai pro fim
        // no 1º timeout, e recebe de novo quando a fila der a volta), mas a PRÓXIMA
        // vaga vai para o próximo — que é exatamente o que o dono pediu.
        // Fila de uma pessoa só: a 2ª passada garante que ela ainda recebe (as três
        // travas anti-spam — cooldown 20h, offered_history e MAX_OFFERS — seguem valendo).
        const _semFalta = queue.filter((w: any) => !(w.miss_count > 0));
        const _comFalta = queue.filter((w: any) => w.miss_count > 0);
        const _ordemDeBusca = [..._semFalta, ..._comFalta];
        if (_comFalta.length > 0 && _semFalta.length > 0) {
          console.log(
            `[Waitlist] rotação: ${_comFalta.map((w: any) => w.patient_name).join(", ")} deixou(aram) passar — a vez é de quem está atrás`,
          );
        }
        for (const cand of _ordemDeBusca) {
          // Já tentamos enviar para este candidato neste ciclo e falhou — a vaga
          // segue para o próximo em vez de morrer aqui.
          if (_falharamAgora.has(String(cand.id))) continue;
          const pref = String(cand.preferred_period || "");
          // A vaga TEM que ser antes da consulta-base do paciente — a fila ANTECIPA,
          // nunca empurra a consulta pra depois (ofertar um slot >= base remarcaria
          // pra mais tarde, o oposto do sentido da lista). Sem requested_date
          // (backfill faltou) não filtra por data. Puramente restritivo: só suprime
          // oferta ruim, nunca cria oferta errada.
          const baseDate = String(cand.requested_date || "").slice(0, 10);
          // MEMÓRIA DAS VAGAS JÁ OFERTADAS (caso Marcia 28/07): a MESMA vaga
          // (28/07 16:20) foi oferecida 4 dias seguidos, inclusive DEPOIS de ela
          // recusar. Sem esta memória, numa fila de uma pessoa só a vaga volta
          // eternamente. Oferecer de novo o que a pessoa já deixou passar é inútil.
          const _jaOfertadas = new Set(
            (Array.isArray(cand.offered_history) ? cand.offered_history : [])
              .map((h: any) => `${String(h?.date || "")} ${String(h?.time || "")}`),
          );
          const match = goodSlots.find((g) => {
            if (baseDate && g.date >= baseDate) return false;
            if (_jaOfertadas.has(`${g.date} ${g.time}`)) return false;
            return pref === "manha" ? g.time < "12:00" : pref === "tarde" ? g.time >= "12:00" : true;
          });
          if (!match) continue;
          const { data: _recentOffer } = await supabase
            .from("webhook_messages")
            .select("id")
            .eq("clinic_token_id", clinicId)
            .in("sender_phone", wlPhoneVariants(cand.phone))
            .eq("direction", "outgoing")
            .eq("ai_intent", "waitlist_offer")
            .gte("created_at", _cdCut)
            .limit(1);
          if (_recentOffer && _recentOffer.length > 0) {
            console.log(`[Waitlist] cooldown: ${cand.patient_name || cand.phone} já recebeu oferta nas últimas ${OFFER_COOLDOWN_H}h — pulando`);
            continue;
          }
          // ── CANAL e TICKET HUMANO: por CANDIDATO, não por médico ──────────────
          // Até 31/07 estas duas checagens ficavam DEPOIS do laço, e o `continue`
          // delas abortava o laço de MÉDICOS. Ou seja: se o 1º da fila estivesse sem
          // canal resolvível ou com atendente no ticket, NINGUÉM daquele médico
          // recebia oferta naquele ciclo — a fila inteira ficava parada atrás dele,
          // indefinidamente. É a explicação mais forte para o Matheus ter passado 9
          // dias com zero ofertas. Agora a falha pula o CANDIDATO e tenta o próximo.
          const _alvo = await resolveSendTarget(supabase, clinicId, cand.phone, creds);
          if (!_alvo) {
            errorsDetail.push(`sem canal resolvível p/ ...${String(cand.phone).slice(-4)} (${cand.doctor_name}) — próximo da fila`);
            continue;
          }
          // Teto de sondagens: cada checagem é uma chamada HTTP ao Z-PRO. Numa fila
          // grande com todo mundo em atendimento, não vale martelar a API.
          if (_probes >= MAX_TICKET_PROBES) {
            errorsDetail.push(`teto de ${MAX_TICKET_PROBES} sondagens de ticket (${cand.doctor_name}) — tenta no próximo ciclo`);
            break;
          }
          _probes++;
          // Humano ATIVO no ticket (open com agente real) -> não interfere; ticket
          // open órfão NÃO bloqueia (auditoria 10/07 — prendia pacientes pra sempre)
          const _humanoAtivo = await isTicketHumanActive(
            _alvo.creds.avanceai_base_url, _alvo.creds.avanceai_api_id, _alvo.creds.avanceai_bearer_token, cand.phone,
          );
          if (_humanoAtivo) {
            console.log(`[Waitlist] ${cand.id}: ticket open COM atendente — pulando para o próximo da fila`);
            errorsDetail.push(`skip ${String(cand.id).slice(0, 8)}: ticket com atendente — próximo da fila`);
            continue;
          }
          {
            first = cand;
            goodSlot = match;
            target = _alvo;
            break;
          }
        }
        if (!first || !goodSlot || !target) break;

        const nome = String(first.patient_name || "").trim().split(/\s+/)[0] || "";
        // Sem instrução do tipo responda/confirme + afirmativa (ver nota no topo do arquivo)
        const msg =
          `Boa notícia${nome ? `, ${nome}` : ""}! 🎉 Abriu uma vaga com *${first.doctor_name}*:\n\n` +
          `📅 ${formatDateLabelPt(goodSlot.date)} às *${goodSlot.time}*\n\n` +
          `Quer antecipar? Me diga *quero* dentro de 3 horas que eu remarco sua consulta para esse horário. ` +
          `Se preferir manter como está, me diga *não posso* que passo a vaga para o próximo da lista. 😊`;

        // Marca notified ANTES do envio (auditoria 10/07): se o update falhasse
        // após o envio, o paciente recebia a MESMA oferta a cada 10min. Se o
        // envio falhar, reverte para waiting.
        const expiresAt = new Date(Date.now() + OFFER_TTL_MIN * 60 * 1000).toISOString();
        // offered_history cresce a cada oferta — é o que impede a MESMA vaga de
        // voltar amanhã (caso Marcia 28/07). Gravado JUNTO do notified, no mesmo
        // update pré-envio, para não existir estado em que a oferta saiu sem ficar
        // registrada. Últimas 30 vagas bastam e limitam o tamanho da coluna.
        const _histAntes = Array.isArray(first.offered_history) ? first.offered_history : [];
        const _hist = _histAntes
          .concat([{ date: goodSlot.date, time: goodSlot.time }])
          .slice(-30);
        const { error: _updErr } = await supabase.from("waitlist_entries").update({
          status: "notified", offered_slot: goodSlot, notified_at: nowIso,
          expires_at: expiresAt, offer_count: (first.offer_count || 0) + 1,
          offered_history: _hist, updated_at: nowIso,
        }).eq("id", first.id);
        if (_updErr) {
          errors++;
          errorsDetail.push(`update pre-envio ${String(first.id).slice(0, 8)}: ${_updErr.message}`.slice(0, 180));
          break;
        }

        const send = await sendWhats(target.creds, first.phone, msg, target.channelId);
        if (!send.ok) {
          errors++;
          errorsDetail.push(
            `envio falhou p/ ...${String(first.phone).slice(-4)} (${first.doctor_name}) [${send.detail}] — mantém a posição`,
          );
          // Desfaz JÁ tudo o que o update pré-envio gravou: a oferta não existiu.
          // O `offered_history` volta ao que era — senão a vaga fica queimada e
          // ninguém mais pode recebê-la. Posição e contador ficam intocados aqui:
          // o veredito (plataforma x número) só sai no fim do ciclo.
          await supabase.from("waitlist_entries").update({
            status: "waiting", offered_slot: null, notified_at: null, expires_at: null,
            offer_count: first.offer_count || 0, offered_history: _histAntes,
            updated_at: nowIso,
          }).eq("id", first.id);
          _falhasDoCiclo.push({ entry: first, detalhe: String(send.detail || "") });
          _falharamAgora.add(String(first.id));
          continue;
        }
        _enviouNesteCiclo = true;
        if (first.send_fail_count) {
          await supabase.from("waitlist_entries")
            .update({ send_fail_count: 0 }).eq("id", first.id);
        }

        await supabase.from("webhook_messages").insert({
          clinic_token_id: clinicId, user_id: creds.user_id || null,
          sender_phone: first.phone, sender_name: first.patient_name || null,
          message_text: msg, direction: "outgoing",
          ai_intent: "waitlist_offer", action_status: "success",
          conversation_id: first.conversation_id,
          verified_schedule: true, // horário veio da agenda REAL do Amigo
        });
        offered++;
        await logWaitlistEvent(supabase, {
          clinic_token_id: clinicId, entry_id: first.id, conversation_id: first.conversation_id,
          phone: first.phone, patient_name: first.patient_name, doctor_name: first.doctor_name,
          event_type: "oferta_enviada",
          detail: `Vaga oferecida a ${first.patient_name || "paciente"}: ${first.doctor_name}, ${ddmm(goodSlot.date)} às ${goodSlot.time} — aguardando "quero" por até 3h.`,
        });
        console.log(`[Waitlist] oferta enviada: entry=${first.id} doctor=${first.doctor_name} slot=${goodSlot.date} ${goodSlot.time}`);
        break; // vaga entregue: encerra as tentativas deste médico neste ciclo
        }

        // ── VEREDITO DAS FALHAS DE ENVIO DESTE CICLO ────────────────────────
        // Com prova de que a plataforma está de pé (outro envio funcionou), a
        // falha é DAQUELE número e conta. Sem prova, é o AvanceAI fora do ar
        // (05/08 de manhã) — ninguém perde posição e o contador nem é tocado.
        if (_falhasDoCiclo.length > 0) {
          if (_enviouNesteCiclo) {
            for (const f of _falhasDoCiclo) {
              const _falhas = (f.entry.send_fail_count || 0) + 1;
              const _aoFim = _falhas >= MAX_FALHAS_SEGUIDAS;
              await supabase.from("waitlist_entries").update({
                send_fail_count: _aoFim ? 0 : _falhas,
                ...(_aoFim ? { requeued_at: nowIso } : {}),
                updated_at: nowIso,
              }).eq("id", f.entry.id);
              // Uma linha no começo do problema e outra quando desistimos —
              // não uma a cada 10 minutos.
              if (_falhas === 1 || _aoFim) {
                await logWaitlistEvent(supabase, {
                  clinic_token_id: clinicId, entry_id: f.entry.id, conversation_id: f.entry.conversation_id,
                  phone: f.entry.phone, patient_name: f.entry.patient_name, doctor_name: f.entry.doctor_name,
                  event_type: "envio_falhou",
                  detail: _aoFim
                    ? `Não consegui entregar a oferta a ${f.entry.patient_name || "paciente"} (${f.entry.doctor_name}) pela ${_falhas}ª vez seguida, e nesse meio-tempo o envio para outro paciente funcionou — mandei pro fim da fila para não travar os outros. Vale conferir o número.`
                    : `Não consegui entregar a oferta a ${f.entry.patient_name || "paciente"} (${f.entry.doctor_name}) — o envio para outro paciente funcionou, então parece ser o número dele. Mantém a posição; a vaga foi para o próximo.`,
                });
              }
            }
          } else {
            // Uma linha por queda, não uma por ciclo: se já avisamos nos últimos
            // 30 min, o painel não precisa da repetição.
            const { data: _jaAvisado } = await supabase
              .from("waitlist_events")
              .select("id")
              .eq("clinic_token_id", clinicId)
              .eq("event_type", "envio_instavel")
              .gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString())
              .limit(1);
            if (!_jaAvisado || _jaAvisado.length === 0) {
              const _quem = _falhasDoCiclo.map((f) => f.entry.patient_name || "paciente").join(", ");
              await logWaitlistEvent(supabase, {
                clinic_token_id: clinicId, entry_id: _falhasDoCiclo[0].entry.id,
                conversation_id: _falhasDoCiclo[0].entry.conversation_id,
                phone: _falhasDoCiclo[0].entry.phone, patient_name: _falhasDoCiclo[0].entry.patient_name,
                doctor_name: _falhasDoCiclo[0].entry.doctor_name,
                event_type: "envio_instavel",
                detail: `O WhatsApp não aceitou nenhum envio agora (${_quem}) — nenhuma oferta saiu. Ninguém perdeu a posição na fila e a vaga volta a ser oferecida no próximo ciclo. Detalhe: ${_falhasDoCiclo[0].detalhe}`.slice(0, 500),
              });
            }
            console.log(`[Waitlist] nenhum envio passou neste ciclo (${_falhasDoCiclo.length} falhas) — tratando como instabilidade da plataforma, sem punir ninguém`);
          }
        }
      }
    } catch (err) {
      console.error(`[Waitlist] clínica ${clinicId}:`, (err as Error).message);
      errors++;
      errorsDetail.push(`clinica ${String(clinicId).slice(0, 8)}: ${(err as Error).message}`.slice(0, 180));
    }
  }

  // ── 4) Nudge periódico "ainda sem vaga" a cada 2 dias (pedido 19/07) ────────
  // Só entries WAITING (as notified têm oferta ativa em jogo), na fila há 2+ dias
  // e sem nudge nas últimas 48h. É INFORMATIVO — sem verbo responda/confirme +
  // afirmativa (senão o orphan-ACK do webhook silenciaria uma resposta). Roda
  // depois das ofertas: quem virou notified neste ciclo já saiu de 'waiting'.
  const NUDGE_EVERY_DAYS = 2;
  const nudgeCutoff = new Date(Date.now() - NUDGE_EVERY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let nudged = 0;
  const { data: nudgeCandidates, error: nudgeErr } = await supabase
    .from("waitlist_entries")
    .select("id, phone, patient_name, doctor_name, conversation_id, clinic_token_id, last_nudge_at, clinic_tokens:clinic_token_id (avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, user_id, waitlist_enabled)")
    .eq("status", "waiting")
    .lt("created_at", nudgeCutoff)
    .limit(50);
  // 27/07: o aviso de 2 em 2 dias NUNCA disparou (0 na vida do sistema) e nem os
  // skips instrumentados apareciam — sinal de que o loop nem chega a rodar. Esta
  // consulta DESCARTAVA o erro (só `data` era lido): se ela falhasse, o resultado
  // era silêncio absoluto. Agora o erro e a contagem de candidatos vão para o
  // errors_detail (visível em net._http_response) — é o que falta para fechar o
  // diagnóstico no próximo ciclo.
  // Campo PRÓPRIO na resposta (errors_detail é cortado em 5 e pode encher antes).
  const nudgeDebug: string[] = [
    nudgeErr ? `query FALHOU: ${nudgeErr.message}`.slice(0, 160) : `candidatos=${(nudgeCandidates || []).length}`,
  ];

  for (const e of (nudgeCandidates || []) as any[]) {
    try {
      // Nudge só se NUNCA avisado OU último aviso há 2+ dias. Filtro em JS (não no
      // .or() do PostgREST): evita ambiguidade de sintaxe com o timestamp E o caso
      // IS NULL (um .lt no banco excluiria silenciosamente os never-nudged).
      // TODO SKIP É REGISTRADO (27/07): antes, três destes eram `continue` mudo —
      // com 7 candidatos válidos no banco o cron devolvia nudged=0 sem uma pista.
      const _tag = `...${String(e.phone).slice(-4)}`;
      if (e.last_nudge_at && new Date(e.last_nudge_at).getTime() >= new Date(nudgeCutoff).getTime()) {
        nudgeDebug.push(`${_tag}: avisado há menos de 2 dias`); continue;
      }
      const creds = e.clinic_tokens;
      if (!creds?.waitlist_enabled) { nudgeDebug.push(`${_tag}: waitlist_enabled=false`); continue; }
      if (!creds?.avanceai_base_url || !creds?.avanceai_api_id || !creds?.avanceai_bearer_token) {
        nudgeDebug.push(`${_tag}: clínica sem credenciais AvanceAI`); continue;
      }
      // Canal + credenciais do paciente (showticket e envio na sessão CERTA)
      const target = await resolveSendTarget(supabase, e.clinic_token_id, e.phone, creds);
      if (!target) { nudgeDebug.push(`${_tag}: sem canal resolvível`); continue; }
      // Não interrompe atendimento humano ativo (ticket open com agente real)
      const humanActive = await isTicketHumanActive(target.creds.avanceai_base_url, target.creds.avanceai_api_id, target.creds.avanceai_bearer_token, e.phone);
      if (humanActive) { nudgeDebug.push(`${_tag}: ticket humano ativo`); continue; }
      const nome = String(e.patient_name || "").trim().split(/\s+/)[0] || "";
      const msg =
        `Oi${nome ? `, ${nome}` : ""}! 👋 Passando pra avisar que você continua na nossa *lista de espera* do(a) ${e.doctor_name}. ` +
        `Ainda não abriu uma vaga mais cedo, mas seguimos tentando e te aviso aqui assim que surgir. ` +
        `Sua consulta marcada segue garantida, tá? 🙏`;
      // COMPARE-AND-SWAP antes do envio: carimba last_nudge_at só se AINDA estiver
      // null-ou-vencido. Se duas execuções do cron se sobrepuserem (uma passada com
      // muitos candidatos pode passar de 10min), a 2ª pega 0 linhas aqui e NÃO reenvia
      // — elimina nudge duplicado sob concorrência. Também trava re-nudge no ciclo
      // seguinte (last_nudge_at ≈ agora). Falha de envio espera o próximo ciclo de 48h.
      const { data: _claim } = await supabase
        .from("waitlist_entries")
        .update({ last_nudge_at: nowIso, updated_at: nowIso })
        .eq("id", e.id)
        .or(`last_nudge_at.is.null,last_nudge_at.lt.${nudgeCutoff}`)
        .select("id");
      if (!_claim || _claim.length === 0) { nudgeDebug.push(`${_tag}: claim perdido (outra execução avisou)`); continue; }
      const send = await sendWhats(target.creds, e.phone, msg, target.channelId);
      if (send.ok) {
        await supabase.from("webhook_messages").insert({
          clinic_token_id: e.clinic_token_id, user_id: creds.user_id || null,
          sender_phone: e.phone, sender_name: e.patient_name || null,
          message_text: msg, direction: "outgoing",
          ai_intent: "waitlist_nudge", action_status: "success",
          conversation_id: e.conversation_id,
        });
        nudged++;
        await logWaitlistEvent(supabase, {
          clinic_token_id: e.clinic_token_id, entry_id: e.id, conversation_id: e.conversation_id,
          phone: e.phone, patient_name: e.patient_name, doctor_name: e.doctor_name,
          event_type: "aviso_enviado",
          detail: `Aviso enviado a ${e.patient_name || "paciente"} (${e.doctor_name}): continua na fila, ainda sem vaga mais cedo (lembrete a cada 2 dias).`,
        });
      } else {
        nudgeDebug.push(`${_tag}: envio falhou [${send.detail}]`.slice(0, 160));
        errorsDetail.push(`nudge falhou p/ ...${String(e.phone).slice(-4)} [${send.detail}]`.slice(0, 180));
      }
    } catch (err) {
      console.error(`[Waitlist] nudge ${e.id}:`, (err as Error).message);
      errors++;
      errorsDetail.push(`nudge ${String(e.id).slice(0, 8)}: ${(err as Error).message}`.slice(0, 180));
    }
  }

  // errors_detail no corpo: consultável via net._http_response (logs instáveis).
  // nudge_debug tem campo próprio: o aviso de 2 em 2 dias nunca disparou e o
  // errors_detail (cortado em 5) podia encher antes de chegar nele.
  return new Response(
    JSON.stringify({
      expired: expiredCount, offered, nudged, reconciled, errors,
      errors_detail: errorsDetail.slice(0, 5),
      nudge_debug: nudgeDebug.slice(0, 10),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
