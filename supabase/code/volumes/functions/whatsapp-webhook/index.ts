import {
  URGENCY_PATTERNS,
  TRANSIENT_API_MESSAGE,
  AMIGO_AUTH_MESSAGE,
  firstName,
  stripAccents,
  getWeekday,
  mensagemFalaDeDia,
  diaDaSemanaPedido,
  formatDateLabel,
  buildColdOpenGreeting,
  buildLateHandoffMessage,
  addDaysToISO,
  nextOpenDayISO,
  buildClosedDayNotice,
  buildClosedDayHandoffMessage,
  HANDOFF_OFFER_ACCEPT_RE,
  buildWaitlistInvite,
  WAITLIST_KEYWORD_RE,
  WAITLIST_LEAVE_RE,
  parseWaitlistPeriod,
  WAITLIST_ACCEPT_RE,
  WAITLIST_DECLINE_RE,
  pickEventForBooking,
  detectUrgency,
  classificarUrgencia,
  campoPedidoNoCadastro,
  ehNegativaDeHorario,
  pedeQualquerData,
  classificarPedidoDeFisioterapia,
  PEDIDO_DE_ATENDENTE_RE,
  isClosingThanks,
  isValidCpf,
  isWeekendISO,
  casarConvenioNoTexto,
  extractCpfFromText,
  isTransientApiFailure,
  isAuthApiFailure,
  amigoFailReason,
  amigoAuthAlert,
  PROMESSA_DE_HUMANO_RE,
  decodeJwtPayload,
  getPhoneVariants,
  normalizeApiResponse,
  fetchWithTimeout,
} from "./helpers.ts";
import { tryFetch } from "./amigoApi.ts";
import { LLM_MODEL, LLM_MODEL_FALLBACK, LLM_GATEWAY, ehErroDeModeloDesconhecido, llmApiKey, llmHeaders, LLM_USAGE_INCLUDE, custoDaChamada } from "../_shared/llm.ts";
import { STT_ENDPOINT, STT_MODEL, STT_LANGUAGE, STT_RESPONSE_FORMAT, sttApiKey } from "../_shared/stt.ts";
import {
  AttendantUser,
  TransferResult,
  parseVacationNames,
  fetchOnlineAttendants,
  sendTypingIndicator,
  sendAvanceaiReply,
  checkTicketIsHumanOwned,
  transferTicketToHuman,
} from "./avanceai.ts";
import {
  sanitizeReply,
  containsScheduleTerms,
  validateScheduleTerms,
  validateBookingDate,
  isDuplicateReply,
  nearDuplicate,
  respostaFoiFalha,
} from "./guards.ts";
import {
  readPatientInsurance,
  describeInsuranceShape,
  isNegativeInsuranceClaim,
  isInsuranceRejection,
  matchInsuranceGroup,
  pickPlanFromGroup,
  toInsuranceId,
  validarAfirmacaoDeConvenio,
  textoDeConvenioNaoConfirmado,
  avaliarEfetivoIV,
  textoEfetivoIV,
  EFETIVO_IV_MEDICO,
} from "./insurance.ts";
// @ts-nocheck
// TODO(FASE 2): remove this directive and address ~50 structural TS errors
// (extra fields on inferred ActionResult shape: patientName, entities, schedulingContext,
// patientAlreadyBookedThisSlot, reply, internal_instruction, bypassAiRewrite; missing
// entity props: reagendar_confirmed, patient_address; media payload mediaType/mediaKey).
// Deferred from this pass to avoid coupling the urgent runtime fix (internal-instruction
// leak) with a multi-hour type refactor.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// A conversa recente tratou de INFILTRAÇÃO? (regra do dono, 28/07: o robô nunca
// agenda infiltração — sempre passa por uma atendente, por causa da documentação).
// Olha o intent das mensagens recentes (coluna ai_intent OU o marcador
// <!-- intent=X --> embutido no conteúdo, que é como o histórico chega aqui) e
// também o texto, para pegar o caso em que a atendente ou o paciente escreveram
// "infiltra*" sem que aquilo tenha virado intent.
// PURA LEITURA: na dúvida devolve false e o fluxo segue normal.
// Texto que o PACIENTE escreveu — mensagem atual mais o histórico recente dele.
// O plano quase nunca vem na mesma mensagem da queixa: ele diz "Bradesco Efetivo
// IV" num turno e "dor no ombro" no seguinte.
function textoDoPacienteRecente(mensagemAtual: unknown, mensagensRecentes: unknown): string {
  const partes: string[] = [String(mensagemAtual || "")];
  try {
    const lista = Array.isArray(mensagensRecentes) ? mensagensRecentes : [];
    for (const m of lista.slice(-10)) {
      const msg = m as Record<string, unknown>;
      const papel = String(msg.role || msg.direction || "");
      if (papel === "assistant" || papel === "outgoing") continue; // só o que ELE disse
      partes.push(String(msg.content || msg.message_text || ""));
    }
  } catch { /* histórico ilegível: fica só a mensagem atual */ }
  return partes.join("\n");
}

function temContextoDeInfiltracao(mensagensRecentes: unknown): boolean {
  try {
    const lista = Array.isArray(mensagensRecentes) ? mensagensRecentes : [];
    for (const m of lista) {
      const msg = m as Record<string, unknown>;
      const conteudo = typeof msg.content === "string" ? msg.content : "";
      const intent =
        (typeof msg.ai_intent === "string" ? msg.ai_intent : "") ||
        (conteudo.match(/<!--\s*intent=(\w+)/)?.[1] ?? "");
      if (intent === "solicitar_infiltracao") return true;
      const status = typeof msg.action_status === "string" ? msg.action_status : "";
      if (status === "transferred_infiltracao" || status === "needs_documents_infiltracao") return true;
      const texto = stripAccents(String(conteudo || msg.message_text || "").toLowerCase());
      if (/\binfiltra/.test(texto)) return true;
    }
  } catch { /* na dúvida, não bloqueia */ }
  return false;
}

// Nomes fora do rodízio HOJE = lista de férias (custom_notes, texto livre do dono)
// + ausências do dia marcadas no painel (tabela attendant_absences, toggle que a
// própria atendente liga). Nasceu do caso Lidiane (27/07): 9 pacientes encaminhados
// para quem não veio trabalhar, porque o online/offline do Z-PRO diz que a equipe
// inteira está sempre disponível. Esta é a alavanca determinística.
// Falha de leitura NUNCA tira ninguém do rodízio — devolve só a lista de férias.
// QUEDA AUTOMÁTICA DE MODELO (16/08). O id do modelo subiu para o Gemini 3.7 Flash,
// lançado em 13/08. Quando isso foi feito, o gateway do Lovable ainda anunciava o
// 3.6 Flash como padrão e não deu para confirmar que já servia o 3.7.
//
// Se o gateway recusar o id, esta função tenta UMA vez com o modelo que roda hoje,
// em vez de deixar o paciente sem resposta. Só troca quando o erro é de MODELO
// DESCONHECIDO: cota estourada (429) e queda do gateway (5xx) sobem como sempre,
// porque trocar de modelo ali só esconderia o problema de verdade.
async function postLLM(init: RequestInit, timeoutMs: number): Promise<Response> {
  const resposta = await fetchWithTimeout(LLM_GATEWAY, init, timeoutMs);
  if (resposta.ok) return resposta;

  const corpo = await resposta.clone().text();
  if (!ehErroDeModeloDesconhecido(resposta.status, corpo)) return resposta;

  console.error(
    `[LLM] gateway recusou "${LLM_MODEL}" (${resposta.status}) — repetindo com "${LLM_MODEL_FALLBACK}". ` +
      `Se isto aparecer no log, o gateway ainda não serve o modelo novo: troque a variável LLM_MODEL.`,
  );
  let bodyFallback = String(init.body || "");
  try {
    const parsed = JSON.parse(bodyFallback);
    parsed.model = LLM_MODEL_FALLBACK;
    bodyFallback = JSON.stringify(parsed);
  } catch {
    bodyFallback = bodyFallback.split(LLM_MODEL).join(LLM_MODEL_FALLBACK);
  }
  return await fetchWithTimeout(LLM_GATEWAY, { ...init, body: bodyFallback }, timeoutMs);
}

async function nomesForaDoRodizio(
  client: any,
  clinicTokenId: string | null,
  customNotes?: string | null,
): Promise<string[]> {
  const ferias = parseVacationNames(customNotes);
  if (!client || !clinicTokenId) return ferias;
  try {
    const hoje = getTodayISO_SP();
    const { data } = await client
      .from("attendant_absences")
      .select("attendant_name")
      .eq("clinic_token_id", clinicTokenId)
      .eq("absent_date", hoje);
    const ausentes = (data || [])
      .map((r: any) => stripAccents(String(r.attendant_name || "").trim().toLowerCase()))
      .filter(Boolean);
    if (ausentes.length > 0) {
      console.log(`[Rodizio] fora HOJE (${hoje}): ${ausentes.join(", ")}`);
    }
    return [...ferias, ...ausentes];
  } catch (e) {
    console.log(`[Rodizio] leitura de ausências falhou (non-blocking): ${(e as Error).message}`);
    return ferias;
  }
}

// ── Log de atividade da lista de espera (pedido 22/07) ──
// Registra as ações do bot na fila (entrou, aceitou, recusou) num audit legível
// (tabela waitlist_events) que o painel mostra como "histórico da fila". Gêmeo do
// helper de mesmo nome no cron process-waitlist. NUNCA quebra o fluxo: qualquer
// erro de log é engolido — a ação (entrar/reagendar) é o que importa.
async function logWaitlistEventWH(
  client: any,
  ev: {
    clinic_token_id: string; entry_id?: string | null; conversation_id?: string | null;
    phone?: string | null; patient_name?: string | null; doctor_name?: string | null;
    event_type: string; detail: string;
  },
): Promise<void> {
  try {
    if (!client || !ev?.clinic_token_id) return;
    await client.from("waitlist_events").insert({
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
    console.log(`[Waitlist] log de evento (webhook) falhou (non-blocking): ${(e as Error).message}`);
  }
}
// "YYYY-MM-DD" -> "DD/MM" sem criar Date (sem risco de fuso), pro texto do log.
function ddmmWH(iso: string | null | undefined): string {
  const [, m, d] = String(iso || "").split("-");
  return d && m ? `${d}/${m}` : String(iso || "");
}

// ── AI Usage Logging ──
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "google/gemini-3-flash-preview": { input: 0.15 / 1e6, output: 0.6 / 1e6 },
  "google/gemini-3.7-flash": { input: 0.75 / 1e6, output: 3.75 / 1e6 },
  "google/gemini-3.6-flash": { input: 0.75 / 1e6, output: 3.75 / 1e6 },
  "google/gemini-2.5-flash": { input: 0.15 / 1e6, output: 0.6 / 1e6 },
  "google/gemini-2.5-flash-lite": { input: 0.075 / 1e6, output: 0.3 / 1e6 },
  "google/gemini-2.5-pro": { input: 1.25 / 1e6, output: 10.0 / 1e6 },
  "google/gemini-3.1-pro-preview": { input: 1.25 / 1e6, output: 10.0 / 1e6 },
};

function logAiUsage(
  clinicTokenId: string | null,
  functionName: string,
  model: string,
  usage: any,
  precomputedCostUsd?: number,
) {
  if (!clinicTokenId) {
    console.warn(`[AI Usage Log] Skipped — no clinicTokenId for ${functionName} / ${model}`);
    return;
  }
  if (!usage && precomputedCostUsd === undefined) return;

  const pricing = MODEL_PRICING[model] || { input: 0.5 / 1e6, output: 1.5 / 1e6 };
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const totalTokens = usage?.total_tokens || promptTokens + completionTokens;
  const cost =
    precomputedCostUsd !== undefined
      ? precomputedCostUsd
      : promptTokens * pricing.input + completionTokens * pricing.output;

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, key);
  admin
    .from("ai_usage_logs")
    .insert({
      clinic_token_id: clinicTokenId,
      function_name: functionName,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: cost,
    })
    .then(({ error }) => {
      if (error) console.error("[AI Usage Log] insert error:", error.message);
    });
}

// Groq Whisper pricing: $0.04/hour ≈ $0.00001111 per second
const GROQ_WHISPER_COST_PER_SECOND = 0.04 / 3600;
function logWhisperUsage(clinicTokenId: string | null, durationSeconds: number) {
  if (!clinicTokenId || !durationSeconds || durationSeconds <= 0) return;
  const cost = durationSeconds * GROQ_WHISPER_COST_PER_SECOND;
  logAiUsage(clinicTokenId, "whatsapp-webhook/transcribe", "groq/whisper-large-v3-turbo", null, cost);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── fetch com timeout (AbortController) ──
// As chamadas ao gateway LLM (Lovable/Gemini) e ao Groq Whisper nao tinham
// nenhum teto de latencia: um upstream travado deixava o request pendurado ate
// o wall-clock do Supabase matar a invocacao (p99 de ~548s no relatorio 23/06).
// Este helper espelha o padrao ja usado em tryFetch/AvanceAI e garante um corte.

// Helper: extract first name from full name

// Tema 5 (relatorio 24/06 Amostra 3): paciente em alagamento + canal desabilitado
// foi SILENCIADO. O detector de urgencia rodava 1400 linhas depois do guard de
// canal, entao nunca era atingido. Helper compartilhado pra rodar a deteccao
// em multiplos pontos (canal off, ai_disabled, etc) sem duplicar regex.

// FIX (crash latente — reagendar Step 3&4 e cancelar multi-agendamento): o codigo
// chamava getWeekday()/formatDateLabel() que NAO existiam em lugar nenhum do
// arquivo -> ReferenceError assim que o fluxo de reagendamento confirmado buscava
// slots. Implementados no MESMO formato das 4 copias inline ("DD/MM (dia-semana)"),
// que o parser slot-match-from-offer e o guard anti-alucinacao ja esperam.

// Tipo de consulta (bug 01/07): a clinica tem eventos como "Primeira Consulta" e
// "Consulta", e o codigo usava sempre events[0] — TODO agendamento saia como
// "Primeira Consulta" (ordem da API). Regra de negocio: paciente JA cadastrado ->
// consulta normal (nome com "consulta" e SEM "primeira"); paciente NOVO (fluxo de
// cadastro) -> "primeira consulta" se existir. Fallback: primeiro evento.

// ── Canonical clock helpers (America/Sao_Paulo via Intl.DateTimeFormat) ──
function getNowSPParts(): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  weekdayName: string;
} {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: new Date(Number(get("year")), Number(get("month")) - 1, Number(get("day"))).getDay(),
    weekdayName: get("weekday"),
  };
}

function getTodayISO_SP(): string {
  const p = getNowSPParts();
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function getNowSP(): Date {
  const p = getNowSPParts();
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
}

function formatNowSPHuman(): string {
  const p = getNowSPParts();
  return `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}/${p.year} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}, ${p.weekdayName}`;
}

// ─── Feriados/dias fechados (clinic_closed_days) ─────────────────────────────
// Cache curto por clínica. closedToday + motivo + data de reabertura (próximo
// dia útil que não está na lista) + conjunto de datas fechadas futuras,
// usado também para bloquear agendamento PARA um dia fechado.
//
// A JANELA TEM QUE COBRIR A AGENDA, NÃO UM NÚMERO REDONDO (30/08).
// Eram 45 dias. A agenda que o Amigo devolve hoje vai a 92 (31/08 → 30/11), então
// tudo que estivesse cadastrado entre o 46º e o 92º dia simplesmente não entrava
// no closedSet — e o bloqueio de agendamento não disparava. Descoberto na hora de
// cadastrar os feriados do fim do ano: Finados cai a 64 dias daqui, Natal a 117.
// O paciente pediria 02/11, o guard não veria nada e a consulta seria marcada num
// dia de clínica fechada.
//
// 210 dias cobre a agenda inteira com folga e ainda alcança o Carnaval do ano que
// vem. O custo é nenhum: são poucas linhas por clínica, e o cache de 60s continua
// absorvendo a leitura.
const JANELA_DIAS_FECHADOS = 210;
type ClosedDayInfo = { closedToday: boolean; reason: string; reopenISO: string; closedSet: Set<string> };
const _closedDaysCache = new Map<string, { info: ClosedDayInfo; exp: number }>();
async function getClosedDayInfo(sb: any, clinicId: string | null | undefined): Promise<ClosedDayInfo> {
  const empty: ClosedDayInfo = { closedToday: false, reason: "", reopenISO: "", closedSet: new Set() };
  if (!sb || !clinicId) return empty;
  const hit = _closedDaysCache.get(clinicId);
  if (hit && hit.exp > Date.now()) return hit.info;
  try {
    const today = getTodayISO_SP();
    const { data } = await sb
      .from("clinic_closed_days")
      .select("closed_date, reason")
      .eq("clinic_token_id", clinicId)
      .gte("closed_date", today)
      .lte("closed_date", addDaysToISO(today, JANELA_DIAS_FECHADOS));
    const rows = Array.isArray(data) ? data : [];
    const closedSet = new Set<string>(rows.map((r: any) => String(r.closed_date).slice(0, 10)));
    const todayRow = rows.find((r: any) => String(r.closed_date).slice(0, 10) === today);
    const info: ClosedDayInfo = todayRow
      ? {
          closedToday: true,
          reason: String((todayRow as any).reason || ""),
          reopenISO: nextOpenDayISO(today, [...closedSet]),
          closedSet,
        }
      : { closedToday: false, reason: "", reopenISO: "", closedSet };
    _closedDaysCache.set(clinicId, { info, exp: Date.now() + 60_000 });
    return info;
  } catch (e) {
    console.log(`[ClosedDays] load error (non-blocking): ${(e as Error).message}`);
    return empty;
  }
}

// ─── URL do widget de agendamento por clínica (cache 5min) ──────────────────
// Usada como caminho alternativo SEMPRE disponível (pedido 10/07: toda resposta
// deve dar a opção de marcar — inclusive quando o Amigo está instável).
// ── CARÊNCIA DE CONVÊNIO — REMOVIDA (16/08) ─────────────────────────────────
// Aqui ficava a regra "o convênio só paga retorno após N dias da última consulta".
// Removida a pedido do dono; a função getInsuranceReturnGate logo abaixo é no-op.

// Nome do GRUPO a partir do id do PLANO do paciente (cache 10min por empresa).
//
// Por que isto existe: as regras de retorno são escritas por GRUPO ("SUL AMERICA",
// "BRADESCO"), mas o paciente tem gravado o id do PLANO ("PLANO ESPECIAL 100").
// A busca antiga procurava o id do plano dentro da lista de GRUPOS — nunca achava,
// o nome saía vazio e a regra devolvia null. Eram 8 regras cadastradas e UM único
// disparo em toda a vida do sistema: a regra existia no painel e não valia nada.
// Agora monta-se o mapa plano→grupo uma vez a cada 10 min (1 chamada de grupos +
// 1 por grupo) e o id do plano encontra a regra do grupo dele.
const _insGroupNameCache = new Map<string, { mapa: Map<string, string>; exp: number }>();
async function resolveInsuranceGroupName(
  amigoToken: string,
  companyId: string,
  insuranceId: string | number,
): Promise<string> {
  const alvo = String(insuranceId);
  let cached = _insGroupNameCache.get(companyId);
  if (!cached || cached.exp < Date.now()) {
    const mapa = new Map<string, string>();
    const gRes = await tryFetch(`insurances?company_id=${companyId}`, amigoToken);
    const grupos = (normalizeApiResponse(gRes) as Array<Record<string, unknown>>) || [];
    for (const g of Array.isArray(grupos) ? grupos : []) {
      const nome = String(g.name || g.nome || "");
      if (!nome) continue;
      // o próprio id do grupo também resolve (widget e cadastros antigos gravam grupo)
      mapa.set(String(g.id), nome);
      try {
        const pRes = await tryFetch(`insurances/plans/${g.id}?company_id=${companyId}`, amigoToken);
        const planos = (normalizeApiResponse(pRes) as Array<Record<string, unknown>>) || [];
        for (const p of Array.isArray(planos) ? planos : []) {
          if (p?.id !== undefined && p?.id !== null) mapa.set(String(p.id), nome);
        }
      } catch (e) {
        console.log(`[ReturnGate] planos do grupo ${nome} falharam: ${(e as Error).message}`);
      }
    }
    cached = { mapa, exp: Date.now() + 10 * 60_000 };
    _insGroupNameCache.set(companyId, cached);
    console.log(`[ReturnGate] mapa plano→grupo montado: ${mapa.size} ids`);
  }
  return cached.mapa.get(alvo) || "";
}
async function getInsuranceReturnGate(
  sb: any,
  clinicTokenId: string | null | undefined,
  amigoToken: string,
  companyId: string,
  patientId: string | number | null | undefined,
  insuranceId: string | number | null | undefined,
): Promise<{ minDateISO: string; label: string; lastISO: string; days: number } | null> {
  // CARÊNCIA DE CONVÊNIO REMOVIDA DE VEZ (16/08). Decisão do dono, textual:
  // "aquela regra que limita a marcação de 15 dias de um, 30 dias do outro — vamos
  // tirar essa regra de carência do convênio. Não quero que funcione mais nada."
  //
  // Histórico curto: criada em 22/07, nunca funcionou de verdade (comparava id de
  // PLANO contra lista de GRUPOS), foi consertada em 06/08 e aí começou a empurrar
  // a data do paciente EM SILÊNCIO — o pedido original era nunca contar da carência.
  // Empurrar data sem poder explicar é o que gerou a reclamação. Em 11/08 as regras
  // saíram da tabela; ainda assim o gate disparou em 6 conversas até 15/08, porque
  // desligar pelo DADO não impede recadastro pelo painel. Agora está desligado pelo
  // CÓDIGO: esta função não lê tabela nenhuma e não tem como voltar a valer.
  //
  // Mantida como no-op (em vez de apagada) porque três caminhos de agendamento a
  // chamam e todos já tratam `null` como "sem restrição" — é o caminho com menos
  // risco de mexer no fluxo de marcação. As 8 regras antigas continuam guardadas em
  // `insurance_return_rules_desativadas` caso um dia se queira o histórico.
  return null;
}

function _fmtBR(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

// BASE DO LINK DO WIDGET (28/08). Era `https://schedulo-migo.lovable.app`
// hardcoded em dois lugares. A clínica está saindo do Lovable, e um fallback
// apontando para um app que vai ser desligado é uma bomba-relógio: só aparece
// quando `widget_config.custom_url` faltar, que é justamente o dia ruim.
// WIDGET_BASE_URL troca sem deploy.
const WIDGET_BASE_URL =
  (typeof (globalThis as any).Deno !== "undefined"
    ? String((globalThis as any).Deno.env.get("WIDGET_BASE_URL") || "")
    : "") || "https://juliacbt.cbthub.com.br";

const _widgetUrlCache = new Map<string, { url: string; exp: number }>();
async function getWidgetUrl(sb: any, clinicId: string | null | undefined): Promise<string> {
  if (!sb || !clinicId) return "";
  const hit = _widgetUrlCache.get(clinicId);
  if (hit && hit.exp > Date.now()) return hit.url;
  try {
    const { data } = await sb
      .from("booking_widgets")
      .select("widget_key, widget_config")
      .eq("clinic_token_id", clinicId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    const cfg = (data as any)?.widget_config as Record<string, unknown> | null;
    const url = data
      ? cfg?.custom_url
        ? String(cfg.custom_url)
        : `${WIDGET_BASE_URL}/agendar/${(data as any).widget_key}`
      : "";
    _widgetUrlCache.set(clinicId, { url, exp: Date.now() + 5 * 60_000 });
    return url;
  } catch {
    return "";
  }
}

// ─── Lista de espera: flag por clínica (clinic_tokens.waitlist_enabled) ─────
// Cache curto por instância pra não re-consultar a flag a cada oferta de slots.
const _waitlistFlagCache = new Map<string, { v: boolean; exp: number }>();
async function isWaitlistEnabled(sb: any, clinicId: string | null | undefined): Promise<boolean> {
  if (!sb || !clinicId) return false;
  const hit = _waitlistFlagCache.get(clinicId);
  if (hit && hit.exp > Date.now()) return hit.v;
  try {
    const { data } = await sb.from("clinic_tokens").select("waitlist_enabled").eq("id", clinicId).maybeSingle();
    const v = Boolean(data?.waitlist_enabled);
    _waitlistFlagCache.set(clinicId, { v, exp: Date.now() + 60_000 });
    return v;
  } catch {
    return false;
  }
}

// ─── O "Quero" que morria porque a atendente estava no ticket (19/08) ───────
// O guard de humano ativo devolve 200 e ENCERRA a request antes de qualquer
// lógica de lista de espera. Consequência medida na auditoria: 3 dos 7 aceites
// desde 19/07 (<paciente> 27/07, Alexandre 07/08, Ana 10/08) ficaram
// `skipped` e ninguém no sistema soube que o paciente tinha dito "quero" — e 3h
// depois o cron ainda mandava "não deu tempo de confirmar".
//
// A exceção pedida pelo dono é ESTREITA de propósito: aqui a Julia só REGISTRA
// a resposta e continua calada. Ela não responde, não agenda e não toma a
// conversa da atendente — quem decide o que fazer é o cron, 15 minutos depois,
// olhando a agenda real (se a atendente já agendou, ele não faz nada).
//
// Aceite → status 'accepted' + accepted_at (a vaga fica reservada: o cron não
//          oferece a mesma vaga a um terceiro enquanto estiver 'accepted').
// Recusa → volta pro fim da fila AGORA, para a vaga andar e para o paciente não
//          receber depois um "não deu tempo" tendo respondido (caso Rose 14/08).
async function registrarRespostaDeVagaSobAtendente(
  sb: any,
  clinicId: string | null | undefined,
  phone: string | null | undefined,
  texto: string | null | undefined,
): Promise<"aceite" | "recusa" | ""> {
  const t = String(texto || "").trim();
  if (!sb || !clinicId || !phone || !t) return "";
  // MESMO crivo do guard [WaitlistReply] do fluxo normal: recusa testa primeiro
  // ("não quero" contém "quero"), aceite é curto e sem dígitos ("quero marcar
  // dia 12 às 15h" é outra intenção e não pode virar aceite silencioso).
  const recusa = WAITLIST_DECLINE_RE.test(t) && t.length <= 60;
  const aceite = !recusa && WAITLIST_ACCEPT_RE.test(t) && t.length <= 40 && !/\d/.test(t);
  if (!aceite && !recusa) return "";
  try {
    const { data: pend } = await sb
      .from("waitlist_entries")
      .select("id, status, offered_slot, doctor_name, patient_name, conversation_id")
      .eq("clinic_token_id", clinicId)
      .in("phone", getPhoneVariants(phone))
      .in("status", ["notified", "waiting"])
      .order("updated_at", { ascending: false })
      .limit(1);
    const entry = pend?.[0] as any;
    if (!entry?.offered_slot?.date || !entry?.offered_slot?.time) return "";
    // Prova de que existiu oferta recente PARA ESTE TELEFONE (mesma janela de 12h
    // do fluxo normal, que cobre o TTL de 3h + aceite tardio). Sem isso, um "sim"
    // solto respondendo a atendente viraria aceite de vaga.
    const desde = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const { data: houveOferta } = await sb
      .from("webhook_messages")
      .select("ai_intent")
      .eq("clinic_token_id", clinicId)
      .in("sender_phone", getPhoneVariants(phone))
      .eq("direction", "outgoing")
      .eq("ai_intent", "waitlist_offer")
      .gte("created_at", desde)
      .limit(1);
    if (!houveOferta || houveOferta.length === 0) return "";

    const agora = new Date().toISOString();
    if (recusa) {
      await sb.from("waitlist_entries").update({
        status: "waiting", notified_at: null, expires_at: null,
        requeued_at: agora, miss_count: 0, updated_at: agora,
      }).eq("id", entry.id);
      await logWaitlistEventWH(sb, {
        clinic_token_id: String(clinicId), entry_id: entry.id, conversation_id: entry.conversation_id,
        phone, patient_name: entry.patient_name, doctor_name: entry.doctor_name,
        event_type: "oferta_recusada",
        detail: `${entry.patient_name || "Paciente"} recusou a vaga com ${entry.doctor_name} (a atendente estava no ticket, então eu só anotei e não respondi) — a vaga vai pro próximo.`,
      });
      console.log(`[WaitlistSobAtendente] recusa registrada em silêncio — entry ${entry.id}`);
      return "recusa";
    }
    await sb.from("waitlist_entries").update({
      status: "accepted", accepted_at: agora, updated_at: agora,
    }).eq("id", entry.id);
    await logWaitlistEventWH(sb, {
      clinic_token_id: String(clinicId), entry_id: entry.id, conversation_id: entry.conversation_id,
      phone, patient_name: entry.patient_name, doctor_name: entry.doctor_name,
      event_type: "oferta_aceita",
      detail: `${entry.patient_name || "Paciente"} ACEITOU a vaga de ${entry.offered_slot.date} às ${entry.offered_slot.time} com ${entry.doctor_name}. A atendente está no ticket, então não respondi nada — vou conferir a agenda em 15 min e só mexo se ninguém tiver agendado.`,
    });
    console.log(`[WaitlistSobAtendente] ✅ aceite registrado em silêncio — entry ${entry.id}`);
    return "aceite";
  } catch (e) {
    console.log(`[WaitlistSobAtendente] falhou (non-blocking): ${(e as Error).message}`);
    return "";
  }
}

// ── Date/time canonicalization helpers (BUG-1 FIX) ──
// Used to guarantee that any value flowing through the booking pipeline
// (entities.date/time, start_date sent to Amigo, target_date in pending_booking_verifications,
// and the comparison done by verify-booking) is in the same canonical format.
// LLMs sometimes return dd/mm/yyyy even when instructed to return YYYY-MM-DD; the Amigo API
// echoes start_date back in whatever format we sent. Both halves must be normalized so the
// post-booking verification can find the appointment it just created.

/** Normalize a date string to canonical YYYY-MM-DD. Returns "" if unparseable.
 *  Supports partial dates like "YYYY-MM" (month only) → defaults to 1st of month. */
function normalizeDateToISO(input: string): string {
  if (!input) return "";
  const s = String(input).trim();
  // Already ISO (YYYY-MM-DD or YYYY/MM/DD)
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Partial date: YYYY-MM (no day) → default to 1st of month
  const partialMatch = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (partialMatch) {
    const [, y, m] = partialMatch;
    console.log(`[normalizeDateToISO] Partial date detected: "${s}" → defaulting to 1st of month`);
    return `${y}-${m.padStart(2, "0")}-01`;
  }
  // Brazilian DD/MM/YYYY or DD-MM-YYYY
  const brMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (brMatch) {
    const [, d, m, y] = brMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Brazilian short DD/MM (no year) — assume current year in São Paulo timezone
  const shortBrMatch = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (shortBrMatch) {
    const [, d, m] = shortBrMatch;
    const year = getNowSPParts().year;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return "";
}

/** Check if the original date input was a partial (month-only) date like "YYYY-MM". */
function isPartialDate(input: string): boolean {
  if (!input) return false;
  return /^\d{4}[-/]\d{1,2}$/.test(String(input).trim());
}

/** Normalize a string for accent-insensitive, plural-insensitive matching. */
function normalizeForMatching(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/s$/, ""); // strip trailing 's' for simple plural handling
}

/** Normalize a time string to canonical HH:mm. Returns "" if unparseable. */
function normalizeTimeToHHMM(input: string): string {
  if (!input) return "";
  const m = String(input)
    .trim()
    .match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/**
 * Robust extraction of {date, time} from a start_date in ANY common format the Amigo API might echo:
 *   "2026-04-09 14:30:00", "2026-04-09T14:30:00Z", "2026-04-09T14:30:00-03:00",
 *   "09/04/2026 14:30", "2026-04-09 14:30", etc.
 * Returns canonical {date: "YYYY-MM-DD", time: "HH:mm"} or empty strings if it cannot parse.
 */
function extractDateAndTime(startDateStr: string): { date: string; time: string } {
  if (!startDateStr) return { date: "", time: "" };
  const s = String(startDateStr).trim();
  // ISO-style "YYYY-MM-DD[T ]HH:mm"
  const isoMatch = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (isoMatch) {
    const [, y, mo, d, h, mi] = isoMatch;
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  }
  // Brazilian "DD/MM/YYYY HH:mm"
  const brMatch = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (brMatch) {
    const [, d, mo, y, h, mi] = brMatch;
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  }
  // Last-resort: split on "T" or whitespace and normalize each half
  const parts = s.split(/[T ]/);
  return {
    date: normalizeDateToISO(parts[0] || ""),
    time: normalizeTimeToHHMM(parts[1] || ""),
  };
}

// Deterministic detector: is the user asking what day/time it is right now?
function isCurrentDateTimeQuestion(msg: string): boolean {
  const lower = msg
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const patterns = [
    /que\s*hora/i,
    /que\s*horas/i,
    /qual\s*hor[aá]rio/i,
    /que\s*dia\s*(e|é|eh)?\s*hoje/i,
    /qual\s*(o\s*)?dia\s*(de\s*)?hoje/i,
    /dia\s*e\s*hor[aá]rio/i,
    /data\s*e\s*hora/i,
    /hora\s*certa/i,
    /que\s*dia\s*(eh|e|é)\s*(agora|este)/i,
    /hor[aá]rio\s*agora/i,
    /que\s*data/i,
    /qual\s*a?\s*data\s*de?\s*hoje/i,
  ];
  return patterns.some((p) => p.test(lower));
}

function buildClockAnswer(): string {
  const p = getNowSPParts();
  return `Agora são ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} de ${p.weekdayName}, ${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}/${p.year}. Como posso te ajudar? 😊`;
}


// Tema 3 (relatorio 23/06): distingue FALHA TRANSITORIA da API (Amigo fora do ar,
// timeout, 5xx — tryFetch devolve o sentinel 502 quando esgota os retries) de um
// "nao encontrado" legitimo (2xx sem id / 404). Antes, qualquer status>=400 era
// tratado como "Paciente nao encontrado", entao numa queda do Amigo o paciente real
// era informado que o CPF dele nao existe. Use este helper para responder
// "sistema instavel, tente em instantes" em vez de negar o cadastro.

// Licao do incidente 02/07: o token do Amigo foi invalidado e TODAS as chamadas
// voltavam 401 — que caia no mesmo balde de "CPF nao encontrado" (401 < 500).
// Pacientes reais ouviram "seu CPF nao existe" por ~36h e NINGUEM foi alertado.
// 401/403 = problema de INTEGRACAO (token), nunca culpa do paciente.


// Extract message fields from various webhook payload formats (Uazapi V2 + Evolution API)
function extractMessageFields(payload: Record<string, unknown>): {
  phone: string;
  name: string;
  message: string;
  mediaUrl: string;
  mediaType: string;
  mediaKey: string;
  fromMe?: boolean;
  outgoingText?: string;
  outgoingPhone?: string;
} {
  // --- Uazapi V2 format ---
  const eventType = payload.EventType as string | undefined;

  if (eventType) {
    if (eventType !== "messages") {
      console.log(`[Webhook] Ignoring Uazapi V2 event type: ${eventType}`);
      return { phone: "", name: "", message: "", mediaUrl: "" };
    }

    const msg = payload.message as Record<string, unknown> | undefined;
    const chat = payload.chat as Record<string, unknown> | undefined;
    const evt = msg || (payload.event as Record<string, unknown> | undefined);
    if (!evt) {
      console.log("[Webhook] No message or event data found in Uazapi V2 payload");
      return { phone: "", name: "", message: "", mediaUrl: "" };
    }

    if (evt.fromMe === true || evt.IsFromMe === true) {
      console.log("[Webhook] Skipping fromMe message");
      return { phone: "", name: "", message: "", mediaUrl: "" };
    }

    const rawChat =
      (evt.sender as string) ||
      (evt.chatid as string) ||
      (evt.Chat as string) ||
      (evt.Sender as string) ||
      (chat?.wa_chatid as string) ||
      "";
    const phone = rawChat.replace(/@.*$/, "").replace(/\D/g, "");

    if (rawChat.includes("@broadcast")) {
      return { phone: "", name: "", message: "", mediaUrl: "" };
    }

    const name =
      (evt.senderName as string) ||
      (evt.PushName as string) ||
      (chat?.name as string) ||
      (chat?.wa_contactName as string) ||
      "";

    const message =
      (evt.text as string) || (evt.content as string) || (evt.Body as string) || (evt.Text as string) || "";

    console.log(`[Webhook] Uazapi V2 extracted - phone: ${phone}, name: ${name}, message: ${message.substring(0, 50)}`);
    return { phone, name, message, mediaUrl: "" };
  }

  // --- Evolution API format ---
  const event = payload.event as string;
  if (event === "messages.upsert" && payload.data) {
    const data = payload.data as Record<string, unknown>;
    const key = data.key as Record<string, unknown> | undefined;
    const msg = data.message as Record<string, unknown> | undefined;

    let phone = "";
    if (key?.remoteJid) {
      phone = (key.remoteJid as string).replace(/@.*$/, "");
    }

    const name = (data.pushName as string) || "";

    let message = "";
    if (msg) {
      message =
        (msg.conversation as string) ||
        ((msg.extendedTextMessage as Record<string, unknown>)?.text as string) ||
        ((msg.imageMessage as Record<string, unknown>)?.caption as string) ||
        "";
    }

    if (key?.remoteJid && (key.remoteJid as string).includes("@broadcast")) {
      return { phone: "", name: "", message: "", mediaUrl: "" };
    }
    if (key?.fromMe === true) {
      return { phone: "", name: "", message: "", mediaUrl: "" };
    }

    return { phone, name, message, mediaUrl: "" };
  }

  // --- Z-PRO "method" format (real production payloads) ---
  const method = payload.method as string | undefined;

  // Z-PRO outbound wrappers used by attendants replying via Z-PRO UI:
  //  message_send_uazapi (and any other message_send*) carry attendant text
  //  and we want to persist it. Treat as fromMe outbound and try to extract
  //  phone + text from many possible locations.
  if (method && (method === "message_send_uazapi" || method.startsWith("message_send"))) {
    const msg = (payload.msg as Record<string, unknown> | undefined) || {};
    const ticket = (payload.ticket as Record<string, unknown> | undefined) || {};
    const contact = (ticket.contact as Record<string, unknown> | undefined) || {};
    const rawTo =
      (msg.chatid as string) ||
      (msg.chatId as string) ||
      (msg.to as string) ||
      (msg.remoteJid as string) ||
      (payload.to as string) ||
      (payload.chatid as string) ||
      (payload.remoteJid as string) ||
      (contact.number as string) ||
      (contact.phone as string) ||
      "";
    const phoneOut = rawTo.replace(/@.*$/, "").replace(/\D/g, "");

    const candidates: any[] = [
      msg.text, msg.content, msg.body, msg.caption, msg.message,
      (msg.extendedTextMessage as any)?.text, (msg as any).conversation,
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

    // Media fallback: if no text but payload carries media, persist a placeholder so
    // the attendant's reply still appears in the chat thread.
    if (!txt && phoneOut && !rawTo.includes("@g.us") && !rawTo.includes("@broadcast")) {
      const mt = String((msg.mediatype as string) || (msg.mediaType as string) || (payload.mediatype as string) || "").toLowerCase();
      const hasMedia =
        !!(msg.imageMessage || msg.audioMessage || msg.videoMessage || msg.documentMessage || msg.stickerMessage ||
           (msg as any).mediaUrl || (payload as any).mediaUrl || mt);
      if (hasMedia) {
        txt = mt.includes("audio") ? "[áudio]"
          : mt.includes("image") || msg.imageMessage ? "[imagem]"
          : mt.includes("video") || msg.videoMessage ? "[vídeo]"
          : mt.includes("doc") || msg.documentMessage ? "[documento]"
          : msg.stickerMessage ? "[sticker]"
          : "[mídia]";
      }
    }

    if (rawTo.includes("@g.us") || rawTo.includes("@broadcast") || !phoneOut || !txt) {
      console.log(`[Webhook] Ignoring ${method} (no phone/text or group/broadcast)`);
      return { phone: "", name: "", message: "", mediaUrl: "", mediaType: "", mediaKey: "", fromMe: true };
    }

    const senderName =
      ((ticket.user as Record<string, unknown> | undefined)?.name as string) ||
      ((payload.user as Record<string, unknown> | undefined)?.name as string) ||
      (msg.senderName as string) ||
      (msg.pushName as string) ||
      "";

    return {
      phone: "",
      name: senderName,
      message: "",
      mediaUrl: "",
      mediaType: "",
      mediaKey: "",
      fromMe: true,
      outgoingText: txt,
      outgoingPhone: phoneOut,
    };
  }

  // Silently ignore other non-inbound Z-PRO events (contact updates, ticket events, status updates).
  if (
    method &&
    method !== "message" &&
    (
      method === "contact-create-update" ||
      method.startsWith("ticket") ||
      method.startsWith("contact") ||
      method.startsWith("message_status")
    )
  ) {
    console.log(`[Webhook] Ignoring Z-PRO non-inbound method: ${method}`);
    return { phone: "", name: "", message: "", mediaUrl: "", mediaType: "", mediaKey: "" };
  }

  if (method === "message" && payload.msg && typeof payload.msg === "object") {
    const msg = payload.msg as Record<string, unknown>;
    if (msg.fromMe === true) {
      // Capture outbound text (sent by agent or by provider) so we can persist it for full chat context.
      const ticket = (payload.ticket as Record<string, unknown> | undefined) || {};
      const contact = (ticket.contact as Record<string, unknown> | undefined) || {};
      const rawTo =
        (msg.chatid as string) ||
        (msg.chatId as string) ||
        (msg.to as string) ||
        (msg.remoteJid as string) ||
        (msg.from as string) ||
        (contact.number as string) ||
        (contact.phone as string) ||
        "";
      const phoneOut = rawTo.replace(/@.*$/, "").replace(/\D/g, "");
      const rawTxtUnknown: any = msg.text ?? msg.content ?? msg.body ?? msg.caption ?? "";
      let txt = "";
      if (typeof rawTxtUnknown === "string") {
        txt = rawTxtUnknown;
      } else if (rawTxtUnknown && typeof rawTxtUnknown === "object") {
        const inner = rawTxtUnknown.body || rawTxtUnknown.text || rawTxtUnknown.message || "";
        if (typeof inner === "string") txt = inner;
      }
      if (!txt) {
        const ext = (msg.extendedTextMessage as Record<string, unknown> | undefined)?.text;
        const conv = msg.conversation;
        if (typeof ext === "string") txt = ext;
        else if (typeof conv === "string") txt = conv;
      }
      // Media fallback: if no text but payload carries media, persist a placeholder
      if (!txt && phoneOut && !rawTo.includes("@g.us") && !rawTo.includes("@broadcast")) {
        const mt = String((msg.mediatype as string) || (msg.mediaType as string) || "").toLowerCase();
        const hasMedia =
          !!(msg.imageMessage || msg.audioMessage || msg.videoMessage || msg.documentMessage || msg.stickerMessage ||
             (msg as any).mediaUrl || mt);
        if (hasMedia) {
          txt = mt.includes("audio") || msg.audioMessage ? "[áudio]"
            : mt.includes("image") || msg.imageMessage ? "[imagem]"
            : mt.includes("video") || msg.videoMessage ? "[vídeo]"
            : mt.includes("doc") || msg.documentMessage ? "[documento]"
            : msg.stickerMessage ? "[sticker]"
            : "[mídia]";
        }
      }
      if (rawTo.includes("@g.us") || rawTo.includes("@broadcast") || !phoneOut || !txt) {
        return { phone: "", name: "", message: "", mediaUrl: "", mediaType: "", mediaKey: "", fromMe: true };
      }
      const senderName =
        ((ticket.user as Record<string, unknown> | undefined)?.name as string) ||
        ((payload.user as Record<string, unknown> | undefined)?.name as string) ||
        (msg.senderName as string) ||
        (msg.pushName as string) ||
        "";
      return {
        phone: "",
        name: senderName,
        message: "",
        mediaUrl: "",
        mediaType: "",
        mediaKey: "",
        fromMe: true,
        outgoingText: txt,
        outgoingPhone: phoneOut,
      };
    }

    const rawFrom = (msg.chatid as string) || (msg.from as string) || (msg.sender as string) || "";
    const phone = rawFrom.replace(/@.*$/, "").replace(/\D/g, "");

    if (rawFrom.includes("@g.us"))
      return { phone: "", name: "", message: "", mediaUrl: "", mediaType: "", mediaKey: "" };
    if (rawFrom.includes("@broadcast"))
      return { phone: "", name: "", message: "", mediaUrl: "", mediaType: "", mediaKey: "" };

    const name = (msg.senderName as string) || (msg.pushName as string) || (msg.notifyName as string) || "";
    // Normalize raw message body. Z-PRO/WA payloads may nest text in many shapes:
    //  - msg.text (string OR object with .body / .text)
    //  - msg.extendedTextMessage.text
    //  - msg.conversation
    //  - msg.caption
    //  - msg.content / msg.body (string)
    let rawMsg: any = msg.text ?? msg.content ?? msg.body ?? "";
    // Drill into nested text objects like { body: "..." } or { text: "..." }
    if (rawMsg && typeof rawMsg === "object" && !(rawMsg as any).URL) {
      const inner =
        (rawMsg as any).body ||
        (rawMsg as any).text ||
        (rawMsg as any).message ||
        "";
      if (typeof inner === "string" && inner.length > 0) {
        rawMsg = inner;
      }
    }
    // Fallback to other common WA fields if still empty / non-string and no URL
    if ((!rawMsg || (typeof rawMsg === "object" && !(rawMsg as any).URL))) {
      const ext = (msg.extendedTextMessage as Record<string, unknown> | undefined)?.text;
      const conv = msg.conversation;
      const cap = msg.caption;
      if (typeof ext === "string" && ext) rawMsg = ext;
      else if (typeof conv === "string" && conv) rawMsg = conv;
      else if (typeof cap === "string" && cap) rawMsg = cap;
    }
    let message = "";
    let mediaUrl = "";
    let mediaType = "";
    let mediaKey = "";

    // Detect media type from Z-PRO msg.type or msg.messageType fields
    const zpMsgType = ((msg.type || msg.messageType || "") as string).toLowerCase();

    if (typeof rawMsg === "object" && rawMsg !== null && (rawMsg as any).URL) {
      const mime: string = ((rawMsg as any).mimetype || "").toLowerCase();
      if (mime.includes("audio") || zpMsgType === "audio" || zpMsgType === "ptt") {
        // Z-PRO audio: metadata object with URL inside body
        mediaUrl = (rawMsg as any).URL as string;
        mediaType = "audio";
        mediaKey = (rawMsg as any).mediaKey || (msg.mediaKey as string) || "";
        message = "";
        console.log(
          `[Webhook] Z-PRO audio object detected, mediaUrl: ${mediaUrl.substring(0, 80)}, mediaKey: ${mediaKey ? "yes" : "no"}`,
        );
      } else if (
        mime.startsWith("image/") ||
        mime.startsWith("video/") ||
        zpMsgType === "image" ||
        zpMsgType === "video" ||
        zpMsgType === "sticker"
      ) {
        mediaUrl = (rawMsg as any).URL as string;
        mediaType = "image";
        message = (rawMsg as any).caption || "";
        console.log(
          `[Webhook] Z-PRO image/video detected (mime=${mime || zpMsgType}), caption: "${message.substring(0, 50)}"`,
        );
      } else if (
        mime.includes("pdf") ||
        mime.startsWith("application/") ||
        mime.includes("document") ||
        zpMsgType === "document"
      ) {
        mediaUrl = (rawMsg as any).URL as string;
        mediaType = "document";
        message = (rawMsg as any).caption || "";
        console.log(
          `[Webhook] Z-PRO document/PDF detected (mime=${mime || zpMsgType}), caption: "${message.substring(0, 50)}"`,
        );
      } else {
        // Unknown object with URL — check msg.type as last resort
        if (["image", "video", "sticker"].includes(zpMsgType)) {
          mediaUrl = (rawMsg as any).URL as string;
          mediaType = "image";
          message = (rawMsg as any).caption || "";
        } else if (zpMsgType === "document") {
          mediaUrl = (rawMsg as any).URL as string;
          mediaType = "document";
          message = (rawMsg as any).caption || "";
        } else {
          message = typeof rawMsg === "string" ? rawMsg : "";
          mediaUrl = (msg.mediaUrl as string) || (msg.fileUrl as string) || (msg.media as string) || "";
        }
      }
    } else {
      message = typeof rawMsg === "string" ? rawMsg : "";
      mediaUrl = (msg.mediaUrl as string) || (msg.fileUrl as string) || (msg.media as string) || "";
      // Fallback detection via msg.type even when body is a string
      if (!mediaType && (zpMsgType === "image" || zpMsgType === "video" || zpMsgType === "sticker")) {
        mediaType = "image";
        message = message || (msg.caption as string) || "";
      } else if (!mediaType && zpMsgType === "document") {
        mediaType = "document";
        message = message || (msg.caption as string) || "";
      }
    }
    console.log(
      `[Webhook] Z-PRO method format - phone: ${phone}, name: ${name}, message: ${typeof message === "string" ? message.substring(0, 50) : String(message)}, mediaUrl: ${mediaUrl ? "yes" : "no"}, mediaType: "${mediaType}"`,
    );
    return { phone, name, message, mediaUrl, mediaType, mediaKey };
  }

  // --- Generic/legacy format ---
  const phone =
    (payload.phone as string) ||
    (payload.from as string) ||
    (payload.sender as string) ||
    (payload.telefone as string) ||
    (payload.numero as string) ||
    "";

  const name =
    (payload.name as string) ||
    (payload.sender_name as string) ||
    (payload.nome as string) ||
    (payload.pushName as string) ||
    "";

  // Avoid [object Object] by checking types
  let message = "";
  if (typeof payload.message === "string") message = payload.message;
  else if (typeof payload.text === "string") message = payload.text;
  else if (typeof payload.body === "string") message = payload.body;
  else if (typeof payload.content === "string") message = payload.content;
  else if (typeof payload.mensagem === "string") message = payload.mensagem;
  else if (typeof payload.msg === "string") message = payload.msg;

  return { phone, name, message, mediaUrl: "", mediaType: "", mediaKey: "" };
}

// Build conversation history for LLM context
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

async function fetchConversationHistory(
  supabaseClient: any,
  conversationId: string | null,
): Promise<ConversationMessage[]> {
  if (!conversationId) return [];

  // BUG-3 FIX: widen history window from 24h to 72h so multi-day conversations don't lose context
  const cutoffDate = new Date(Date.now() - 72 * 60 * 60 * 1000);

  const { data, error } = await supabaseClient
    .from("webhook_messages")
    .select("message_text, direction, ai_intent, ai_entities, created_at")
    .eq("conversation_id", conversationId)
    .gte("created_at", cutoffDate.toISOString())
    .order("created_at", { ascending: false })
    .limit(60);

  if (error || !data || data.length === 0) {
    if (!error && (!data || data.length === 0)) {
      console.log("[Webhook] Conversation reset: no messages within 72h window");
    }
    return [];
  }

  // Find the most recent reset marker and only use messages after it
  const resetIndex = data.findIndex((msg: any) => msg.ai_intent === "resetar_conversa");
  const relevantData = resetIndex >= 0 ? data.slice(0, resetIndex) : data;

  if (resetIndex >= 0) {
    console.log(
      `[Webhook] Found reset marker at index ${resetIndex}, loading only ${relevantData.length} messages after it`,
    );
  }

  // BUG-3 FIX: keep up to 30 most-recent messages (was 15) — long booking flows lost context mid-way
  const trimmed = relevantData.slice(0, 30);

  // Reverse to chronological order and convert to chat messages
  const messages: ConversationMessage[] = [];
  for (const msg of trimmed.reverse()) {
    if (!msg.message_text) continue;
    const role = msg.direction === "incoming" ? "user" : "assistant";
    let content = msg.message_text;
    // MENSAGEM DE ATENDENTE NÃO É FALA DA JULIA (11/08). As respostas manuais são
    // gravadas como saída com o prefixo "*Vânia*:", e entravam no histórico como
    // se a própria Julia tivesse dito aquilo — inclusive o NOME da atendente. Daí
    // o modelo passava a se achar "Vânia", ou usava esse nome para se dirigir ao
    // paciente. Regra do dono: nome errado, nunca. Aqui o nome sai do texto e vira
    // marcação de autoria, que o modelo entende como contexto e não como fala sua.
    if (msg.direction === "outgoing") {
      const _humana = String(content).match(/^\s*\*([^*\n]{1,40})\*:\s*/);
      if (_humana || msg.ai_intent === "manual_reply") {
        content = String(content).replace(/^\s*\*[^*\n]{1,40}\*:\s*/, "");
        content = `<!-- mensagem escrita por uma ATENDENTE HUMANA da clínica, não por você -->\n${content}`;
      }
    }
    // BUG-3 FIX: store extracted entities as a structured HTML comment so the LLM can isolate
    // metadata from patient content. The previous inline " [Entidades extraídas: ...]" suffix
    // confused the model and bled metadata into the user-visible text.
    if (msg.direction === "incoming" && msg.ai_intent && msg.ai_entities) {
      const entities = msg.ai_entities as Record<string, unknown>;
      const meta: string[] = [];
      if (entities.cpf) meta.push(`cpf=${entities.cpf}`);
      if (entities.doctor_name) meta.push(`doctor=${entities.doctor_name}`);
      if (entities.subspecialty) meta.push(`subspecialty=${entities.subspecialty}`);
      if (entities.date) meta.push(`date=${entities.date}`);
      if (entities.time) meta.push(`time=${entities.time}`);
      if (entities.insurance_choice) meta.push(`insurance=${entities.insurance_choice}`);
      if (meta.length > 0) {
        content += `\n<!-- intent=${msg.ai_intent} ${meta.join(" ")} -->`;
      }
    }
    messages.push({ role, content });
  }

  // Tema 7 (relatorio 24/06 — 470k input tokens em 60 calls = ~7800/call):
  // teto por mensagem (1200 chars) E agregado (6000 chars). Sem isso, um audio
  // transcrito longo ou texto colado deixa o historico arbitrariamente grande.
  // Truncamos PRESERVANDO as mais RECENTES (mais relevantes).
  const MAX_MSG_CHARS = 1200;
  const MAX_TOTAL_CHARS = 6000;
  for (const m of messages) {
    if (m.content.length > MAX_MSG_CHARS) {
      m.content = m.content.substring(0, MAX_MSG_CHARS) + " …[truncado]";
    }
  }
  let runningTotal = 0;
  const keptReversed: ConversationMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const len = messages[i].content.length;
    if (runningTotal + len > MAX_TOTAL_CHARS) break;
    runningTotal += len;
    keptReversed.push(messages[i]);
  }
  const capped = keptReversed.reverse();
  if (capped.length < messages.length) {
    console.log(
      `[HistoryCap] reduced ${messages.length} -> ${capped.length} msgs (${runningTotal} chars, MAX_TOTAL=${MAX_TOTAL_CHARS})`,
    );
  }
  return capped;
}

// ═══════════════════════════════════════════════════════════════════════════
// Conversation state machine — single source of truth for "where is this
// patient now?". Reduces guard inconsistency that caused the Meiroka, Wesley
// and Isabela incidents (each guard re-deduced state differently from scratch).
// See migration 20260607214727_conversation_state.sql for state catalog.
// ═══════════════════════════════════════════════════════════════════════════

type ConversationStateName =
  | "idle"
  | "greeting"
  | "qualifying"
  | "info_question"
  | "slot_search"
  | "slot_chosen"
  | "awaiting_cpf"
  | "awaiting_registration"
  | "awaiting_confirmation"
  | "booking_created"
  | "reschedule_search"
  | "cancel_pending"
  | "transferred_human"
  | "closed";

type ConversationStateRow = {
  id: string;
  clinic_token_id: string;
  conversation_id: string | null;
  phone: string;
  current_state: ConversationStateName;
  previous_state: ConversationStateName | null;
  context: Record<string, any>;
  expected_inputs: string[];
  state_entered_at: string;
  expires_at: string | null;
  transition_count: number;
};

// Default TTL per state — after this, state is auto-considered stale by callers
// and they should fall back to inference. Tuned so common booking flow fits.
const STATE_TTL_MS: Record<ConversationStateName, number | null> = {
  idle: null,
  greeting: 30 * 60 * 1000, // 30min
  qualifying: 30 * 60 * 1000,
  info_question: 15 * 60 * 1000,
  slot_search: 10 * 60 * 1000,
  slot_chosen: 5 * 60 * 1000, // matches slot_lock TTL roughly
  awaiting_cpf: 10 * 60 * 1000,
  awaiting_registration: 30 * 60 * 1000,
  awaiting_confirmation: 10 * 60 * 1000,
  booking_created: 60 * 60 * 1000,
  reschedule_search: 15 * 60 * 1000,
  cancel_pending: 10 * 60 * 1000,
  transferred_human: 24 * 60 * 60 * 1000,
  closed: null,
};

async function getConversationState(
  supabase: any,
  clinicTokenId: string | null | undefined,
  phone: string | null | undefined,
): Promise<ConversationStateRow | null> {
  if (!supabase || !clinicTokenId || !phone) return null;
  try {
    const variants = phoneVariantsForState(phone);
    const { data } = await supabase
      .from("conversation_state")
      .select("*")
      .eq("clinic_token_id", clinicTokenId)
      .in("phone", variants)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    // Consider state stale if expires_at passed → treat as null (fall back to inference)
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
      console.log(`[ConversationState] State "${data.current_state}" expired for ${phone} — treating as null`);
      return null;
    }
    return data as ConversationStateRow;
  } catch (e) {
    console.warn(`[getConversationState] error: ${(e as Error).message}`);
    return null;
  }
}

// Phone variant builder used by state queries. Kept as alias of the canonical
// getPhoneVariants helper (defined further down — both are top-level functions
// in the same module so hoisting handles the order).
function phoneVariantsForState(phone: string): string[] {
  return getPhoneVariants(phone);
}

// ═══════════════════════════════════════════════════════════════════════════
// Centralized helpers — Onda 4. All phone/clinic/state code should funnel
// through these to eliminate the "every site reimplements normalization"
// class of bugs (one of the 3 systemic vícios we identified).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical phone format for STORAGE and EXACT queries.
 * Returns digits-only, always with Brazil prefix 55.
 * Empty input returns empty string (caller decides what to do).
 */
function normalizePhone(p: string | null | undefined): string {
  const clean = String(p || "").replace(/\D/g, "");
  if (!clean) return "";
  return clean.startsWith("55") ? clean : `55${clean}`;
}

/**
 * Variants for IN(...) queries. Covers:
 * - canonical (with 55)
 * - without 55
 * - with/without the Brazilian 9th digit (mobile vs landline edge case)
 *
 * Use whenever you need to match across phones that may have been stored
 * with different conventions in the DB.
 */

/**
 * For sending to AvanceAI/WhatsApp APIs that expect "55DD9XXXXXXXX" format.
 * Equivalent to normalizePhone but kept distinct for callsite intent clarity.
 */
function formatPhoneForApi(p: string | null | undefined): string {
  return normalizePhone(p);
}

// Transition state. ALWAYS use this — never UPDATE conversation_state directly.
// Best-effort: never throws. Writes the transition to the audit log too.
async function transitionConversationState(
  supabase: any,
  args: {
    clinicTokenId: string;
    conversationId?: string | null;
    phone: string;
    toState: ConversationStateName;
    trigger?: string | null;
    contextPatch?: Record<string, any>;
    expectedInputs?: string[];
    messageId?: string | null;
    resetContext?: boolean;
  },
): Promise<void> {
  if (!supabase || !args.clinicTokenId || !args.phone) return;
  try {
    const normalizedPhone = String(args.phone).replace(/\D/g, "");
    const phoneToStore = normalizedPhone.startsWith("55") ? normalizedPhone : `55${normalizedPhone}`;
    const current = await getConversationState(supabase, args.clinicTokenId, args.phone);
    const fromState = current?.current_state || "idle";
    const contextBefore = current?.context || {};
    const contextAfter = args.resetContext
      ? (args.contextPatch || {})
      : { ...contextBefore, ...(args.contextPatch || {}) };
    const ttl = STATE_TTL_MS[args.toState];
    const expiresAt = ttl ? new Date(Date.now() + ttl).toISOString() : null;
    const expectedInputs = args.expectedInputs || [];

    // Upsert state row (one row per phone+clinic)
    await supabase
      .from("conversation_state")
      .upsert(
        {
          clinic_token_id: args.clinicTokenId,
          conversation_id: args.conversationId ?? null,
          phone: phoneToStore,
          current_state: args.toState,
          previous_state: fromState,
          context: contextAfter,
          expected_inputs: expectedInputs,
          state_entered_at: new Date().toISOString(),
          expires_at: expiresAt,
          last_message_id: args.messageId ?? null,
          transition_count: (current?.transition_count ?? 0) + 1,
        },
        { onConflict: "clinic_token_id,phone" },
      );

    // Append-only audit log
    await supabase.from("conversation_state_transitions").insert({
      clinic_token_id: args.clinicTokenId,
      conversation_id: args.conversationId ?? null,
      phone: phoneToStore,
      from_state: fromState,
      to_state: args.toState,
      trigger: args.trigger ?? null,
      context_before: contextBefore,
      context_after: contextAfter,
      message_id: args.messageId ?? null,
    });

    console.log(
      `[ConversationState] ${fromState} → ${args.toState} (phone=${phoneToStore}, trigger=${args.trigger || "n/a"})`,
    );
  } catch (e) {
    console.warn(`[transitionConversationState] error: ${(e as Error).message}`);
  }
}

// Transcreve áudio com Whisper (DeepInfra desde 24/08; era Groq). Devolve texto
// e duração. O nome da função não cita mais o fornecedor de propósito: já houve
// troca, vai haver de novo, e função chamada "WithGroq" batendo em outro host é
// exatamente o comentário mentiroso que custa uma hora de investigação.
async function transcreverAudio(audioBlob: Blob, fileName: string): Promise<{ text: string; duration: number }> {
  if (!sttApiKey()) throw new Error("DEEPINFRA_API_KEY não configurada — áudio de paciente não será transcrito");

  // Varre extensões para contornar 400 de detecção de formato. Nasceu por causa
  // do Groq; mantido por ser barato e proteger contra a mesma classe de problema
  // em qualquer provedor — o WhatsApp manda ogg/opus com content-type instável.
  const extensions = ["ogg", "mp3", "mp4", "webm", "wav"];
  const baseExt = fileName.split(".").pop() || "ogg";
  // Put the original extension first, then try others
  const tryOrder = [baseExt, ...extensions.filter((e) => e !== baseExt)];

  let lastError = "";
  for (const ext of tryOrder) {
    const tryFileName = `audio.${ext}`;
    const mimeMap: Record<string, string> = {
      ogg: "audio/ogg",
      mp3: "audio/mpeg",
      mp4: "audio/mp4",
      webm: "audio/webm",
      wav: "audio/wav",
    };
    const retyped = new Blob([await audioBlob.arrayBuffer()], { type: mimeMap[ext] || "audio/ogg" });

    const formData = new FormData();
    formData.append("file", retyped, tryFileName);
    formData.append("model", STT_MODEL);
    formData.append("language", STT_LANGUAGE);
    formData.append("response_format", STT_RESPONSE_FORMAT);

    try {
      // 30s por tentativa: audio longo pode demorar, mas nao pode pendurar o webhook.
      // Sem Content-Type no header de propósito: o FormData define o boundary.
      const response = await fetchWithTimeout(STT_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${sttApiKey()}` },
        body: formData,
      }, 30000);

      if (response.ok) {
        const result = await response.json();
        const text = (result.text || "").trim();
        const duration = result.duration || 0;
        // duration=0 significa que o provedor não devolveu `duration` (formato de
        // resposta diferente). Não quebra nada, mas o custo deixa de ser
        // contabilizado e áudio longo deixa de ser resumido — precisa aparecer.
        if (!duration) console.warn(`[Audio/STT] sem 'duration' na resposta (response_format=${STT_RESPONSE_FORMAT}) — custo e resumo de áudio longo ficam desligados`);
        console.log(`[Audio/STT] Transcrito (${Math.round(duration)}s, ext=${ext}): ${text.substring(0, 100)}`);
        return { text, duration };
      }

      const errText = await response.text();
      lastError = `${response.status}: ${errText.substring(0, 200)}`;
      console.warn(`[Audio/STT] Failed with ext=${ext}: ${lastError}`);
      // Only retry on 400 (format issue); other errors are not format-related
      if (response.status !== 400) {
        throw new Error(`Falha na transcrição: ${response.status}`);
      }
    } catch (fetchErr: any) {
      if (fetchErr.message?.includes("Falha na transcrição")) throw fetchErr;
      lastError = fetchErr.message;
      console.warn(`[Audio/STT] Fetch error with ext=${ext}: ${lastError}`);
    }
  }
  throw new Error(`Falha na transcrição after trying all formats: ${lastError}`);
}

// Decrypt WhatsApp E2E encrypted media using Web Crypto API
async function decryptWhatsAppMedia(
  encryptedUrl: string,
  mediaKeyBase64: string,
  mediaType: "audio" | "image" | "video" | "document",
): Promise<Uint8Array> {
  const infoMap: Record<string, string> = {
    audio: "WhatsApp Audio Keys",
    image: "WhatsApp Image Keys",
    video: "WhatsApp Video Keys",
    document: "WhatsApp Document Keys",
  };

  // 1. Download encrypted file
  const res = await fetch(encryptedUrl);
  if (!res.ok) throw new Error(`Failed to download encrypted media: ${res.status}`);
  const encryptedFile = new Uint8Array(await res.arrayBuffer());
  console.log(`[Audio/Decrypt] Downloaded encrypted file: ${encryptedFile.length} bytes`);

  // 2. Decode mediaKey from base64
  const mediaKeyBinary = atob(mediaKeyBase64);
  const mediaKey = new Uint8Array(mediaKeyBinary.length);
  for (let i = 0; i < mediaKeyBinary.length; i++) mediaKey[i] = mediaKeyBinary.charCodeAt(i);

  // 3. HKDF-SHA256 to derive keys (112 bytes)
  const ikm = await crypto.subtle.importKey("raw", mediaKey, "HKDF", false, ["deriveBits"]);
  const info = new TextEncoder().encode(infoMap[mediaType]);
  const salt = new Uint8Array(32);
  const expandedKey = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, 112 * 8),
  );

  // 4. Split expanded key: iv[0:16], cipherKey[16:48], macKey[48:80]
  const iv = expandedKey.slice(0, 16);
  const cipherKey = expandedKey.slice(16, 48);
  const macKey = expandedKey.slice(48, 80);

  // 5. Split encrypted file: data + mac (last 10 bytes)
  const encData = encryptedFile.slice(0, encryptedFile.length - 10);
  const mac = encryptedFile.slice(encryptedFile.length - 10);

  // 6. Verify MAC: HMAC-SHA256(macKey, iv + encData)[0:10] == mac
  const hmacKey = await crypto.subtle.importKey("raw", macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macInput = new Uint8Array(iv.length + encData.length);
  macInput.set(iv, 0);
  macInput.set(encData, iv.length);
  const calculatedMac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, macInput));

  let macValid = true;
  for (let i = 0; i < 10; i++) {
    if (calculatedMac[i] !== mac[i]) {
      macValid = false;
      break;
    }
  }
  if (!macValid) {
    console.warn("[Audio/Decrypt] MAC verification failed — attempting decryption anyway");
  } else {
    console.log("[Audio/Decrypt] MAC verification passed ✓");
  }

  // 7. AES-256-CBC decrypt
  const aesKey = await crypto.subtle.importKey("raw", cipherKey, { name: "AES-CBC" }, false, ["decrypt"]);
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, encData));

  console.log(`[Audio/Decrypt] Decrypted: ${decrypted.length} bytes`);
  return decrypted;
}

// Resume transcrições longas (OpenRouter desde 24/08)
async function summarizeTranscription(text: string, clinicTokenId: string | null = null): Promise<string> {
  if (!llmApiKey()) return "";

  try {
    const res = await postLLM({
      method: "POST",
      headers: llmHeaders(),
      body: JSON.stringify({
        model: LLM_MODEL,
        usage: LLM_USAGE_INCLUDE,
        messages: [
          {
            role: "system",
            content:
              "Resuma o seguinte áudio transcrito em 2-3 frases concisas em português, mantendo os pontos principais. Responda apenas com o resumo, sem prefixos.",
          },
          { role: "user", content: text },
        ],
      }),
    }, 15000);
    if (!res.ok) {
      console.error(`[Audio/Summary] AI gateway error: ${res.status}`);
      return "";
    }
    const data = await res.json();
    logAiUsage(clinicTokenId, "whatsapp-webhook/summary", LLM_MODEL, data.usage);
    return data.choices?.[0]?.message?.content?.trim() || "";
  } catch (err: any) {
    console.error(`[Audio/Summary] Error: ${err.message}`);
    return "";
  }
}

// Transcribe audio from URL using Groq Whisper (with optional WhatsApp decryption)
async function transcribeAudio(audioUrl: string, mediaKeyBase64?: string): Promise<{ text: string; duration: number }> {
  let blob: Blob;

  if (mediaKeyBase64) {
    // WhatsApp encrypted media — decrypt first
    console.log(`[Audio] Decrypting WhatsApp media from: ${audioUrl.substring(0, 80)}`);
    try {
      const decrypted = await decryptWhatsAppMedia(audioUrl, mediaKeyBase64, "audio");
      blob = new Blob([decrypted], { type: "audio/ogg" });
      console.log(`[Audio] Decrypted audio: ${decrypted.length} bytes`);
    } catch (decryptErr: any) {
      console.error(`[Audio] Decryption failed: ${decryptErr.message} — falling back to direct download`);
      // Fallback: try direct download (might work for non-encrypted URLs)
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
      const contentType = audioRes.headers.get("content-type") || "audio/ogg";
      blob = new Blob([await audioRes.arrayBuffer()], { type: contentType });
    }
  } else {
    console.log(`[Audio] Downloading audio from: ${audioUrl}`);
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
    const contentType = audioRes.headers.get("content-type") || "audio/ogg";
    console.log(`[Audio] Downloaded, type: ${contentType}`);
    blob = new Blob([await audioRes.arrayBuffer()], { type: contentType });
  }

  const ext = blob.type.includes("ogg")
    ? "ogg"
    : blob.type.includes("mp4")
      ? "mp4"
      : blob.type.includes("mpeg")
        ? "mp3"
        : blob.type.includes("webm")
          ? "webm"
          : "ogg";
  return transcreverAudio(blob, `audio.${ext}`);
}

// Transcribe audio from base64 data directly (for test mode)
async function transcribeAudioFromBase64(
  base64Data: string,
  format: string,
): Promise<{ text: string; duration: number }> {
  console.log(`[Audio] Transcribing from base64, format: ${format}, length: ${base64Data.length}`);

  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const mimeType =
    format === "webm" ? "audio/webm" : format === "mp4" ? "audio/mp4" : format === "mp3" ? "audio/mpeg" : "audio/ogg";
  const blob = new Blob([bytes], { type: mimeType });
  return transcreverAudio(blob, `audio.${format || "ogg"}`);
}

// Call Lovable AI with tool calling for structured intent extraction
async function classifyIntent(
  messageText: string,
  apiKey: string,
  dynamicSystemPrompt?: string,
  conversationHistory?: ConversationMessage[],
  clinicTokenId: string | null = null,
): Promise<{
  intent: string;
  cpf: string;
  doctor_name: string;
  subspecialty: string;
  complaint: string;
  date: string;
  time: string;
  preferred_weekday: string;
  preferred_period: string;
  attendance_id: string;
  patient_full_name: string;
  insurance_choice: string;
  patient_birth_date: string;
  attendant_name: string;
  reagendar_confirmed: boolean;
  confidence: number;
}> {
  const todayISO = getTodayISO_SP();
  const currentYear = getNowSP().getFullYear();
  const defaultPrompt = `Você é um assistente de classificação de intenções para uma clínica médica.
Analise a mensagem do paciente e identifique a intenção e extraia as entidades relevantes.

Data de hoje: ${todayISO}
Ao extrair datas, use o ANO ATUAL (${currentYear}) quando o paciente não especificar o ano.

═══════════════════════════════════════════════════
REGRA #1 (MAIS IMPORTANTE DE TODAS) — PRIMEIRO NOME = SAUDAÇÃO:
Quando o paciente diz APENAS o primeiro nome (ex: "Meu nome é João", "Sou a Maria", "É o Pedro", "Oi, sou o Lucas"), você NÃO deve:
  ❌ Buscar no sistema (NÃO use "identificar_por_nome")
  ❌ Pedir CPF
  ❌ Pedir nome completo
  ❌ Pedir qualquer dado cadastral
Em vez disso, use intent "unknown" e responda de forma acolhedora: "Olá [nome]! Como posso te ajudar hoje?"
Exemplos:
  "Meu nome é João" → intent "unknown"
  "Sou a Maria" → intent "unknown"  
  "Oi, é o Pedro" → intent "unknown"
═══════════════════════════════════════════════════

REGRA #2 — NÃO PEÇA CPF CEDO:
- NUNCA peça o CPF do paciente como primeira interação ou logo no início da conversa.
- O sistema já tenta identificar o paciente automaticamente pelo número de telefone.
- Só peça CPF quando for absolutamente necessário para uma ação específica e APÓS ter esgotado alternativas.
- Primeiro ajude o paciente com o que ele precisa. Seja acolhedor e natural.
- NÃO peça CPF se o paciente acabou de se apresentar.

REGRA #3 — FLUXO DE AGENDAMENTO (ORDEM OBRIGATÓRIA):
- Ao agendar, siga SEMPRE esta ordem:
  1º Pergunte com qual médico/especialista deseja agendar
  2º Mostre as datas e horários disponíveis
  3º Só peça o CPF na etapa FINAL, quando médico + data + horário já estiverem definidos
- NUNCA peça CPF antes de mostrar os médicos e horários disponíveis.
- O objetivo é que o paciente primeiro veja as opções antes de se identificar.

IMPORTANTE - MEMÓRIA DE CONVERSA:
- Considere TODO o histórico da conversa para identificar entidades já fornecidas anteriormente.
- Se o paciente já informou CPF, nome de médico, data ou horário em mensagens anteriores, REUTILIZE essas informações.
- Se a mensagem atual parece ser uma resposta a um pedido anterior (ex: enviar CPF após ser solicitado), combine com a intenção anterior.
- Exemplo: Se a conversa anterior pediu CPF para agendar, e o paciente responde "12345678909", a intenção é "agendar" com o CPF fornecido.

Regras gerais:
- Identifique a intenção principal: agendar, cancelar, reagendar (= remarcar), confirmar, consultar, cadastrar
- Extraia o CPF se mencionado (formato XXX.XXX.XXX-XX ou só números)
- Extraia o nome do médico se mencionado
- Extraia a data desejada (formato YYYY-MM-DD) - USE O ANO ${currentYear} se o paciente não especificar o ano
- Extraia o horário desejado (formato HH:mm)
- Extraia o ID do agendamento se mencionado
- Se a mensagem for ambígua ou não relacionada, use intent "unknown"
- confidence deve ser entre 0 e 1

REGRAS ESPECIAIS DE IDENTIFICAÇÃO POR NOME:
- NÃO use intent "identificar_por_nome". Quando o paciente informar seu nome (completo ou não), trate como contexto conversacional e use intent "unknown". Guarde o nome em patient_full_name para uso na conversa, mas NÃO dispare busca no sistema.
- Quando o paciente diz "sou paciente novo", "não tenho cadastro", "primeira vez", "nunca fui aí", "quero me cadastrar" → use intent "cadastrar" DIRETAMENTE (não precisa de CPF prévio).
- Se o paciente está respondendo a um pedido de cadastro (informando nome e/ou convênio), use intent "cadastrar".
- REGRA CRÍTICA: Se a última mensagem do SISTEMA/ASSISTENTE pediu dados de cadastro (nome, convênio, endereço, data de nascimento) ou tem action_status "needs_registration", a intenção DEVE ser "cadastrar", INDEPENDENTE do contexto anterior de agendamento.

Exemplos de intenções:
- "Oi, meu nome é João" → unknown (APENAS primeiro nome, saudar)
- "Sou a Maria" → unknown (APENAS primeiro nome, saudar)
- "Quero marcar uma consulta" → agendar
- "Preciso cancelar minha consulta" → cancelar
- "Quero mudar a data da minha consulta" / "Quero REMARCAR minha consulta" / "Preciso remarcar" / "Dá pra passar pra outro dia?" / "Quero adiar minha consulta" / "Quero antecipar minha consulta" / "Dá pra trocar o horário da minha consulta?" / "Preciso transferir minha consulta de quinta" → reagendar
- DESEMPATE agendar vs reagendar: se o paciente menciona uma consulta JÁ existente (palavras como "minha consulta", "remarcar", "mudar", "passar de X para Y", "transferir minha consulta") E fornece nova data/horário, classifique como reagendar — NÃO agendar, mesmo que haja data+horário na mensagem. agendar é para consulta NOVA; reagendar é para consulta EXISTENTE.
- REGRA DE REAGENDAMENTO: Quando o paciente CONFIRMAR qual consulta quer reagendar (ex: "sim", "essa mesma", "a do Dr. X", ou escolher um número da lista), marque reagendar_confirmed=true e preserve o attendance_id do histórico. Quando o paciente informar a nova data após confirmar, mantenha reagendar_confirmed=true, attendance_id, e preencha date/time.
- "Confirmo minha presença" → confirmar
- "Quais minhas consultas marcadas?" / "Que dia é minha consulta?" / "Quando é meu retorno?" → consultar (consulta de agendamentos JÁ marcados do paciente — precisa identificar o paciente)
- ⚠️ NÃO confunda "consulta" (a palavra) com o intent "consultar". Perguntas sobre VALOR, PREÇO, "quanto custa a consulta", "qual o valor da consulta", como funciona o atendimento, política de convênios/particular, o que levar, horário de funcionamento → use intent "unknown". Essas respostas estão no script/dados da clínica e a assistente responde diretamente, SEM precisar de CPF nem ação no sistema. NUNCA classifique "qual o valor da consulta?" como "consultar".
- "Quais os médicos da clínica?" → listar_medicos
- "Quais especialistas vocês têm?" → listar_medicos
- Pergunta sobre um médico ESPECÍFICO por nome, SEM data ("Vocês têm o Dr. Vinicius?", "Atende com a Dra. Ana?", "Tem o Vinicius aí?") → listar_medicos (preencha doctor_name com o nome citado). NÃO classifique como "consultar" nem "unknown".
- IMPORTANTE: Mesmo uma pergunta de VALOR/PREÇO que cita um médico ESPECÍFICO por nome ("Qual o valor da consulta com o Dr. Vinicius?", "Quanto custa com a Dra. Ana?") → listar_medicos (preencha doctor_name). A assistente precisa primeiro confirmar se aquele médico atende na clínica. (Só use "unknown" para valor/preço quando NENHUM médico específico for citado.)
- REGRA ESPECIAL: Se o paciente pergunta sobre um médico/especialista E na mesma mensagem pede data, horário ou "data mais próxima" / "disponibilidade", classifique como "agendar" (NÃO "listar_medicos"). Preencha subspecialty ou doctor_name conforme mencionado. Exemplo: "Tem médico de ombro e qual a data mais próxima?" → agendar (subspecialty: "ombro")
- "Meu nome é Maria Silva" → unknown (guardar patient_full_name para contexto, NÃO buscar no sistema)
- "Sou paciente novo" / "Não tenho cadastro" / "Primeira vez" → cadastrar
- "Qual o endereço?" / "Onde fica a clínica?" / "Como chego aí?" / "Me manda a localização" → consultar_endereco
- "Quero falar com atendente" / "Me transfere pra uma pessoa" / "Quero falar com a Maria" → falar_com_atendente (extrair attendant_name se especificado)
- "Passar pra Vania" / "Passa pro Vania" / "Manda pra Vânia" / "Quero a Vania" / "Fala com a Vania" → falar_com_atendente (attendant_name="Vania"). IMPORTANTE: quando o paciente menciona um nome que NÃO é de médico da clínica, verifique se pode ser uma atendente e classifique como falar_com_atendente. Ignore acentos e variações de escrita.

REGRA CRÍTICA — CLASSIFICAÇÃO DE falar_com_atendente:
Classifique como "falar_com_atendente" APENAS quando:
1. O paciente usar palavras EXPLÍCITAS: "atendente", "humano", "pessoa", "transferir", "falar com alguém", "passa pra", "recepção", ou mencionar nome de atendente
2. O paciente demonstrar FRUSTRAÇÃO CLARA com a IA (ex: "você não está me ajudando", "isso não funciona", "não consigo resolver")
3. A IA não conseguiu resolver o problema após 2+ tentativas fracassadas consecutivas (action_status "failed" repetido)
NUNCA classifique como falar_com_atendente: "ok", "obrigada", "obrigado", "aguardo", "entendi", "tá bom", "certo", "valeu", "perfeito", confirmações simples, ou respostas curtas a informações da IA. Estas são CONFIRMAÇÕES, não pedidos de transferência.
- "Quero recomeçar" / "Começar do zero" / "Limpar histórico" / "Resetar conversa" / "Recomeçar do zero" → resetar_conversa
- "Quero fazer uma infiltração" / "Preciso de infiltração" / "Gostaria de agendar uma infiltração" / "Infiltração no joelho" / "Infiltração no ombro" → solicitar_infiltracao (NÃO classifique como 'agendar'. Infiltração NÃO é consulta.)
- "Quero solicitar um exame" / "Preciso de um exame" / "Quero fazer exame sem consulta" / "Solicitar exame" / "Preciso fazer um exame" / "Quero pedir um exame" → solicitar_exame (NÃO classifique como 'agendar'. Solicitação de exame sem consulta NÃO é agendamento.)
- Extraia patient_full_name (nome completo informado), insurance_choice (convênio escolhido ou "particular"), patient_birth_date (data de nascimento, APENAS se o paciente informar espontaneamente), patient_address (endereço completo ou CEP informado) e attendant_name (nome da atendente desejada, quando especificado)
- ⚠️ patient_full_name é o nome de QUEM VAI SER ATENDIDO, que nem sempre é quem escreve. Extraia em DOIS casos: (a) auto-identificação ("Meu nome é Maria Silva", "Sou João da Costa"); (b) a última mensagem da Julia PEDIU o nome completo para cadastro/agendamento — aí extraia o nome que vier, MESMO sendo de outra pessoa (marido, mãe, filho), porque é DELE o cadastro. Deixe vazio só quando um terceiro aparece de passagem, sem nenhum pedido de nome ("meu marido está com dor", "vou levar minha mãe") — aí o nome não é resposta a nada.`;

  // Tema 1: quando a clinica usa script dinamico, o defaultPrompt inteiro era
  // substituido — e com ele sumiam os exemplos/regras de reagendar. Anexamos sempre
  // este bloco fixo de taxonomia de reagendamento para nao depender so' do schema.
  const reagendarGuidance = `\n\nTAXONOMIA DE REAGENDAMENTO (sempre ativa):\n- reagendar (= "remarcar", "passar pra outro dia", "adiar", "antecipar", "trocar o horário", "transferir minha consulta") refere-se a uma consulta JÁ existente. NÃO confunda com agendar (consulta NOVA).\n- DESEMPATE: se o paciente menciona uma consulta existente E dá nova data/horário, classifique reagendar, mesmo com data+hora na mensagem.\n- Quando o paciente CONFIRMA qual consulta reagendar ("sim", "essa mesma", "a do Dr. X", número da lista), marque reagendar_confirmed=true e preserve attendance_id do histórico. Ao informar a nova data depois, mantenha reagendar_confirmed=true e attendance_id, e preencha date/time.`;

  const systemPrompt = dynamicSystemPrompt
    ? `${dynamicSystemPrompt}\n\nData de hoje: ${todayISO}\nAo extrair datas, use o ANO ATUAL (${currentYear}) quando o paciente não especificar o ano.\n\nIMPORTANTE - MEMÓRIA DE CONVERSA:\n- Considere TODO o histórico da conversa para identificar entidades já fornecidas anteriormente.\n- Se o paciente já informou CPF, nome de médico, data ou horário em mensagens anteriores, REUTILIZE essas informações.\n- Se a mensagem atual parece ser uma resposta a um pedido anterior, combine com a intenção da conversa.${reagendarGuidance}`
    : defaultPrompt;

  // Build messages array with history
  const messages: Array<{ role: string; content: string }> = [{ role: "system", content: systemPrompt }];

  // Add conversation history for context
  if (conversationHistory && conversationHistory.length > 0) {
    for (const msg of conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current message
  messages.push({ role: "user", content: messageText });

  // Fallback compartilhado: usado tanto no caso sem tool_call quanto no timeout.
  const UNKNOWN_CLASSIFICATION = {
    intent: "unknown",
    cpf: "",
    doctor_name: "",
    subspecialty: "",
    complaint: "",
    date: "",
    time: "",
    preferred_weekday: "",
    preferred_period: "",
    attendance_id: "",
    patient_full_name: "",
    insurance_choice: "",
    patient_birth_date: "",
    attendant_name: "",
    reagendar_confirmed: false,
    confidence: 0,
  };

  // Timeout de 22s: classifyIntent é a 1ª chamada LLM de toda mensagem. Sem teto,
  // um gateway travado pendurava o webhook até o wall-clock (p99=548s no 23/06).
  let response: Response;
  try {
  response = await postLLM({
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: [
        {
          type: "function",
          function: {
            name: "classify_patient_intent",
            description:
              "Classifica a intenção do paciente e extrai entidades da mensagem, considerando o histórico da conversa.",
            parameters: {
              type: "object",
              properties: {
                intent: {
                  type: "string",
                  enum: [
                    "agendar",
                    "cancelar",
                    "reagendar",
                    "confirmar",
                    "consultar",
                    "cadastrar",
                    "identificar_por_nome",
                    "consultar_convenios",
                    "consultar_endereco",
                    "listar_medicos",
                    "falar_com_atendente",
                    "solicitar_infiltracao",
                    "solicitar_exame",
                    "unknown",
                  ],
                  description:
                    "Intenção identificada do paciente (considere o contexto da conversa). Use 'identificar_por_nome' quando o paciente informa seu nome completo (primeiro nome + sobrenome) e ainda não foi identificado por CPF na conversa. Use 'cadastrar' quando o paciente diz que é novo/não tem cadastro OU está respondendo a um pedido de cadastro (informando nome e/ou convênio). Use 'consultar_convenios' quando o paciente perguntar sobre convênios aceitos. Use 'consultar_endereco' quando o paciente perguntar sobre endereço, localização, como chegar à clínica, onde fica, mapa (ex: 'qual o endereço', 'onde fica a clínica', 'como chego aí', 'me manda a localização'). Use 'listar_medicos' quando o paciente perguntar quais médicos/especialistas estão disponíveis. Use 'falar_com_atendente' quando o paciente pedir para falar com uma atendente, pessoa humana, ou pedir transferência de atendimento (ex: 'quero falar com atendente', 'transferir para humano', 'quero falar com uma pessoa', 'me passa pra alguém').",
                },
                cpf: {
                  type: "string",
                  description: "CPF do paciente - pode vir da mensagem atual OU do histórico da conversa",
                },
                doctor_name: {
                  type: "string",
                  description:
                    "Nome do médico mencionado pelo paciente. Se o paciente mencionar um médico DIFERENTE do que estava sendo discutido no histórico, use o nome da MENSAGEM ATUAL (o paciente está trocando de médico). Só use o nome do histórico se a mensagem atual não mencionar nenhum médico.",
                },
                subspecialty: {
                  type: "string",
                  description:
                    "Área do corpo ou subespecialidade mencionada pelo paciente (ex: ombro, joelho, mão, coluna, quadril, pé, cotovelo, punho). Extraia se o paciente mencionar dor ou problema em uma região específica.",
                },
                complaint: {
                  type: "string",
                  description:
                    "Queixa, sintoma ou motivo da consulta mencionado pelo paciente (ex: dor no ombro, problemas cardíacos, diabetes, check-up, dor nas costas). Extraia quando o paciente descrever seus sintomas ou razão para a consulta.",
                },
                date: {
                  type: "string",
                  description: "Data desejada no formato YYYY-MM-DD",
                },
                time: {
                  type: "string",
                  description: "Horário desejado no formato HH:mm",
                },
                preferred_weekday: {
                  type: "string",
                  description:
                    "Dia da semana preferido pelo paciente (ex: 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'). ATENÇÃO: Só preencha este campo se o paciente EXPLICITAMENTE mencionar um dia da semana na MENSAGEM ATUAL. NÃO infira dias da semana do contexto da conversa, do histórico, ou de qualquer outra fonte. Se o paciente não mencionou um dia da semana na mensagem atual, deixe VAZIO.",
                },
                preferred_period: {
                  type: "string",
                  enum: ["manha", "tarde"],
                  description:
                    "Período do dia preferido pelo paciente. 'manha' para horários antes de 12h, 'tarde' para horários a partir de 12h.",
                },
                attendance_id: {
                  type: "string",
                  description:
                    "ID do agendamento, se mencionado. PRESERVE do histórico quando o paciente está no fluxo de reagendamento.",
                },
                reagendar_confirmed: {
                  type: "boolean",
                  description:
                    "Marque como true quando o paciente CONFIRMAR qual consulta deseja reagendar (respondeu 'sim', escolheu da lista, ou confirmou o médico/data). Preserve como true nas mensagens seguintes do fluxo de reagendamento.",
                },
                patient_full_name: {
                  type: "string",
                  description:
                    "Nome completo de QUEM VAI SER ATENDIDO — que nem sempre é quem escreve. Extraia em dois casos: (a) quem escreve se AUTO-identifica ('Meu nome é Maria Silva', 'Sou João da Costa', 'Aqui é a Ana'); (b) a ÚLTIMA mensagem da Julia pediu o nome completo para cadastro/agendamento — nesse caso extraia o nome que vier, MESMO sendo de outra pessoa ('Carlos Mendes Ferreira' depois de 'me informe o nome completo do paciente'), porque o cadastro é DELE. Deixe VAZIO apenas quando um terceiro é citado de passagem, sem pedido de nome ('meu marido está com dor', 'vou levar minha mãe no médico') — aí o nome não responde a nada.",
                },
                insurance_choice: {
                  type: "string",
                  description: "Convênio escolhido pelo paciente (nome do convênio ou 'particular')",
                },
                patient_birth_date: {
                  type: "string",
                  description:
                    "Data de nascimento informada pelo paciente (extrair no formato que o paciente informar, ex: 15/05/1990, 15 de maio de 1990, etc.)",
                },
                attendant_name: {
                  type: "string",
                  description:
                    "Nome da atendente desejada quando o paciente especifica com quem quer falar (ex: 'quero falar com a Maria' → attendant_name='Maria'). Deixe vazio se o paciente não especificou preferência.",
                },
                confidence: {
                  type: "number",
                  description: "Nível de confiança da classificação (0 a 1)",
                },
              },
              required: ["intent", "confidence"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "classify_patient_intent" },
      },
    }),
  }, 22000);
  } catch (e) {
    console.error(`[AI] classify fetch abortado/timeout(22s): ${(e as Error).message}`);
    return { ...UNKNOWN_CLASSIFICATION };
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[AI] Gateway error: ${response.status} - ${errorText}`);
    throw new Error(`AI gateway error: ${response.status}`);
  }

  const result = await response.json();
  logAiUsage(clinicTokenId, "whatsapp-webhook/classify", LLM_MODEL, result.usage);
  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];

  if (!toolCall?.function?.arguments) {
    console.error("[AI] No tool call in response:", JSON.stringify(result));
    return { ...UNKNOWN_CLASSIFICATION };
  }

  const parsed =
    typeof toolCall.function.arguments === "string"
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function.arguments;

  return {
    intent: parsed.intent || "unknown",
    cpf: parsed.cpf || "",
    doctor_name: parsed.doctor_name || "",
    subspecialty: parsed.subspecialty || "",
    complaint: parsed.complaint || "",
    date: parsed.date || "",
    time: parsed.time || "",
    preferred_weekday: parsed.preferred_weekday || "",
    preferred_period: parsed.preferred_period || "",
    attendance_id: parsed.attendance_id || "",
    patient_full_name: parsed.patient_full_name || "",
    insurance_choice: parsed.insurance_choice || "",
    patient_birth_date: parsed.patient_birth_date || "",
    attendant_name: parsed.attendant_name || "",
    // Tema 1 (bug P1): o schema da tool define reagendar_confirmed mas o campo era
    // descartado aqui, travando o fluxo de reagendamento (Amostra 5). Agora propaga.
    reagendar_confirmed: parsed.reagendar_confirmed || false,
    confidence: parsed.confidence || 0,
  };
}

// Pre-send validation: sanitize AI reply before sending to patient

// ── ANTI-HALLUCINATION FINAL GUARD ──
// Blocks AI-generated replies that contain schedule terms (time/date) when the
// underlying action did NOT actually verify slots against the live calendar.
// This is the LAST defense before sending to the patient.


// === PRE-BOOK GUARD: defense-in-depth before POST/PUT to Amigo's attendances ===
// Blocks weekend bookings (sat/sun) and bookings outside business hours (8h-18h default).
// This is the LAST safety net even if LLM/calendar leak an invalid slot.

// Lock multiple presented slots with short TTL (1 min) so they're reserved while patient decides
async function lockPresentedSlots(
  supabaseClient: any,
  clinicTokenId: string,
  doctorId: string,
  datesWithSlots: Array<{ date: string; slots: string[] }>,
  phone: string,
) {
  try {
    // Clean expired locks first
    await supabaseClient.from("slot_locks").delete().lt("expires_at", new Date().toISOString());
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString(); // 3 minute TTL
    const cleanPhone = phone.replace(/\D/g, "");

    // "A vaga que você mesmo separou já estava ocupada" (relato 02/08): APRESENTAR a
    // lista travava os 5 primeiros horários de cada data em nome de quem só PERGUNTOU
    // a agenda — e, por ser upsert, ROUBAVA a reserva de quem já tinha ESCOLHIDO. O
    // segundo paciente virava dono; o primeiro voltava com o CPF e ouvia "reservado
    // por outro paciente". Agora a apresentação (a) nunca toca em vaga já travada por
    // OUTRO telefone e (b) grava kind='presented', que não bloqueia o agendamento de
    // ninguém — serve só para resolver o médico pelo horário e liberar o anti-alucinação.
    const jaTravadasPorOutro = new Set<string>();
    try {
      const { data: vivas } = await supabaseClient
        .from("slot_locks")
        .select("slot_date, slot_time, phone")
        .eq("clinic_token_id", clinicTokenId)
        .eq("doctor_id", doctorId)
        .gt("expires_at", new Date().toISOString());
      for (const l of (vivas || []) as Array<Record<string, unknown>>) {
        if (String(l.phone || "") !== cleanPhone) {
          jaTravadasPorOutro.add(`${String(l.slot_date)} ${String(l.slot_time)}`);
        }
      }
    } catch { /* sem leitura, segue sem roubar nada abaixo */ }

    const locks = [];
    for (const dateGroup of datesWithSlots) {
      for (const slot of dateGroup.slots.slice(0, 5)) {
        // Max 5 slots per date
        const slotTime = slot.length === 5 ? slot + ":00" : slot;
        if (jaTravadasPorOutro.has(`${dateGroup.date} ${slotTime}`)) continue; // não rouba
        locks.push({
          clinic_token_id: clinicTokenId,
          doctor_id: doctorId,
          slot_date: dateGroup.date,
          slot_time: slotTime,
          phone: cleanPhone,
          expires_at: expiresAt,
          kind: "presented",
        });
      }
    }
    if (locks.length > 0) {
      await supabaseClient
        .from("slot_locks")
        .upsert(locks, { onConflict: "clinic_token_id,doctor_id,slot_date,slot_time" });
      console.log(
        `[Webhook] 🔒 ${locks.length} horários apenas APRESENTADOS (kind=presented, 3min) p/ ${cleanPhone}` +
          (jaTravadasPorOutro.size > 0 ? ` — ${jaTravadasPorOutro.size} preservados de outro paciente` : ""),
      );
    }
  } catch (err) {
    console.log(`[Webhook] Slot lock (presentation) error (non-blocking): ${(err as Error).message}`);
  }
}
// A LETRA "c" NAO E UM PEDIDO DE CIRURGIA (30/08)
//
// A segunda perna desta funcao aceitava `kw.startsWith(w)`: bastava a mensagem
// conter uma palavra que fosse PREFIXO da keyword. Com a keyword "cirurgia", o
// "c" solto casava — e "c" e como meio mundo escreve "com" no WhatsApp. Medido em
// producao, 30 dias, todas grudadas na Vania e fora da fila:
//
//   "Fiz uma consulta c o dr Vilella dia 12/8"        -> regra "cirurgia"
//   "Encaixe hj c medico especialista em pe ?"        -> regra "cirurgia"
//   "Gostaria de agendar uma consulta c dr Guilherme" -> regra "cirurgia"
//   "queria marcar retorno c dr lucas miotto"         -> regra "cirurgia"
//
// Com a keyword "Infiltracao", um "i" solto fazia o mesmo. E como a regra de
// palavra-chave marca alvo dirigido, o ticket saia da fila e ficava preso numa
// pessoa — exatamente o sintoma que o dono relatou.
//
// A perna curta continua existindo, porque ela serve para algo real: "infiltra"
// tem que casar a keyword "Infiltracao". O que ela nao pode e aceitar toco de uma
// ou duas letras. Quatro caracteres E pelo menos 70% da keyword: "infiltra" (8 de
// 11) passa, "cirurgi" (7 de 8) passa, "c" e "ci" nao chegam perto.
const MIN_PREFIXO = 4;
function flexKeywordMatch(text: string, keyword: string): boolean {
  if (text.includes(keyword)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  const kwWords = keyword.split(/\s+/).filter(Boolean);
  return (
    kwWords.length > 0 &&
    kwWords.every((kw) =>
      words.some(
        (w) =>
          w.startsWith(kw) ||
          (kw.startsWith(w) && w.length >= MIN_PREFIXO && w.length >= Math.ceil(kw.length * 0.7)),
      ),
    )
  );
}

// Levenshtein distance for fuzzy name matching
function levenshteinDistance(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Fuzzy match: find best user by name with Levenshtein tolerance
function fuzzyFindUser(
  users: Array<{ id: number; name: string }>,
  requestedName: string,
): { id: number; name: string } | null {
  const reqNorm = stripAccents(requestedName.toLowerCase().trim());
  let bestUser: { id: number; name: string } | null = null;
  let bestDist = Infinity;

  for (const u of users) {
    const uNorm = stripAccents(u.name.toLowerCase().trim());
    // Check each word in the user's name (first name match is most common)
    const uWords = uNorm.split(/\s+/);
    for (const word of uWords) {
      const dist = levenshteinDistance(reqNorm, word);
      const threshold = Math.max(2, Math.ceil(word.length * 0.3));
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        bestUser = u;
      }
    }
  }

  if (bestUser) {
    console.log(`[Webhook] fuzzyFindUser: "${requestedName}" → "${bestUser.name}" (distance=${bestDist})`);
  }
  return bestUser;
}

// ── Parse transfer order from custom_notes (MODULE SCOPE — used by executeAction/falar_com_atendente) ──
function parseTransferOrder(customNotes?: string | null): string[] {
  if (!customNotes) return [];
  // Aceita "Transferência Humana (Ordem):" OU "Hierarquia:" (com/sem markdown bold)
  const match =
    customNotes.match(/Transfer[eê]ncia\s+Humana\s*\(Ordem\)\s*:\s*([^\n]+)/i) ||
    customNotes.match(/\*{0,2}Hierarquia\*{0,2}\s*:\s*\*{0,2}\s*([^\n]+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((n) =>
      n
        .trim()
        // remove ordinais tipo "1º", "2°", "3.", "4)"
        .replace(/^\d+\s*[ºo°.)\-:]\s*/i, "")
        // remove markdown bold/italic e pontuação final
        .replace(/[*_`]/g, "")
        .replace(/[.;]$/, "")
        .trim(),
    )
    .filter(Boolean);
}

// Parse "Atendentes de Férias: X, Y, Z" line from custom_notes.
// Returns normalized lowercase names (without accents) for comparison.


// ── Priority-based selection from preferred order in custom_notes ──
function selectAttendantByPriority(
  users: Array<{ id: string; name: string }>,
  preferredOrder: string[],
): { id: string; name: string } {
  for (const prefName of preferredOrder) {
    const normalized = stripAccents(prefName.toLowerCase().trim());
    const matchedUser = users.find((u) => stripAccents(u.name.toLowerCase().trim()) === normalized);
    if (matchedUser) {
      console.log(`[Webhook] Priority select: ${matchedUser.name} (first online in preferred order)`);
      return matchedUser;
    }
  }
  console.log(`[Webhook] Priority: no preferred attendant online, falling back to ${users[0].name}`);
  return users[0];
}

// ── Single source of truth for fetching attendants ──
// Returns { all, online } so callers can decide whether to inform the patient about
// an offline target (caso especial pedido pelo dono da clínica).

// In-memory cache for ticket counts per attendant (TTL 30s).
// Avoids hammering AvanceAI when many messages arrive in quick succession.
const ticketCountCache = new Map<string, { counts: Record<string, number>; ts: number }>();
const TICKET_COUNT_TTL_MS = 30_000;

// Fetch open ticket count per attendant (userId) from AvanceAI.
// Returns Record<userId, count>. On error returns empty object.
async function fetchTicketCountsByAttendant(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
): Promise<Record<string, number>> {
  const cacheKey = `${apiId}`;
  const cached = ticketCountCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TICKET_COUNT_TTL_MS) {
    return cached.counts;
  }
  try {
    const url = `${baseUrl}/v2/api/external/${apiId}/listTickets`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(tid));
    if (!res.ok) {
      console.warn(`[fetchTicketCounts] listTickets failed: ${res.status}`);
      return {};
    }
    const data: any = await res.json();
    const tickets: any[] = Array.isArray(data) ? data : Array.isArray(data?.tickets) ? data.tickets : Array.isArray(data?.data) ? data.data : [];
    const counts: Record<string, number> = {};
    for (const t of tickets) {
      const status = String(t.status || t.ticketStatus || "").toLowerCase();
      // Count only open/pending tickets — closed/resolved don't add load.
      if (status === "closed" || status === "resolved" || status === "finalizado") continue;
      const uid = t.userId ?? t.assignedUserId ?? t.user_id ?? t.assigned_user_id;
      if (uid === undefined || uid === null) continue;
      const key = String(uid);
      counts[key] = (counts[key] || 0) + 1;
    }
    ticketCountCache.set(cacheKey, { counts, ts: Date.now() });
    return counts;
  } catch (e) {
    console.warn(`[fetchTicketCounts] error: ${(e as Error).message}`);
    return {};
  }
}

// Cache for routing config per clinic (TTL 60s).
const routingConfigCache = new Map<string, { config: { load_balance_enabled: boolean; human_response_timeout_minutes: number; max_reassignment_attempts: number; timeout_enabled: boolean }; ts: number }>();
const ROUTING_CONFIG_TTL_MS = 60_000;

async function getRoutingConfig(
  supabase: any,
  clinicTokenId: string | null | undefined,
): Promise<{ load_balance_enabled: boolean; human_response_timeout_minutes: number; max_reassignment_attempts: number; timeout_enabled: boolean }> {
  const defaults = { load_balance_enabled: true, human_response_timeout_minutes: 15, max_reassignment_attempts: 2, timeout_enabled: false }; // 15min (política 21/07: aviso, não troca)
  if (!supabase || !clinicTokenId) return defaults;
  const cached = routingConfigCache.get(clinicTokenId);
  if (cached && Date.now() - cached.ts < ROUTING_CONFIG_TTL_MS) return cached.config;
  try {
    const { data } = await supabase
      .from("clinic_routing_config")
      .select("load_balance_enabled, human_response_timeout_minutes, max_reassignment_attempts, timeout_enabled")
      .eq("clinic_token_id", clinicTokenId)
      .maybeSingle();
    const config = data ? {
      load_balance_enabled: !!data.load_balance_enabled,
      human_response_timeout_minutes: Number(data.human_response_timeout_minutes) || defaults.human_response_timeout_minutes,
      max_reassignment_attempts: Number(data.max_reassignment_attempts) || defaults.max_reassignment_attempts,
      timeout_enabled: !!data.timeout_enabled,
    } : defaults;
    routingConfigCache.set(clinicTokenId, { config, ts: Date.now() });
    return config;
  } catch (_e) {
    return defaults;
  }
}

// Records a pending human transfer for timeout tracking. Idempotent per phone+clinic:
// if there's already a pending one, increments attempts_count instead of inserting.
// QUEM O AVISO DE 15 MIN VAI CITAR (26/08).
// Quando a transferência foi para a FILA de pendentes ninguém é dona. Gravar o
// nome de quem *teria* sido escolhida faz o human-transfer-timeout mandar ao
// paciente "a Fulana está finalizando outro atendimento e já já te responde" —
// uma promessa sobre um ticket que a Fulana não tem. O parêntese é a sentinela
// que aquele executor já lê (`_semDona`) para mandar a versão honesta: o caso
// continua na fila. Mesmo marcador que o caminho de urgência usa.
// Desde 30/08 nenhuma transferencia atribui: o ticket fica pendente, sem dona.
// Entao o pendente registrado aqui — que e o que o human-transfer-timeout le para
// montar o aviso de 15 min ao paciente — nunca pode nomear ninguem. Nomear quem
// so *teria* sido escolhida transformava a fila numa promessa falsa.
// A sentinela com parentese e a mesma que o timeout ja sabe ler.
function avisoSemDona(): { attendantName: string; attendantId: string | null } {
  return { attendantName: "(fila geral)", attendantId: null };
}

async function recordPendingHumanTransfer(
  supabase: any,
  args: {
    clinicTokenId: string;
    conversationId?: string | null;
    phone: string;
    intent?: string | null;
    attendantName: string;
    attendantId?: string | null;
    timeoutMinutes: number;
    isReassignment?: boolean;
  },
) {
  if (!supabase || !args.clinicTokenId) return;
  try {
    const expectedBy = new Date(Date.now() + args.timeoutMinutes * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from("pending_human_transfers")
      .select("id, attempts_count, previous_attendants")
      .eq("clinic_token_id", args.clinicTokenId)
      .eq("phone", args.phone)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      const prev = Array.isArray(existing.previous_attendants) ? existing.previous_attendants : [];
      await supabase
        .from("pending_human_transfers")
        .update({
          assigned_attendant_name: args.attendantName,
          assigned_attendant_id: args.attendantId ?? null,
          attempts_count: (existing.attempts_count || 1) + 1,
          previous_attendants: args.isReassignment ? [...prev, args.attendantName] : prev,
          last_assigned_at: new Date().toISOString(),
          expected_response_by: expectedBy,
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("pending_human_transfers").insert({
        clinic_token_id: args.clinicTokenId,
        conversation_id: args.conversationId ?? null,
        phone: args.phone,
        intent: args.intent ?? null,
        assigned_attendant_name: args.attendantName,
        assigned_attendant_id: args.attendantId ?? null,
        expected_response_by: expectedBy,
        status: "pending",
      });
    }
  } catch (e) {
    console.warn(`[recordPendingHumanTransfer] failed: ${(e as Error).message}`);
  }
}

// Audit log for routing decisions. Best-effort, never throws.
async function logRoutingDecision(
  supabase: any,
  args: {
    clinicTokenId: string;
    conversationId?: string | null;
    phone: string;
    intent?: string | null;
    chosenAttendantName?: string | null;
    chosenAttendantId?: string | null;
    reason: string;
    offlineTargetName?: string | null;
    onlineCount: number;
    totalCount: number;
    ticketCounts?: Record<string, number> | null;
    metadata?: Record<string, any> | null;
  },
) {
  if (!supabase || !args.clinicTokenId) return;
  try {
    await supabase.from("attendant_routing_log").insert({
      clinic_token_id: args.clinicTokenId,
      conversation_id: args.conversationId ?? null,
      phone: args.phone,
      intent: args.intent ?? null,
      chosen_attendant_name: args.chosenAttendantName ?? null,
      chosen_attendant_id: args.chosenAttendantId ?? null,
      reason: args.reason,
      offline_target_name: args.offlineTargetName ?? null,
      online_count: args.onlineCount,
      total_count: args.totalCount,
      ticket_counts: args.ticketCounts ?? null,
      metadata: args.metadata ?? null,
    });
  } catch (e) {
    console.warn(`[logRoutingDecision] failed: ${(e as Error).message}`);
  }
}



// ── Single attendant selection with 4-priority ladder + audit reason ──
// Priority order:
//   1. Patient explicitly asked for someone by name (requestedName)
//   2. Specialty routing config (specialtyRouting: keyword/category → attendant)
//   3. Routing rules from clinic_info.routing_rules
//   4. Order in clinic_info.custom_notes "Transferência Humana (Ordem):"
//   5. First online (fallback)
// Returns the chosen user and a `reason` string for auditing.
type SelectAttendantOpts = {
  requestedName?: string | null;
  routingRules?: Array<{ keyword: string; target_user: string }> | null;
  preferredOrder?: string[];
  specialtyMatch?: { attendantName: string; categoryName: string; keepOffline?: boolean } | null;
  currentMessageText?: string | null;
  ticketCounts?: Record<string, number> | null;
  loadBalanceEnabled?: boolean;
  excludeAttendantIds?: Array<string | number>;
  // ATENDENTE DONA (política 21/07): quem atendeu este paciente por último (30d).
  // Entra na escada DEPOIS das regras clínicas de palavra-chave (exceção aprovada)
  // e ANTES da ordem preferida/balanceamento — paciente tem dono, não sorteio.
  stickyOwnerName?: string | null;
};

// Quem "é dono" do paciente: a última atendente humana que respondeu (manual_reply,
// prefixo "*Nome*:") nos últimos 30 dias; fallback: assigned_agent_name da conversa
// (fonte showticket). Retorna null se ninguém atendeu — fluxo segue a escada normal.
async function findOwnerAttendant(
  sb: any,
  clinicTokenId: string | null | undefined,
  phone: string | null | undefined,
): Promise<string | null> {
  if (!sb || !clinicTokenId || !phone) return null;
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const { data: rows } = await sb
      .from("webhook_messages")
      .select("message_text")
      .eq("clinic_token_id", clinicTokenId)
      .in("sender_phone", getPhoneVariants(phone))
      .eq("direction", "outgoing")
      .eq("ai_intent", "manual_reply")
      .gte("created_at", since30d)
      .order("created_at", { ascending: false })
      .limit(5);
    for (const r of rows || []) {
      const m = String((r as any).message_text || "").match(/^\*([^*\n]{2,40})\*:/);
      if (m && m[1].trim()) return m[1].trim();
    }
    const { data: conv } = await sb
      .from("chat_conversations")
      .select("assigned_agent_name")
      .in("phone", getPhoneVariants(phone))
      .not("assigned_agent_name", "is", null)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const n = String((conv as any)?.assigned_agent_name || "").trim();
    return n.length >= 2 ? n : null;
  } catch {
    return null;
  }
}

// AUDITORIA (política 21/07): toda troca de mão registrada com motivo — a aba
// Transferências do painel lê daqui. Fire-and-forget: nunca bloqueia o fluxo.
async function auditTransfer(
  sb: any,
  args: {
    clinicTokenId?: string | null;
    conversationId?: string | null;
    phone?: string | null;
    patientName?: string | null;
    fromAttendant?: string | null;
    toAttendant?: string | null;
    initiatedBy: string; // 'julia' | 'painel' | 'zpro_observado'
    trigger: string;
    reason?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  if (!sb || !args.clinicTokenId) return;
  try {
    await sb.from("transfer_audit").insert({
      clinic_token_id: args.clinicTokenId,
      conversation_id: args.conversationId || null,
      phone: args.phone ? String(args.phone).replace(/\D/g, "") : null,
      patient_name: args.patientName || null,
      from_attendant: args.fromAttendant || null,
      to_attendant: args.toAttendant || "(fila geral)",
      initiated_by: args.initiatedBy,
      trigger: args.trigger,
      reason: args.reason || null,
      detail: (args.detail || "").slice(0, 200) || null,
    });
  } catch (e) {
    console.log(`[TransferAudit] insert falhou (non-blocking): ${(e as Error).message}`);
  }
}

// Returns user with lowest open ticket count among candidates. Ties broken by
// array order (which is the source-of-truth preference order).
function pickLeastBusy(
  candidates: AttendantUser[],
  counts: Record<string, number>,
): AttendantUser {
  let best = candidates[0];
  let bestCount = counts[String(best.id)] ?? 0;
  for (let i = 1; i < candidates.length; i++) {
    const c = counts[String(candidates[i].id)] ?? 0;
    if (c < bestCount) {
      best = candidates[i];
      bestCount = c;
    }
  }
  return best;
}

// ── TRANSFERÊNCIA COM DONO — o caminho único (11/08) ────────────────────────
// Medido no dia 10/08: 30 conversas foram transferidas para um humano. A espera
// MÉDIA até a primeira resposta de gente foi de 130 minutos, a maior foi de 364
// (6 horas), e 5 pacientes não receberam resposta humana nenhuma. Enquanto isso
// a Julia fica muda, porque o guard de humano a silencia assim que o ticket sai
// da mão dela. Do lado do paciente é indistinguível de "não transferiu".
//
// A causa não é uma só: existem SETE caminhos que dizem "vou te transferir" e
// cada um faz um pedaço do trabalho.
//   • `recordPendingHumanTransfer` (que arma o aviso de 15 min) era chamado em
//     apenas 3 deles — infiltração, exame e queda do widget. Os outros quatro,
//     incluindo o MAIOR (`falar_com_atendente`, 22 das 30 conversas), nunca
//     entravam na fila de vigilância: ninguém era avisado de que havia paciente
//     esperando.
//   • `logRoutingDecision` era chamado em apenas 2, então o painel não mostrava
//     a maior parte das transferências.
//   • Pior: o caminho de URGÊNCIA chamava `transferTicketToHuman` SEM `userId`,
//     o que apenas abre o ticket sem dono. Seis pacientes com dor foram
//     "transferidos" para ninguém em 10/08.
//
// Este helper concentra o trabalho completo: escolhe a atendente pela mesma
// escada de prioridade dos outros fluxos, atribui o ticket a ela, registra a
// decisão no painel e arma o aviso de 15 minutos. Falhar aqui nunca derruba o
// fluxo — devolve null e quem chamou segue com o texto que já tinha.
async function transferirComDono(
  supabase: any,
  args: {
    clinicTokenId: string | null | undefined;
    conversationId?: string | null;
    phone: string;
    intent: string;
    baseUrl: string;
    apiId: string;
    bearerToken: string;
    channelId?: string | null;
    currentMessageText?: string | null;
  },
): Promise<{ ok: boolean; attendantName?: string }> {
  try {
    if (!args.baseUrl || !args.apiId || !args.bearerToken || !args.phone) return { ok: false };
    let telefone = args.phone.replace(/\D/g, "");
    if (!telefone.startsWith("55")) telefone = "55" + telefone;

    let customNotes: string | null = null;
    let routingRules: any = null;
    if (supabase && args.clinicTokenId) {
      const { data: info } = await supabase
        .from("clinic_info")
        .select("custom_notes, routing_rules")
        .eq("clinic_token_id", args.clinicTokenId)
        .maybeSingle();
      customNotes = info?.custom_notes ?? null;
      routingRules = info?.routing_rules ?? null;
    }
    // Férias + ausências marcadas no painel: quem não está trabalhando hoje não
    // recebe paciente (mesma regra dos outros fluxos, caso Lidiane 28/07).
    const foraDoRodizio = await nomesForaDoRodizio(supabase, args.clinicTokenId || null, customNotes);
    const fetchRes = await fetchOnlineAttendants(args.baseUrl, args.apiId, args.bearerToken, {
      excludeNames: foraDoRodizio,
    });
    if (!fetchRes.ok || fetchRes.online.length === 0) {
      console.log(`[TransferirComDono] ${args.intent}: nenhuma atendente online — ticket vai para a fila geral`);
      return { ok: false };
    }

    const routingConfig = await getRoutingConfig(supabase, args.clinicTokenId);
    const ticketCounts = routingConfig.load_balance_enabled
      ? await fetchTicketCountsByAttendant(args.baseUrl, args.apiId, args.bearerToken)
      : {};
    // A especialidade agora vale TAMBÉM aqui — este é o caminho do "quero falar
    // com alguém", o mais usado de todos, e era exatamente onde ela não valia.
    const _dona = await buscarDonaDoAssunto(supabase, args.clinicTokenId, args.currentMessageText);
    if (_dona) {
      console.log(`[TransferirComDono] assunto "${_dona.categoryName}" → ${_dona.attendantName} (keep_offline=${_dona.keepOffline})`);
    }
    const choice = selectAttendant(fetchRes.online, fetchRes.all, {
      routingRules: routingRules || null,
      preferredOrder: parseTransferOrder(customNotes),
      specialtyMatch: _dona,
      currentMessageText: args.currentMessageText || null,
      ticketCounts,
      loadBalanceEnabled: routingConfig.load_balance_enabled,
    });
    const selecionada = (choice.user as any) || fetchRes.online[0];
    if (!selecionada) return { ok: false };

    const transferResult = await transferTicketToHuman({
      baseUrl: args.baseUrl,
      apiId: args.apiId,
      bearerToken: args.bearerToken,
      phone: telefone,
      userId: selecionada.id,
      channelId: args.channelId ?? null,
      forceReassign: true,
      // Só é dirigida quando a escolha veio de regra clínica / nome pedido.
    });
    if (!transferResult.ok) {
      console.error(
        `[TransferirComDono] ${args.intent}: transferência falhou (status=${transferResult.httpStatus}) — ${transferResult.errorDetail}`,
      );
      return { ok: false };
    }

    await logRoutingDecision(supabase, {
      clinicTokenId: args.clinicTokenId as string,
      conversationId: args.conversationId ?? null,
      phone: telefone,
      intent: args.intent,
      chosenAttendantName: selecionada.name,
      chosenAttendantId: String(selecionada.id),
      reason: choice.reason,
      offlineTargetName: choice.offlineTargetName || null,
      onlineCount: fetchRes.online.length,
      totalCount: fetchRes.all.length,
      ticketCounts: Object.keys(ticketCounts).length ? ticketCounts : null,
    });
    if (args.clinicTokenId) {
      await recordPendingHumanTransfer(supabase, {
        clinicTokenId: args.clinicTokenId,
        conversationId: args.conversationId ?? null,
        phone: telefone,
        intent: args.intent,
        ...avisoSemDona(),
        timeoutMinutes: routingConfig.human_response_timeout_minutes,
      });
    }
    console.log(`[TransferirComDono] ${args.intent}: ✅ ticket com ${selecionada.name} (motivo=${choice.reason})`);
    return { ok: true, attendantName: selecionada.name };
  } catch (e) {
    console.log(`[TransferirComDono] ${args.intent} falhou (non-blocking): ${(e as Error).message}`);
    return { ok: false };
  }
}

// ── ACOLHIMENTO IMEDIATO EM URGENCIA (semana 10-14/08) ──────────────────────
// Medicao no banco, 10 a 14/08: 24 transferencias por urgencia em 23 conversas,
// e ai_response NULL em 24 de 24. Nenhuma das 12.168 mensagens de saida gravadas
// em julho+agosto contem o texto de urgencia (a expressao "parece urgente" so
// aparece 1 vez, e foi gerada pelo LLM em outro caminho). Ou seja: a frase de
// urgencia NAO chegava ao paciente. Ela era enviada DEPOIS de transferirComDono,
// ou seja, segundos depois de um transferTicketToHuman(forceReassign) na mesma
// requisicao. NAO sabemos a causa exata. O que sabemos: o mesmo endpoint externo
// entrega normalmente para ticket que ja tem dono humano — o aviso de 15 min saiu
// em 13/08 11:38 para a conversa cd9479cf com a Glaucia dona, e o paciente
// respondeu "Okay" 19s depois. Entao a explicacao NAO e' "ticket com dono deixa a
// Julia muda". O que este patch faz e' tirar a frase da janela suspeita: ela sai
// ANTES de qualquer transferencia e antes das 5 a 8 chamadas HTTP em serie do
// transferirComDono. O paciente escrevia "estou com muita dor" e ficava olhando tela vazia
// por uma mediana de ~100 min ate uma pessoa aparecer (caso 15/08 10:18, filha com
// o dedo machucado: silencio total ate o aviso automatico de 15 min).
//
// Este helper manda a frase ANTES de qualquer transferencia, enquanto o ticket
// ainda e da Julia, e GRAVA o que saiu: linha outgoing no historico + ai_response
// na mensagem que entrou. Sem gravar, a frase fica invisivel no painel, some do
// historico que alimenta o modelo, e a propria metrica que descobriu este bug
// continua mentindo. A insercao cai dentro da janela de 30s de dedup do captador
// fromMe, entao o eco da AvanceAI nao duplica a linha.
//
// O texto vale para os dois casos da amostra: urgencia real E pedido de encaixe
// (12 das 24 eram encaixe). Nao promete prazo, nao cita nome de atendente (regra
// do dono) e nao da orientacao clinica — so o encaminhamento padrao ao PS.
const URGENCIA_ACOLHIMENTO =
  "Recebi sua mensagem e já sinalizei seu caso como prioridade aqui. 🙏 Se for uma emergência, por favor não espere por uma resposta por aqui: procure um pronto-socorro.";

// PEDIDO DE ENCAIXE (26/08). Mesmo caminho, mesma pressa, SEM pronto-socorro:
// quem pergunta "consegue um encaixe?" está falando de agenda cheia, não de
// emergência. Não promete prazo e não cita nome de atendente, igual ao texto
// clínico — só troca o que assustava.
const ENCAIXE_ACOLHIMENTO =
  "Recebi seu pedido de encaixe! 🙏 Já passei para a nossa equipe verificar essa possibilidade na agenda.";

async function enviarAcolhimentoUrgencia(
  supabase: any,
  args: {
    baseUrl?: string | null;
    apiId?: string | null;
    bearerToken?: string | null;
    phone?: string | null;
    channelId?: string | null;
    isTestMode?: boolean;
    userId?: string | null;
    webhookId?: string | null;
    clinicTokenId?: string | null;
    conversationId?: string | null;
    contactName?: string | null;
    messageId?: string | null;
    // Texto a enviar. Sem ele, o clínico — o caminho antigo continua o padrão.
    mensagem?: string | null;
  },
): Promise<boolean> {
  const _texto = args.mensagem || URGENCIA_ACOLHIMENTO;
  if (args.isTestMode) return false;
  if (!args.baseUrl || !args.apiId || !args.bearerToken || !args.phone) {
    // ERROR de proposito: paciente em urgencia sem canal resolvido e' o caso que
    // some de todo alerta. Tem que aparecer no log como falha, nao como rotina.
    console.error(
      `[UrgenciaAck] 🚨 SEM CREDENCIAL DE CANAL — acolhimento NAO enviado (phone=${args.phone || "?"})`,
    );
    return false;
  }
  let enviado = false;
  try {
    enviado = await sendAvanceaiReply(
      args.baseUrl,
      args.apiId,
      args.bearerToken,
      args.phone,
      _texto,
      args.channelId ?? null,
    );
  } catch (e) {
    console.error(`[UrgenciaAck] 🚨 envio quebrou: ${(e as Error).message}`);
    return false;
  }
  if (!enviado) {
    console.error(`[UrgenciaAck] 🚨 AvanceAI recusou o acolhimento — phone=${args.phone}`);
    return false;
  }
  try {
    await supabase.from("webhook_messages").insert({
      user_id: args.userId ?? null,
      webhook_id: args.webhookId ?? null,
      clinic_token_id: args.clinicTokenId ?? null,
      conversation_id: args.conversationId ?? null,
      sender_phone: args.phone,
      sender_name: args.contactName ?? null,
      message_text: _texto,
      direction: "outgoing",
      action_status: "success",
      ai_intent: "urgency_ack",
    });
    if (args.messageId) {
      await supabase
        .from("webhook_messages")
        .update({ ai_response: _texto })
        .eq("id", args.messageId);
    }
    if (args.userId) {
      await upsertConversation(
        supabase,
        args.userId,
        args.clinicTokenId ?? null,
        args.phone,
        args.contactName || "",
        _texto,
        "outgoing",
      );
    }
  } catch (e) {
    console.log(`[UrgenciaAck] gravacao falhou (non-blocking): ${(e as Error).message}`);
  }
  return true;
}

// CPF MASCARADO NÃO É CPF (caso Caio 15/08) ─────────────────────────────────
// `patients/exists?contact_cellphone=...` devolve o CPF MASCARADO: "***.778.798-**".
// Esse valor era gravado como se fosse CPF de verdade e usado em buscas depois.
// Hoje 456 das 1.425 linhas de local_patients (32%) estão assim, e ~11 novas
// nascem por dia. Cada uma vira um "Não encontrei seu cadastro" para quem é da
// casa: a busca seguinte manda `patients/exists?cpf=778798` e não acha ninguém.
// Sem 11 dígitos não é CPF — melhor vazio do que podre, porque vazio o sistema
// sabe pedir, e podre ele acha que já tem.
function cpfLimpoOuVazio(bruto: unknown): string {
  const d = String(bruto ?? "").replace(/\D/g, "");
  return d.length === 11 ? d : "";
}

// ── DONA DO ASSUNTO (16/08) ─────────────────────────────────────────────────
// A tabela specialty_routing existe desde sempre, mas só era consultada em DOIS
// caminhos (solicitar_infiltracao e solicitar_exame), com a categoria fixa no
// código. No caminho mais usado de todos — o paciente pedindo "quero falar com
// alguém" — ela passava `specialtyMatch: null`, ou seja, a especialidade não
// valia nada. Das 50 mensagens que citaram "infiltra" na semana, só 9 viraram
// transferência de infiltração.
//
// Esta função lê a tabela UMA vez e casa por categoria ou por palavra-chave
// contra o texto do paciente, para qualquer assunto cadastrado — infiltração,
// cirurgia, exame, o que a clínica cadastrar depois.
export function falaDeTerceiro(texto: string): boolean {
  // "meu marido fez cirurgia" não é um caso de cirurgia DESTE paciente. Sem isto,
  // a palavra solta sequestra a conversa para a dona do assunto.
  const t = stripAccents(String(texto || "").toLowerCase());
  return /\b(meu|minha|do meu|da minha)\s+(marido|esposa|esposo|mulher|mae|pai|filho|filha|irmao|irma|sogro|sogra|avo|tio|tia|primo|prima|amigo|amiga|namorado|namorada|companheiro|companheira)\b/.test(t);
}

async function buscarDonaDoAssunto(
  sb: any,
  clinicTokenId: string | null | undefined,
  textoDoPaciente: string | null | undefined,
): Promise<{ attendantName: string; categoryName: string; keepOffline: boolean } | null> {
  try {
    if (!sb || !clinicTokenId) return null;
    const texto = stripAccents(String(textoDoPaciente || "").toLowerCase());
    if (!texto) return null;
    const { data } = await sb
      .from("specialty_routing")
      .select("category_name, attendant_name, keywords, keep_offline, is_active, display_order")
      .eq("clinic_token_id", clinicTokenId)
      .eq("is_active", true)
      .order("display_order", { ascending: true });
    for (const row of (data || []) as any[]) {
      if (!row?.attendant_name) continue;
      const termos: string[] = [
        String(row.category_name || ""),
        ...(Array.isArray(row.keywords) ? row.keywords.map((k: unknown) => String(k)) : []),
      ]
        .map((t) => stripAccents(t.toLowerCase()).trim())
        .filter((t) => t.length >= 4);
      const casou = termos.some((t) => texto.includes(t));
      if (!casou) continue;
      if (falaDeTerceiro(texto)) {
        console.log(
          `[DonaDoAssunto] "${row.category_name}" casou, mas o texto fala de terceiro ("meu marido...") — ignorando`,
        );
        continue;
      }
      return {
        attendantName: String(row.attendant_name),
        categoryName: String(row.category_name || ""),
        keepOffline: row.keep_offline === true,
      };
    }
    return null;
  } catch (e) {
    console.log(`[DonaDoAssunto] falhou (non-blocking): ${(e as Error).message}`);
    return null;
  }
}

function selectAttendant(
  onlineUsers: AttendantUser[],
  allUsers: AttendantUser[],
  opts: SelectAttendantOpts,
): { user: AttendantUser | null; reason: string; offlineTargetName?: string } {
  // Exclude attendants we already tried (reassignment scenario)
  const excludeSet = new Set((opts.excludeAttendantIds || []).map(String));
  const available = (onlineUsers || []).filter((u) => !excludeSet.has(String(u.id)));
  if (!available || available.length === 0) {
    return { user: null, reason: excludeSet.size > 0 ? "no_more_candidates" : "no_online_attendants" };
  }

  const norm = (s: string) => stripAccents(String(s || "").toLowerCase().trim());
  const findOnlineByName = (name: string) =>
    available.find((u) => norm(u.name).includes(norm(name))) || fuzzyFindUser(available as any, name);
  const findAnyByName = (name: string) =>
    allUsers.find((u) => norm(u.name).includes(norm(name))) || fuzzyFindUser(allUsers as any, name);

  // 1. Patient explicitly asked for someone by name
  if (opts.requestedName) {
    const online = findOnlineByName(opts.requestedName);
    if (online) return { user: online, reason: `requested_by_name:${opts.requestedName}` };
    const offlineMatch = findAnyByName(opts.requestedName);
    if (offlineMatch) {
      return {
        user: null,
        reason: `requested_offline:${opts.requestedName}`,
        offlineTargetName: offlineMatch.name,
      };
    }
  }

  // 2. Specialty routing match (from specialty_routing table)
  if (opts.specialtyMatch?.attendantName) {
    const online = findOnlineByName(opts.specialtyMatch.attendantName);
    if (online) {
      return {
        user: online,
        reason: `specialty:${opts.specialtyMatch.categoryName}:${opts.specialtyMatch.attendantName}`,
      };
    }
    // DONA DO ASSUNTO MESMO OFFLINE (16/08). A coluna `keep_offline` existia na
    // tabela e na tela de configuração desde sempre, mas NUNCA era lida aqui:
    // se a especialista estivesse offline, o caso caía para a próxima regra e
    // terminava numa generalista. Era por isso que, em 30 dias, infiltração foi
    // 13x para a Laiz e 3x para a Lidiane — a dona do assunto.
    //
    // Pedido do dono (16/08): "as infiltrações todas, quem que vai cuidar? Só
    // Lidiane". Com keep_offline ligado, o ticket vai para ela mesmo offline e
    // espera. Quem tira o paciente da espera é a devolução para a fila (o
    // degrau de tempo), não uma generalista pegando o caso errado.
    if (opts.specialtyMatch.keepOffline) {
      const offline = findAnyByName(opts.specialtyMatch.attendantName);
      if (offline) {
        return {
          user: offline,
          reason: `specialty_keep_offline:${opts.specialtyMatch.categoryName}:${opts.specialtyMatch.attendantName}`,
          offlineTargetName: offline.name,
        };
      }
      console.log(
        `[selectAttendant] specialty keep_offline pedido, mas "${opts.specialtyMatch.attendantName}" não existe na lista de atendentes — caindo para a escada normal`,
      );
    }
    console.log(
      `[selectAttendant] specialty target "${opts.specialtyMatch.attendantName}" offline — falling through`,
    );
  }

  // 3. Routing rules from clinic_info (keyword on current message → target_user)
  if (Array.isArray(opts.routingRules) && opts.routingRules.length > 0 && opts.currentMessageText) {
    const msgLower = norm(opts.currentMessageText);
    for (const rule of opts.routingRules) {
      if (!rule.keyword || !rule.target_user) continue;
      if (msgLower.includes(norm(rule.keyword))) {
        const online = findOnlineByName(rule.target_user);
        if (online) return { user: online, reason: `routing_rule:${rule.keyword}:${rule.target_user}` };
      }
    }
  }

  // 3.5. ATENDENTE DONA (política 21/07): quem atendeu este paciente por último e
  // está online recebe — vem DEPOIS das regras clínicas (infiltração→Lidiane vence)
  // e ANTES do balanceamento (paciente tem dono; balancear é só desempate).
  if (opts.stickyOwnerName) {
    const owner = findOnlineByName(opts.stickyOwnerName);
    if (owner) return { user: owner, reason: `sticky_owner:${owner.name}` };
    console.log(`[selectAttendant] dona "${opts.stickyOwnerName}" offline — seguindo a escada`);
  }

  // 4. Preferred order from custom_notes — gather ALL online matches, then load-balance.
  const counts = opts.ticketCounts || {};
  const balance = opts.loadBalanceEnabled !== false; // default ON
  if (Array.isArray(opts.preferredOrder) && opts.preferredOrder.length > 0) {
    const matched: AttendantUser[] = [];
    for (const prefName of opts.preferredOrder) {
      const u = findOnlineByName(prefName);
      if (u && !matched.find((m) => String(m.id) === String(u.id))) matched.push(u);
    }
    if (matched.length === 1) {
      return { user: matched[0], reason: `preferred_order:${matched[0].name}` };
    }
    if (matched.length > 1) {
      if (balance && Object.keys(counts).length > 0) {
        const chosen = pickLeastBusy(matched, counts);
        const c = counts[String(chosen.id)] ?? 0;
        return { user: chosen, reason: `preferred_order_least_busy:${chosen.name}:${c}` };
      }
      return { user: matched[0], reason: `preferred_order:${matched[0].name}` };
    }
  }

  // 5. Fallback: load-balance across ALL online (or first if balance disabled)
  if (balance && Object.keys(counts).length > 0) {
    const chosen = pickLeastBusy(available, counts);
    const c = counts[String(chosen.id)] ?? 0;
    return { user: chosen, reason: `least_busy_fallback:${chosen.name}:${c}` };
  }
  return { user: available[0], reason: "first_online_fallback" };
}
async function executeAction(
  intent: string,
  entities: {
    cpf: string;
    doctor_name: string;
    subspecialty: string;
    complaint: string;
    date: string;
    time: string;
    preferred_weekday: string;
    preferred_period: string;
    attendance_id: string;
    patient_full_name: string;
    insurance_choice: string;
    patient_birth_date: string;
    attendant_name: string;
  },
  amigoToken: string,
  companyId: string,
  supabaseClient?: any,
  clinicTokenId?: string | null,
  senderPhone?: string,
  avanceaiConfig?: { baseUrl: string; apiId: string; bearerToken: string } | null,
  routingRules?: Array<{ keyword: string; target_user: string }> | null,
  recentMessages?: Array<{ role: string; content: string }> | null,
  isTestMode?: boolean,
  currentMessageText?: string,
  channelId?: string | null,
  customNotes?: string | null,
  businessHoursOpts?: { businessOpenHour?: number; businessCloseHour?: number } | null,
  conversationIdParam?: string | null,
): Promise<{ status: string; response: string; error?: string }> {
  try {
    switch (intent) {
      case "resetar_conversa": {
        // Caso Zeila (08/07): o LLM classificou um relato CLINICO ("picos de febre"
        // pos-operatoria) como resetar_conversa e a Julia respondeu "vamos comecar do
        // zero". Reset agora exige pedido EXPLICITO na mensagem — qualquer outra coisa
        // volta ao fluxo normal (unknown), onde os guards de urgencia/LLM respondem.
        const _resetMsg = stripAccents((currentMessageText || "").toLowerCase());
        const _wantsReset =
          /\b(reset|resetar|recome[cç]ar|recome[cç]o|reiniciar|come[cç]ar\s+(de\s+novo|do\s+zero)|zerar|apagar\s+(tudo|a\s+conversa)|limpar\s+(a\s+)?conversa)\b/.test(_resetMsg);
        if (!_wantsReset) {
          console.log(
            `[Webhook] resetar_conversa REJEITADO — mensagem nao pede reset ("${(currentMessageText || "").slice(0, 60)}"), seguindo como unknown`,
          );
          return { status: "unknown_intent", response: "" };
        }
        // Clear all ai_entities using the conversationId passed directly (not phone lookup)
        // The conversationId is passed via recentMessages context or a dedicated param
        const resetConvId = conversationIdParam || (globalThis as any).__currentConversationId;
        if (supabaseClient && resetConvId) {
          await supabaseClient
            .from("webhook_messages")
            .update({ ai_entities: null })
            .eq("conversation_id", resetConvId);
          console.log(`[Webhook] Reset: cleared ai_entities for conversation ${resetConvId}`);
        } else {
          console.log(`[Webhook] Reset: no conversationId available, skipping entity cleanup`);
        }
        return {
          status: "success",
          response: "Conversa resetada com sucesso. Vamos recomeçar do zero!",
        };
      }
      case "consultar": {
        // SAFETY NET: the classifier sometimes maps "qual o valor da consulta?" to "consultar"
        // because of the word "consulta". That's an INFORMATIONAL question the script already
        // answers — it must NOT enter the appointment-lookup flow (which needs a CPF and hits
        // the API). Redirect to unknown_intent so the LLM answers using the persona script.
        const consultarMsg = stripAccents((currentMessageText || "").toLowerCase());
        const isPriceOrInfoQuestion =
          /\b(valor|valores|preco|precos|quanto custa|quanto e|quanto sai|custo|particular|tabela)\b/.test(
            consultarMsg,
          );
        const mentionsOwnAppointments =
          /\b(minha|minhas|meu|meus|marcad|agendad|remarcad|retorno|proxima|próxima)\b/.test(consultarMsg);
        if (isPriceOrInfoQuestion && !mentionsOwnAppointments) {
          console.log(
            `[Action] consultar → redirecting price/info question to unknown_intent (script answers it): "${(currentMessageText || "").slice(0, 60)}"`,
          );
          // Relatorio 09/07 (caso ): sem instrução, o LLM às vezes
          // respondia "tive uma dificuldade técnica" em vez do VALOR (que está no
          // script). Instrução interna explícita: responda o valor, sem desculpas.
          return {
            status: "unknown_intent",
            response: "",
            internal_instruction:
              "Pergunta INFORMATIVA sobre valores/preços. Responda DIRETAMENTE com os valores da tabela de preços que está nos Dados de Referência da Clínica (script). NÃO diga que teve dificuldade técnica, NÃO peça CPF, NÃO transfira — apenas informe o valor perguntado com simpatia.",
          } as any;
        }
        if (!entities.cpf) {
          return {
            status: "needs_info",
            response: "",
            error: "CPF não informado. Por favor, informe seu CPF para que eu possa consultar seus agendamentos.",
          };
        }
        const cleanCpf = entities.cpf.replace(/\D/g, "");
        const patientResult = await tryFetch(
          `patients/exists?cpf=${cleanCpf}&company_id=${companyId}`,
          amigoToken,
          "GET",
          undefined,
          true,
        );
        const patientData = normalizeApiResponse(patientResult) as Record<string, unknown>;
        // Tema 3: queda do Amigo (502/5xx) != "CPF nao encontrado". Nao nega o cadastro.
        if (isAuthApiFailure(patientResult.status)) {
          return { status: "transient_error", response: AMIGO_AUTH_MESSAGE, bypassAiRewrite: true, error: amigoAuthAlert(patientResult.status, "consultar") };
        }
        if (isTransientApiFailure(patientResult.status)) {
          return { status: "transient_error", response: TRANSIENT_API_MESSAGE, bypassAiRewrite: true, error: `Amigo transient ${patientResult.status} (consultar) [${amigoFailReason(patientResult.data)}]` };
        }
        if (!patientData || patientResult.status >= 400) {
          return { status: "failed", response: "", error: "Paciente não encontrado com este CPF" };
        }
        const patientId = patientData.id || patientData.patient_id;
        if (!patientId) {
          return { status: "failed", response: "", error: "Paciente não encontrado" };
        }
        const attResult = await tryFetch(`attendances/${patientId}?company_id=${companyId}`, amigoToken);
        const attData = normalizeApiResponse(attResult);
        // CAUSA DE FUNDO do caso Renan (31/07): o JSON CRU ia para o LLM e ELE formatava
        // o horário. O modelo tratou "10:40" como se fosse UTC e escreveu "07:40" ao
        // paciente — 3h antes, num horário em que a clínica nem abriu. Agora cada
        // agendamento leva o horário JÁ FORMATADO: `extractDateAndTime` lê os dígitos
        // literais da string (nunca constrói Date, então é imune a fuso) e o modelo passa
        // a ter texto pronto para copiar, sem nenhuma conversão a fazer.
        // ENRIQUECE, não substitui: o formato continua sendo uma LISTA de agendamentos
        // porque o FalseConfirmGuard faz JSON.parse desta mesma resposta para saber se
        // existe consulta real (campos extras são inofensivos para ele).
        const attFormatado = Array.isArray(attData)
          ? (attData as Array<Record<string, unknown>>).map((a) => {
              const { date, time } = extractDateAndTime(String(a?.start_date || a?.date || ""));
              if (!date || !time) return a;
              return {
                ...a,
                data_formatada: formatDateLabel(date),
                horario_formatado: time,
                // string pronta para a resposta — use EXATAMENTE este horário
                texto_pronto: `${formatDateLabel(date)} às ${time}`,
              };
            })
          : attData;
        return {
          status: "success",
          response: JSON.stringify(attFormatado),
        };
      }

      case "agendar": {
        // REDE DE SEGURANÇA da regra "infiltração nunca é agendada pelo robô": o
        // redirecionamento acontece ANTES, logo após a classificação (busca por
        // "GUARD INFILTRAÇÃO"), onde vira solicitar_infiltracao e a transferência
        // REAL acontece. Este ponto é o último cinto: se por qualquer caminho um
        // 'agendar' com contexto de infiltração chegar aqui, não marca nada.
        if (temContextoDeInfiltracao(recentMessages)) {
          console.log(`[Webhook] ⛔ GUARD INFILTRAÇÃO (rede de segurança no case agendar) — não agenda`);
          const _infMsg =
            "Para infiltração o agendamento é feito pela nossa equipe, que organiza a documentação junto com você. " +
            "Vou pedir para uma atendente continuar com você por aqui, tá? 🙏";
          return {
            status: "needs_documents_infiltracao",
            response: _infMsg,
            error: _infMsg,
            bypassAiRewrite: true,
          } as any;
        }

        // ── GREETING GUARD: Prevent simple greetings from entering booking flow ──
        // If the LLM classified a greeting as "agendar" (due to residual context) but there are
        // no real entities (no doctor, no specialty, no date), check if the message is just a greeting.
        const greetingPatterns =
          /^(ol[aá]|oi|bom\s*dia|boa\s*(tarde|noite)|hey|hi|hello|e\s*a[ií]|fala|salve|tudo\s*bem)[,!?.\s]*$/i;
        const msgTrimmed = (currentMessageText || "").trim();
        if (
          !entities.doctor_name &&
          !entities.subspecialty &&
          !entities.date &&
          !entities.cpf &&
          msgTrimmed &&
          greetingPatterns.test(msgTrimmed)
        ) {
          console.log(
            `[Webhook] GREETING GUARD: Message "${msgTrimmed}" classified as "agendar" but is a greeting — reclassifying as unknown`,
          );
          return {
            status: "needs_info",
            response: "",
            error:
              "Olá! 😊 Como posso te ajudar? Posso agendar consultas, verificar horários disponíveis, ou te passar para um atendente.",
          };
        }

        // ── PRÓXIMA DATA (caso Joseane 19/07) ──
        // Pedido de "data mais próxima" (ou aceite da oferta "posso verificar a
        // próxima data disponível") chegava com a DATA VELHA herdada do histórico —
        // justamente o dia que a Julia acabou de dizer que está lotado. O fluxo
        // re-buscava o mesmo dia vazio, o LLM inventava datas (anti-alucinação
        // bloqueava), fallback 2x → transferida pra atendente num domingo à noite.
        // Determinístico: limpa date/time herdados e a listagem de próximas datas
        // (que já existe no fluxo sem data) assume. Dois gatilhos:
        //   (a) a própria mensagem pede a próxima data/qualquer dia;
        //   (b) afirmativa curta logo após a Julia OFERECER verificar a próxima data.
        {
          const _pdMsg = stripAccents(String(currentMessageText || "").toLowerCase());
          const _pdAsksNext =
            /\b(data|dia|horario)s?\s+mais\s+proxim|proxima\s+(data|disponibilidade|vaga)|mais\s+cedo\s+possivel|primeira\s+(data|vaga)\b|qualquer\s+(dia|data)\b/.test(_pdMsg);
          const _pdShortAffirm =
            _pdMsg.replace(/[^a-z]/g, "").length <= 14 &&
            /\b(quero|sim|pode|pode ser|claro|ok|por favor|isso|perfeito)\b/.test(_pdMsg);
          // (HOTFIX 20/07: o parâmetro de histórico do executeAction chama-se
          // recentMessages — "conversationHistory" NÃO existe neste escopo e derrubou
          // TODOS os agendamentos de 20/07 com ReferenceError. Mesma classe do crash
          // de 30/06. Ver teste de regressão + endurecimento do preflight.)
          const _pdLastBot = [...(recentMessages || [])].reverse().find((m: any) => m?.role === "assistant");
          const _pdOfferedNext = /proxima(s)?\s+data|verificar\s+a\s+proxima|proximas\s+datas/.test(
            stripAccents(String(_pdLastBot?.content || "").toLowerCase()),
          );
          const _pdExplicitDate =
            /\d{1,2}\/\d{1,2}|\b(hoje|amanha|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(_pdMsg);
          if ((_pdAsksNext || (_pdShortAffirm && _pdOfferedNext)) && !_pdExplicitDate && (entities.date || entities.time)) {
            console.log(
              `[Webhook] agendar - PRÓXIMA DATA: limpando date/time herdados ("${entities.date}"/"${entities.time}") — listagem de próximas datas assume (caso Joseane)`,
            );
            entities.date = "";
            entities.time = "";
          }
        }

        // PISO DA LISTAGEM POR CARÊNCIA — REMOVIDO (16/08). Aqui se calculava, em
        // silêncio, a primeira data que o convênio "libera" e a listagem escondia
        // tudo antes dela. Era o que fazia o paciente ouvir "as datas disponíveis
        // começam a partir do dia DD/MM" sem nenhuma explicação. As duas variáveis
        // continuam declaradas e vazias: os filtros abaixo passam a ser inertes.
        // Bônus: some também uma chamada a patients/exists por listagem.
        const _listGateMin = "";
        const _listGateNote = "";

        // ── CBT OUTAGE MODE ──
        // Enquanto o site de agendamento da CBT Ortopedia estiver instavel, NAO enviamos
        // o link do widget. Em vez disso, avisamos que o site esta fora do ar e transferimos
        // pra atendente humano (respeitando hierarquia + ferias).
        const CBT_OUTAGE_CLINIC_IDS = new Set(["fc9450e6-a7aa-408d-93b7-e39f805f3161"]);
        if (clinicTokenId && CBT_OUTAGE_CLINIC_IDS.has(clinicTokenId)) {
          console.log(`[Webhook] agendar - CBT outage mode: skipping widget link, transferring to human`);
          const outageMessage =
            "Oi! 😊 Nosso site de agendamento está fora do ar momentaneamente. Já estou te transferindo para um dos nossos atendentes pra te ajudar por aqui mesmo, tudo bem? 🙏";

          if (avanceaiConfig) {
            const { baseUrl, apiId, bearerToken } = avanceaiConfig;
            try {
              const fetchRes = await fetchOnlineAttendants(baseUrl, apiId, bearerToken, {
                excludeNames: await nomesForaDoRodizio(supabaseClient, clinicTokenId, customNotes),
              });
              if (fetchRes.ok && fetchRes.online.length > 0) {
                const preferredOrder = parseTransferOrder(customNotes);
                const routingConfig = await getRoutingConfig(supabaseClient, clinicTokenId);
                const ticketCounts = routingConfig.load_balance_enabled
                  ? await fetchTicketCountsByAttendant(baseUrl, apiId, bearerToken)
                  : {};
                const choice = selectAttendant(fetchRes.online, fetchRes.all, {
                  routingRules: routingRules || null,
                  preferredOrder,
                  specialtyMatch: null,
                  currentMessageText: currentMessageText || null,
                  ticketCounts,
                  loadBalanceEnabled: routingConfig.load_balance_enabled,
                });
                let selectedUser = choice.user as any;
                if (!selectedUser) selectedUser = fetchRes.online[0];
                console.log(
                  `[Webhook] agendar - CBT outage: selected attendant ${selectedUser?.name} (reason=${choice.reason})`,
                );

                if (!isTestMode && senderPhone && selectedUser) {
                  let formattedPhone = senderPhone.replace(/\D/g, "");
                  if (!formattedPhone.startsWith("55")) formattedPhone = "55" + formattedPhone;
                  const transferResult = await transferTicketToHuman({
                    baseUrl,
                    apiId,
                    bearerToken,
                    phone: formattedPhone,
                    userId: selectedUser.id,
                    channelId,
                    // Alvo escolhido por regra/balanceamento: re-atribui dona stale
                    forceReassign: true,
                  });
                  if (transferResult.ok) {
                    console.log(
                      `[Webhook] agendar - CBT outage: ✅ Transfer successful to ${selectedUser.name} (attempt=${transferResult.attempt})`,
                    );
                    { // política 21/07: registrar SEMPRE (o executor agora só AVISA, nunca troca de mão)
                      await recordPendingHumanTransfer(supabaseClient, {
                        clinicTokenId,
                        conversationId:
                          ((globalThis as any).__currentConversationId as string | undefined) || null,
                        phone: formattedPhone,
                        intent: "widget_outage_transfer",
                        ...avisoSemDona(),
                        timeoutMinutes: routingConfig.human_response_timeout_minutes,
                      });
                    }
                  } else {
                    console.error(
                      `[Webhook] agendar - CBT outage: Transfer FAILED (status=${transferResult.httpStatus}, detail=${transferResult.errorDetail})`,
                    );
                  }
                }
              } else {
                console.log(`[Webhook] agendar - CBT outage: no online attendants available`);
              }
            } catch (e) {
              console.error(`[Webhook] agendar - CBT outage transfer error:`, e);
            }
          } else {
            console.log(`[Webhook] agendar - CBT outage: no avanceaiConfig, sending message only`);
          }

          return {
            status: "success",
            bypassAiRewrite: true,
            intentOverride: "widget_outage_transfer",
            response: outageMessage,
          } as any;
        }

        // ── WIDGET-FIRST OFFER (simplified) ──
        // If intent is "agendar" AND clinic has an active booking widget AND
        // we haven't sent the link in the last 2h AND patient hasn't opted out,
        // send the fixed CTA immediately. No regex/disqualifier gating — the LLM
        // already classified the intent for us.
        console.log(
          `[Webhook][${WEBHOOK_VERSION}] agendar - Entered widget CTA block (clinicTokenId=${clinicTokenId ? "yes" : "no"}, currentConvId=${conversationIdParam || (globalThis as any).__currentConversationId ? "yes" : "no"})`,
        );
        if (supabaseClient && clinicTokenId) {
          try {
            const { data: widget } = await supabaseClient
              .from("booking_widgets")
              .select("widget_key, is_active, widget_config")
              .eq("clinic_token_id", clinicTokenId)
              .eq("is_active", true)
              .limit(1)
              .maybeSingle();

            console.log(
              `[Webhook] agendar - Widget lookup: active=${widget?.is_active === true}, hasKey=${widget?.widget_key ? "yes" : "no"}`,
            );

            if (widget?.is_active) {
              // Anti-spam + opt-out check using the CURRENT conversationId (not phone lookup)
              const cutoff2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
              const currentConvId = conversationIdParam || (globalThis as any).__currentConversationId as string | undefined;

              let linkRecentlySent = false;
              let patientPreferredHere = false;

              if (currentConvId) {
                const { data: recentOut } = await supabaseClient
                  .from("webhook_messages")
                  .select("ai_response, message_text, direction, created_at")
                  .eq("conversation_id", currentConvId)
                  .order("created_at", { ascending: false })
                  .limit(20);

                if (Array.isArray(recentOut)) {
                  for (const m of recentOut) {
                    if (
                      m.direction === "outgoing" &&
                      m.created_at >= cutoff2h &&
                      (
                        (m.ai_response && (/\/agendar\/[0-9a-f-]{36}/i.test(m.ai_response) || /cbtortopedia\.com\.br\/agendamento/i.test(m.ai_response))) ||
                        (m.message_text && (/\/agendar\/[0-9a-f-]{36}/i.test(m.message_text) || /cbtortopedia\.com\.br\/agendamento/i.test(m.message_text)))
                      )
                    ) {
                      linkRecentlySent = true;
                    }
                    if (
                      m.direction === "incoming" &&
                      m.message_text &&
                      /(prefiro\s+(por\s+)?aqui|continuar\s+por\s+aqui|n[aã]o\s+quero\s+(o\s+)?link|aqui\s+mesmo|pelo\s+whats)/i
                        .test(m.message_text)
                    ) {
                      patientPreferredHere = true;
                    }
                  }
                }
              } else {
                console.log(`[Webhook] agendar - No currentConversationId in scope; proceeding without anti-spam check`);
              }

              // S3 (relatorio 23/06 Conv. 6 Sandra, Conv. 11 Rose): se paciente JA'
              // mencionou medico, subespecialidade ou queixa especifica, NAO mandar o
              // link generico "me contar qual medico voce procura" — ir direto pra
              // verificacao de agenda. Reduz friccao e evita parecer que IA "ignorou"
              // o que o paciente ja' disse.
              const patientGaveContext = !!(
                (entities.doctor_name && entities.doctor_name.trim().length > 1) ||
                (entities.subspecialty && entities.subspecialty.trim().length > 1) ||
                (entities.complaint && entities.complaint.trim().length > 3)
              );

              // Tema 6 (relatorio 24/06 Amostra 1): paciente confirmou "dia 25/06 as 14:00",
              // IA disse success, MAS depois mandou widget link e voltou a pedir horario.
              // Pra evitar isso, se ja' ha date+time em ai_entities recente (paciente OU
              // IA persistiu) NAO mandar o link — o agendamento esta em curso e mandar
              // link reseta o fluxo.
              let bookingInProgress = false;
              if (!entities.date || !entities.time) {
                // Tambem checa entidades atuais — se ja' tem date+time direto, idem.
              } else {
                bookingInProgress = true;
              }
              if (!bookingInProgress && currentConvId) {
                try {
                  const cutoff30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();
                  const { data: recentEntities } = await supabaseClient
                    .from("webhook_messages")
                    .select("ai_entities")
                    .eq("conversation_id", currentConvId)
                    .not("ai_entities", "is", null)
                    .gte("created_at", cutoff30m)
                    .order("created_at", { ascending: false })
                    .limit(8);
                  for (const m of recentEntities || []) {
                    const ent = (m as any).ai_entities as Record<string, unknown> | null;
                    const d = ent && (ent.date as string);
                    const t = ent && (ent.time as string);
                    if (d && t && String(d).length > 0 && String(t).length > 0) {
                      bookingInProgress = true;
                      break;
                    }
                  }
                } catch (_) {
                  /* non-blocking */
                }
              }

              if (linkRecentlySent) {
                console.log(`[Webhook] agendar - Widget link skipped: already sent in last 2h`);
              } else if (patientPreferredHere) {
                console.log(`[Webhook] agendar - Widget link skipped: patient opted out (prefiro por aqui)`);
              } else if (patientGaveContext) {
                console.log(
                  `[Webhook] agendar - Widget link skipped: patient already gave context (doctor="${entities.doctor_name}", subspecialty="${entities.subspecialty}", complaint="${(entities.complaint || "").slice(0, 30)}")`,
                );
              } else if (bookingInProgress) {
                console.log(
                  `[Webhook] agendar - Widget link skipped: booking in progress (date+time recente em ai_entities) — Tema 6 Amostra 1`,
                );
              } else {
                const widgetConfig = (widget as any).widget_config as Record<string, unknown> | null;
                const widgetUrl = widgetConfig?.custom_url
                  ? String(widgetConfig.custom_url)
                  : `${WIDGET_BASE_URL}/agendar/${widget.widget_key}`;
                console.log(
                  `[Webhook] agendar - ✅ Sending widget link to ${senderPhone || "?"} (clinic=${clinicTokenId}, convId=${currentConvId || "n/a"})`,
                );

                // ── Schedule a 15-minute follow-up to check if patient booked via widget ──
                try {
                  if (senderPhone) {
                    // Anti-duplication: skip if a widget_link follow-up was created in last 30 min
                    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
                    const { data: existingFollowUp } = await supabaseClient
                      .from("pending_followups")
                      .select("id")
                      .eq("phone", senderPhone)
                      .eq("type", "widget_link")
                      .eq("status", "pending")
                      .gte("created_at", thirtyMinAgo)
                      .limit(1)
                      .maybeSingle();

                    if (!existingFollowUp) {
                      const executeAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
                      const { error: followUpErr } = await supabaseClient
                        .from("pending_followups")
                        .insert({
                          conversation_id: currentConvId || null,
                          phone: senderPhone,
                          clinic_token_id: clinicTokenId,
                          scheduled_at: executeAt,
                          status: "pending",
                          type: "widget_link",
                          metadata: {
                            widget_url: widgetUrl,
                            link_sent_at: new Date().toISOString(),
                          },
                        });

                      if (followUpErr) {
                        console.log(`[Webhook] agendar - widget_link follow-up insert error: ${followUpErr.message}`);
                      } else {
                        console.log(`[Webhook] agendar - 📅 widget_link follow-up scheduled for ${executeAt} (conv=${currentConvId || "n/a"})`);
                      }
                    } else {
                      console.log(`[Webhook] agendar - widget_link follow-up already pending (skip duplicate)`);
                    }
                  }
                } catch (followUpScheduleErr) {
                  console.log(`[Webhook] agendar - follow-up schedule error (non-blocking): ${(followUpScheduleErr as Error).message}`);
                }

                return {
                  status: "success",
                  // Sentinel flag so the response layer skips the LLM rewrite (which would strip/alter the URL)
                  bypassAiRewrite: true,
                  intentOverride: "widget_link_sent",
                  response:
                    `Oi! 😊 Posso te ajudar a agendar de duas formas:\n\n` +
                    `👉 *Clique aqui para agendar online:*\n${widgetUrl}\n\n` +
                    `Ou, se preferir, é só me contar por aqui qual médico você procura, ou o que está sentindo, que eu te ajudo a encontrar o melhor horário.`,
                } as any;
              }
            } else {
              console.log(`[Webhook] agendar - Widget not active for this clinic; falling back to AI flow`);
            }
          } catch (widgetErr) {
            console.log(
              `[Webhook] agendar - Widget offer check error (non-blocking): ${(widgetErr as Error).message}`,
            );
          }
        }

        // BUG-1 FIX: normalize date/time to canonical format BEFORE any downstream use.
        // This propagates the canonical value to slot lock, conflict check, double validation,
        // POST attendances, and the row inserted into pending_booking_verifications.
        if (entities.date) {
          const normalized = normalizeDateToISO(entities.date);
          if (normalized && normalized !== entities.date) {
            console.log(`[Webhook] agendar - normalized date "${entities.date}" -> "${normalized}"`);
          }
          if (normalized) entities.date = normalized;
        }
        if (entities.time) {
          const normT = normalizeTimeToHHMM(entities.time);
          if (normT && normT !== entities.time) {
            console.log(`[Webhook] agendar - normalized time "${entities.time}" -> "${normT}"`);
          }
          if (normT) entities.time = normT;
        }
        // === BUG-FIX #3: invalidar time se nenhum hint de médico/subespecialidade foi dado ===
        // Step 6.5 só valida slot quando doctorId está resolvido. Se o LLM extraiu um time
        // mas não há doctor_name nem subspecialty, o time pode fluir sem checagem até o POST.
        // Limpando agora, o fluxo re-pergunta após resolver o médico (Step 6 mostra slots reais).
        if (entities.time && !entities.doctor_name && !entities.subspecialty) {
          console.log(
            `[Webhook] agendar - ⚠️ time="${entities.time}" extraído sem doctor_name/subspecialty — limpando para evitar commit prematuro`,
          );
          entities.time = "";
        }
        // Step 1: Check CPF - try to identify by phone first
        if (!entities.cpf && senderPhone && supabaseClient) {
          // PRIORITY: Check conversation history for previously provided CPF before phone lookup
          const conversationForPhone = await supabaseClient
            .from("chat_conversations")
            .select("id")
            .eq("phone", senderPhone.replace(/\D/g, ""))
            .limit(1)
            .maybeSingle();

          if (conversationForPhone?.data?.id) {
            const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            const { data: histMsgs } = await supabaseClient
              .from("webhook_messages")
              .select("ai_entities")
              .eq("conversation_id", conversationForPhone.data.id)
              .eq("direction", "incoming")
              .not("ai_entities", "is", null)
              .gte("created_at", cutoff48h)
              .order("created_at", { ascending: false })
              .limit(15);

            for (const msg of histMsgs || []) {
              const ent = msg.ai_entities as Record<string, unknown>;
              if (ent?.cpf) {
                entities.cpf = String(ent.cpf);
                console.log("[Webhook] Recovered CPF from conversation history (phone lookup bypass): " + entities.cpf);
                break;
              }
            }
          }

          if (!entities.cpf) {
            // Try multiple phone formats for matching
            const phoneDigits = senderPhone.replace(/\D/g, "");
            const phoneVariants: string[] = [];
            // Try without country code FIRST (Amigo stores phones without 55)
            if (phoneDigits.startsWith("55") && phoneDigits.length >= 12) {
              phoneVariants.push(phoneDigits.substring(2));
            }
            phoneVariants.push(phoneDigits);
            // Also try with +55
            phoneVariants.push(`+${phoneDigits}`);
            phoneVariants.push(`+55${phoneDigits.startsWith("55") ? phoneDigits.substring(2) : phoneDigits}`);

            // Use canonical helper for variants (handles 55 prefix + 9th digit toggle).
            // Removed previous `phone.ilike.%<slice(-9)>%` fuzzy match — it was the
            // root cause of #2 in the audit: two different patients whose phones
            // share the last 9 digits would collide and the bot picked the wrong CPF.
            const safeVariants = getPhoneVariants(phoneDigits);
            console.log(`[Webhook] Looking up patient by phone variants (safe): ${safeVariants.join(", ")}`);

            const { data: localPatient } = await supabaseClient
              .from("local_patients")
              .select("cpf, name, phone")
              .in("phone", safeVariants)
              .limit(1)
              .maybeSingle();

            // CASO GABRIELA 17/08 — O CACHE PODRE AINDA MORDE NA LEITURA.
            // Em 16/08 fechamos a ESCRITA do CPF mascarado, mas 456 das 1.425 linhas
            // já estavam podres desde antes, e elas continuam sendo lidas. Foi o que
            // aconteceu hoje: a linha da Gabriela, gravada em 15/07 com
            // `***.469.254-**`, injetou esse lixo em entities.cpf; a busca seguinte
            // virou `patients/exists?cpf=469254`, não achou ninguém, e a Julia disse
            // "não encontrei seu cadastro" para uma paciente cadastrada desde julho
            // (amigo_patient_id 111849494). Ela reenviou nome, nascimento, endereço e
            // convênio — 3 minutos — e quando a marcação foi tentada, a vaga das 10:20
            // tinha ido embora.
            // Sanear na LEITURA neutraliza as 456 linhas antigas sem tocar em dado de
            // paciente no banco: sem 11 dígitos, é como se não houvesse CPF — e aí o
            // sistema pede, que é o certo.
            const _cpfDoCache = cpfLimpoOuVazio(localPatient?.cpf);
            if (_cpfDoCache) {
              entities.cpf = _cpfDoCache;
              console.log(`[Webhook] Found patient by phone: ${localPatient.name}`);
            } else if (localPatient?.cpf) {
              console.log(`[Webhook] Cache tem CPF inválido para este telefone ("${String(localPatient.cpf).slice(0, 6)}...") — ignorando e seguindo sem CPF`);
            }

            if (!entities.cpf) {
              // Fallback: try Amigo API by phone
              console.log(`[Webhook] No patient found locally by phone, trying Amigo API...`);
              const phoneDigitsForAmigo = senderPhone.replace(/\D/g, "");
              // Try with full number and without country code
              const phonesToTry: string[] = [];
              // Try without country code FIRST (Amigo stores phones without 55)
              if (phoneDigitsForAmigo.startsWith("55") && phoneDigitsForAmigo.length >= 12) {
                phonesToTry.push(phoneDigitsForAmigo.substring(2));
              }
              phonesToTry.push(phoneDigitsForAmigo);
              for (const tryPhone of phonesToTry) {
                try {
                  const amigoPhoneResult = await tryFetch(
                    `patients/exists?contact_cellphone=${tryPhone}&company_id=${companyId}`,
                    amigoToken,
                  );
                  const amigoPhoneData = normalizeApiResponse(amigoPhoneResult) as Record<string, unknown>;
                  console.log(
                    `[Webhook] Amigo phone lookup (${tryPhone}) status=${amigoPhoneResult.status}: ${JSON.stringify(amigoPhoneData).substring(0, 300)}`,
                  );
                  if (
                    amigoPhoneData &&
                    amigoPhoneResult.status < 400 &&
                    (amigoPhoneData.cpf || amigoPhoneData.document)
                  ) {
                    const foundCpf = String(amigoPhoneData.cpf || amigoPhoneData.document || "");
                    const foundName = String(amigoPhoneData.name || amigoPhoneData.full_name || "");
                    const _cpfApi = cpfLimpoOuVazio(foundCpf);
                    if (_cpfApi) {
                      entities.cpf = _cpfApi;
                      console.log(`[Webhook] Found patient by phone via Amigo API: ${foundName} (CPF: ${foundCpf})`);
                      // Save to local_patients for future lookups
                      if (supabaseClient && clinicTokenId) {
                        try {
                          const { data: existingWebhook } = await supabaseClient
                            .from("user_webhooks")
                            .select("user_id")
                            .eq("clinic_token_id", clinicTokenId)
                            .limit(1)
                            .maybeSingle();
                          const ownerUserId = existingWebhook?.user_id;
                          if (ownerUserId) {
                            await supabaseClient.from("local_patients").upsert(
                              {
                                user_id: ownerUserId,
                                phone: phoneDigitsForAmigo,
                                cpf: _cpfApi,
                                name: foundName || "Paciente",
                                amigo_patient_id: String(amigoPhoneData.id || amigoPhoneData.patient_id || ""),
                              },
                              { onConflict: "user_id,cpf", ignoreDuplicates: true },
                            );
                            console.log(`[Webhook] Saved patient to local_patients`);
                          }
                        } catch (saveErr) {
                          console.log(`[Webhook] Could not save to local_patients: ${saveErr.message}`);
                        }
                      }
                      // Store patient name for response
                      (entities as any)._patientName = foundName;
                      break;
                    }
                  }
                } catch (amigoErr) {
                  console.log(`[Webhook] Amigo phone lookup error: ${amigoErr.message}`);
                }
              }
              if (!entities.cpf) {
                console.log(`[Webhook] No patient found by phone anywhere, will ask for CPF`);
              }
            }
          } // end if (!entities.cpf) - phone lookup block

          // Third-party scheduling detection: if phone lookup found a patient
          // but the user mentioned a DIFFERENT patient name, discard the CPF
          // so the system asks for the correct patient's CPF
          if (entities.cpf && entities.patient_full_name) {
            const foundPatName = ((entities as any)._patientName || "")
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "");
            const requestedPatName = entities.patient_full_name
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "");
            const requestedWords = requestedPatName.split(/\s+/).filter((w: string) => w.length > 2);
            const nameMatch =
              requestedWords.length === 0 || requestedWords.every((w: string) => foundPatName.includes(w));
            if (!nameMatch) {
              console.log(
                `[Webhook] Third-party scheduling detected: phone patient="${(entities as any)._patientName}" but requested="${entities.patient_full_name}" — clearing CPF to ask for correct patient`,
              );
              entities.cpf = "";
              delete (entities as any)._patientName;
            }
          }
        }

        // CPF and patient lookup moved to AFTER doctor+date+time selection (see below)
        // events/places fetch also deferred to AFTER doctor selection (not needed for listing doctors)

        // Step 4: Find doctor - check doctor_settings for schedulable doctors
        let doctorId: string | undefined;
        let doctorName: string | undefined;

        // Fetch all doctors from API
        const docsResult = await tryFetch(`doctors?company_id=${companyId}`, amigoToken);
        const allDoctors = normalizeApiResponse(docsResult) as Array<Record<string, unknown>>;
        // Tema 3: queda do Amigo (502/5xx) != "clinica sem medicos". Nao diz ao
        // paciente que nao ha medicos quando na verdade a API caiu.
        if (isAuthApiFailure(docsResult.status)) {
          return { status: "transient_error", response: AMIGO_AUTH_MESSAGE, bypassAiRewrite: true, error: amigoAuthAlert(docsResult.status, "doctors") };
        }
        if (isTransientApiFailure(docsResult.status)) {
          return { status: "transient_error", response: TRANSIENT_API_MESSAGE, bypassAiRewrite: true, error: `Amigo transient ${docsResult.status} (doctors) [${amigoFailReason(docsResult.data)}]` };
        }

        // Filter by doctor_settings if available (exclusion logic: doctors WITHOUT a record are considered schedulable)
        let schedulableDoctors = Array.isArray(allDoctors) ? allDoctors : [];
        const subspecialtyMap = new Map<string, string>();
        // ENCAIXE GERAL (regra do dono, 11/08): quando o especialista da queixa não
        // tem vaga, o substituto sai do rodízio GERAL — "todos menos Luiz Gustavo e
        // Hugo, que são mais específicos". Quem está aqui não pode ser oferecido
        // como alternativa; continua atendendo normalmente quem o procura pelo nome
        // ou pela própria subespecialidade. O dado é editável em doctor_settings.
        const semEncaixeGeralAg = new Set<string>();

        if (supabaseClient && clinicTokenId) {
          const { data: doctorSettingsData } = await supabaseClient
            .from("doctor_settings")
            .select("doctor_id, doctor_name, is_schedulable, subspecialty, general_fallback")
            .eq("clinic_token_id", clinicTokenId);

          if (doctorSettingsData && doctorSettingsData.length > 0) {
            // Build set of explicitly DISABLED doctors
            const disabledIds = new Set(
              doctorSettingsData
                .filter((ds: any) => ds.is_schedulable === false)
                .map((ds: any) => String(ds.doctor_id)),
            );
            // Exclude only explicitly disabled doctors (no record = schedulable)
            schedulableDoctors = schedulableDoctors.filter((d) => !disabledIds.has(String(d.id)));

            // Build subspecialty map from all records that have one (regardless of is_schedulable, since we already filtered)
            for (const ds of doctorSettingsData) {
              if (ds.subspecialty) {
                subspecialtyMap.set(String(ds.doctor_id), ds.subspecialty as string);
              }
              if (ds.general_fallback === false) semEncaixeGeralAg.add(String(ds.doctor_id));
            }

            console.log(
              `[Webhook] Filtered to ${schedulableDoctors.length} schedulable doctors out of ${allDoctors.length} (${disabledIds.size} explicitly disabled)`,
            );

            // PRIORITY 1: Match by doctor_name BEFORE subspecialty (doctor name takes precedence)
            const removeAccentsEarly = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            // Strip titles (Dr., Dra., Doutor, Doutora, Sr., Sra.) before matching.
            // These words appear in patient speech but usually not in the database name.
            const stripDoctorNoiseWords = (s: string): string => {
              return s
                .replace(/\b(dr|dra|doutor|doutora|sr|sra)\.?\b/gi, "")
                .replace(/\s+/g, " ")
                .trim();
            };
            if (entities.doctor_name && !doctorId) {
              // Check if doctor_name contains multiple doctors (separated by " e ", " e o ", ", ")
              const multiSeparatorRegex = /\s+e\s+o\s+|\s+e\s+|,\s*/i;
              const doctorNameParts = entities.doctor_name
                .split(multiSeparatorRegex)
                .map((s: string) => s.trim())
                .filter((s: string) => s.length > 0);

              if (doctorNameParts.length > 1) {
                // Multiple doctors requested — find each one individually
                const matchedDoctors = [];
                for (const namePart of doctorNameParts) {
                  const searchWordsMulti = removeAccentsEarly(stripDoctorNoiseWords(namePart).toLowerCase())
                    .split(/\s+/)
                    .filter((w) => w.length > 0);
                  const match = schedulableDoctors.find((d) => {
                    const fullName = removeAccentsEarly(((d.name as string) || "").toLowerCase());
                    return searchWordsMulti.every((w) => fullName.includes(w));
                  });
                  if (match) matchedDoctors.push(match);
                }

                if (matchedDoctors.length >= 2) {
                  // Filter schedulableDoctors to only the matched ones, let multi-doctor flow handle it
                  schedulableDoctors = matchedDoctors;
                  console.log(
                    `[Webhook] Matched ${matchedDoctors.length} doctors by multi-name: ${matchedDoctors.map((d) => d.name).join(", ")}`,
                  );
                  // Do NOT set doctorId — this will fall through to the multi-doctor schedule block
                } else if (matchedDoctors.length === 1) {
                  // Only one of the requested doctors was found
                  doctorId = String(matchedDoctors[0].id);
                  doctorName = (matchedDoctors[0].name as string) || entities.doctor_name;
                  console.log(`[Webhook] Only 1 of ${doctorNameParts.length} requested doctors found: ${doctorName}`);
                } else {
                  return {
                    status: "needs_info",
                    response: "",
                    error: `Não encontrei os médicos "${entities.doctor_name}". Os médicos disponíveis são: ${schedulableDoctors.map((d) => d.name).join(", ")}`,
                  };
                }
              } else {
                // Single doctor name. Filtra tokens de 1 caractere: artigos "o"/"a"/"e"
                // casariam QUALQUER nome via includes, e se o LLM extrair só um título
                // ("doutor"), stripDoctorNoiseWords zera tudo → searchWords vazio →
                // [].every() é vacuosamente true → .find() pegava o 1º médico à toa.
                const searchWordsSingle = removeAccentsEarly(stripDoctorNoiseWords(entities.doctor_name).toLowerCase())
                  .split(/\s+/)
                  .filter((w) => w.length >= 2);
                // filter (não find): coleta TODOS os médicos que casam, pra desambiguar.
                const nameMatchesSingle = searchWordsSingle.length > 0
                  ? schedulableDoctors.filter((d) => {
                      const fullName = removeAccentsEarly(((d.name as string) || "").toLowerCase());
                      return searchWordsSingle.every((w) => fullName.includes(w));
                    })
                  : [];
                if (nameMatchesSingle.length > 1) {
                  // Ex: dois "Vinícius" — pergunta qual, nunca escolhe o 1º silenciosamente
                  return {
                    status: "needs_info",
                    response: "",
                    error: `Temos mais de um profissional com esse nome: ${nameMatchesSingle.map((d) => d.name).join(", ")}. Com qual deles você prefere agendar?`,
                  } as any;
                }
                const nameMatch = nameMatchesSingle[0];
                if (nameMatch) {
                  doctorId = String(nameMatch.id);
                  doctorName = (nameMatch.name as string) || entities.doctor_name;
                  console.log(
                    `[Webhook] Matched doctor by name (priority over subspecialty): ${doctorName} (${doctorId})`,
                  );
                } else {
                  // Before giving up, check conversation history for doctor names
                  // FIX (ReferenceError 30/06-01/07): este bloco referenciava
                  // `conversationHistory`, que NAO existe no escopo de executeAction —
                  // o parametro chama-se `recentMessages`. Crash em toda consulta cujo
                  // nome de medico nao casava (caso Gustavo/Dr. Hugo 01/07). Alem do
                  // rename, o formato {role,content} nao tem ai_entities — as entidades
                  // vem embutidas no comentario <!-- intent=X doctor=Y --> do content.
                  let historyMatch: typeof nameMatch = undefined;
                  if (recentMessages && recentMessages.length > 0) {
                    const recentEntities = recentMessages
                      .slice(-5)
                      .map((m: any) => {
                        if (m.ai_entities) {
                          try { return typeof m.ai_entities === 'string' ? JSON.parse(m.ai_entities) : m.ai_entities; } catch { return null; }
                        }
                        const dm = typeof m.content === "string" ? m.content.match(/<!--[^>]*\bdoctor=([^>]*?)(?=\s+\w+=|\s*-->)/) : null;
                        return dm ? { doctor_name: dm[1].trim() } : null;
                      })
                      .filter(Boolean);
                    
                    for (const ent of recentEntities) {
                      const histDocName = ent?.doctor_name;
                      if (histDocName && histDocName !== entities.doctor_name) {
                        const histWords = removeAccentsEarly(stripDoctorNoiseWords(histDocName).toLowerCase()).split(/\s+/).filter((w: string) => w.length > 0);
                        historyMatch = schedulableDoctors.find((d) => {
                          const fullName = removeAccentsEarly(((d.name as string) || "").toLowerCase());
                          return histWords.every((w: string) => fullName.includes(w));
                        });
                        if (historyMatch) {
                          console.log(`[Webhook] Doctor name fallback from history: "${histDocName}" matched ${historyMatch.name}`);
                          break;
                        }
                      }
                    }
                  }
                  
                  if (historyMatch) {
                    doctorId = String(historyMatch.id);
                    doctorName = (historyMatch.name as string) || entities.doctor_name;
                    console.log(`[Webhook] Matched doctor via history fallback: ${doctorName} (${doctorId})`);
                  } else if (searchWordsSingle.length > 0) {
                    // searchWords vazio (só título) NÃO cai aqui — existsInAll seria
                    // vacuosamente true; deixa doctorId undefined e cai no fluxo adiante.
                    const existsInAll =
                      Array.isArray(allDoctors) &&
                      allDoctors.find((d) => {
                        const fullName = removeAccentsEarly(((d.name as string) || "").toLowerCase());
                        return searchWordsSingle.every((w) => fullName.includes(w));
                      });
                    if (existsInAll) {
                      return {
                        status: "needs_info",
                        response: "",
                        error: `O profissional ${entities.doctor_name} não está disponível para agendamento no momento. Os médicos disponíveis são: ${schedulableDoctors.map((d) => d.name).join(", ")}`,
                      };
                    }
                    console.log(`[Webhook] ⚠️ Doctor name matching FAILED for "${entities.doctor_name}". Schedulable doctors: ${schedulableDoctors.map(d => `${d.name}(${d.id})`).join(', ')}`);
                    return {
                      status: "needs_info",
                      response: "",
                      error: `Não encontrei o médico "${entities.doctor_name}". Os médicos disponíveis são: ${schedulableDoctors.map((d) => d.name).join(", ")}`,
                    };
                  }
                }
              }
            }

            // PRIORITY 2: If no doctor matched by name, try subspecialty
            if (entities.subspecialty && !doctorId) {
              const normalizedSearch = normalizeForMatching(entities.subspecialty);
              const matchingBySubspecialty = schedulableDoctors.filter((d) => {
                const sub = subspecialtyMap.get(String(d.id));
                if (!sub) return false;
                const normalizedSub = normalizeForMatching(sub);
                return normalizedSub.includes(normalizedSearch) || normalizedSearch.includes(normalizedSub);
              });
              if (matchingBySubspecialty.length > 0) {
                schedulableDoctors = matchingBySubspecialty;
                console.log(
                  `[Webhook] Filtered to ${matchingBySubspecialty.length} doctors matching subspecialty "${entities.subspecialty}"`,
                );
                // Auto-select if only 1 doctor matches the subspecialty
                if (matchingBySubspecialty.length === 1 && !doctorId) {
                  doctorId = String(matchingBySubspecialty[0].id);
                  doctorName = (matchingBySubspecialty[0].name as string) || entities.subspecialty;
                  console.log(`[Webhook] Auto-selected single subspecialty match: ${doctorName} (${doctorId})`);
                }
              } else {
                // QUEIXA GENÉRICA AMBÍGUA (casos Danielly/Renata 14/07): "perna" e "braço"
                // cobrem VÁRIOS especialistas. Despejar a lista inteira faz o paciente
                // desistir ("dor na perna" → 8 médicos → pediu atendente). Em vez disso
                // perguntamos a localização; a resposta ("joelho"/"ombro"/…) volta como
                // subspecialty resolvível. Só intercepta termos que HOJE já caem no dump.
                const _genericComplaintClarify = {
                  perna: "no joelho, no quadril ou no tornozelo/pé",
                  braco: "no ombro, no cotovelo ou na mão/punho",
                };
                const _complaintKey = normalizeForMatching(entities.subspecialty);
                const _clarify = Object.hasOwn(_genericComplaintClarify, _complaintKey)
                  ? _genericComplaintClarify[_complaintKey]
                  : null;
                if (_clarify) {
                  console.log(
                    `[Qualificacao] queixa genérica "${entities.subspecialty}" → pergunta de localização (não despeja a lista)`,
                  );
                  return {
                    status: "needs_info",
                    response: "",
                    error: `Pra eu te indicar o especialista certo, a dor é mais ${_clarify}?`,
                  };
                }
                // No exact match - list available subspecialties for patient to choose
                const availableSubs = Array.from(subspecialtyMap.entries())
                  .filter(
                    ([id]) =>
                      !new Set(
                        doctorSettingsData
                          .filter((ds: any) => ds.is_schedulable === false)
                          .map((ds: any) => String(ds.doctor_id)),
                      ).has(id),
                  )
                  .map(([id, sub]) => {
                    const doc = schedulableDoctors.find((d) => String(d.id) === id);
                    return doc ? `${doc.name} (${sub})` : null;
                  })
                  .filter(Boolean);
                if (availableSubs.length > 0) {
                  return {
                    status: "needs_info",
                    response: "",
                    error: `Não encontrei especialista em "${entities.subspecialty}". Os especialistas disponíveis são: ${availableSubs.join(", ")}. Com qual gostaria de agendar?`,
                  };
                }
              }
            }
          } else {
            console.log(
              `[Webhook] No doctor_settings records found - all ${schedulableDoctors.length} doctors are schedulable by default`,
            );
          }
        }

        // PRIORITY 3: Resolve doctor from a locked slot. When the patient picks a specific
        // date+time but does NOT name the doctor (e.g. options from multiple doctors were
        // presented and they replied "11/06 às 14h"), the slot we locked at presentation time
        // carries the (date, time) → doctor_id mapping. This is the only reliable way to know
        // which doctor that slot belonged to. Only runs as a fallback (no doctor resolved yet).
        if (!doctorId && entities.date && entities.time && supabaseClient && clinicTokenId) {
          try {
            const lockPhone = (senderPhone || "").replace(/\D/g, "");
            const phoneVariantsLock = [
              lockPhone,
              lockPhone.startsWith("55") ? lockPhone.slice(2) : `55${lockPhone}`,
            ];
            const slotTimeNorm = entities.time.length === 5 ? entities.time + ":00" : entities.time;
            const { data: matchedLocks } = await supabaseClient
              .from("slot_locks")
              .select("doctor_id, slot_date, slot_time")
              .eq("clinic_token_id", clinicTokenId)
              .in("phone", phoneVariantsLock)
              .eq("slot_date", entities.date)
              .eq("slot_time", slotTimeNorm)
              .gt("expires_at", new Date().toISOString())
              .order("locked_at", { ascending: false })
              .limit(1);
            if (matchedLocks && matchedLocks.length > 0) {
              const lockedDoctorId = String(matchedLocks[0].doctor_id);
              const matchedDoc = schedulableDoctors.find((d) => String(d.id) === lockedDoctorId);
              if (matchedDoc) {
                doctorId = lockedDoctorId;
                doctorName = (matchedDoc.name as string) || doctorName;
                console.log(
                  `[Webhook] 🔓 Resolved doctor from locked slot: ${doctorName} (${doctorId}) for ${entities.date} ${entities.time}`,
                );
              }
            }
          } catch (e) {
            console.log(`[Webhook] slot-lock doctor resolution error (non-blocking): ${(e as Error).message}`);
          }
        }

        if (schedulableDoctors.length === 0) {
          return { status: "failed", response: "", error: "Não há médicos disponíveis para agendamento no momento." };
        }

        // ===== REGRA DE OURO: Gate de qualificação =====
        // Se o paciente pediu "agendar" sem especificar médico, especialidade NEM data,
        // NÃO buscar calendários — perguntar primeiro o que ele precisa.
        if (!doctorId && !entities.doctor_name && !entities.subspecialty && !entities.date) {
          console.log(
            `[Webhook] REGRA DE OURO: Pedido genérico de agendamento sem médico/especialidade/data — retornando needs_info sem fetch de calendários`,
          );
          return {
            status: "needs_info",
            response: "",
            error:
              "O paciente pediu para agendar mas não especificou médico, especialidade nem data. Pergunte qual especialidade (ex: Joelho, Coluna, Pé, Quadril, Ombro) ou médico de preferência antes de buscar horários.",
          };
        }

        // If no doctor selected yet, fetch schedules for ALL matching doctors
        if (!doctorId) {
          // First fetch events/places so we can query calendars
          const [eventsEarly, placesEarly] = await Promise.all([
            tryFetch(`events?company_id=${companyId}`, amigoToken),
            tryFetch(`places?company_id=${companyId}`, amigoToken),
          ]);
          const earlyEvents = normalizeApiResponse(eventsEarly) as Array<Record<string, unknown>>;
          const earlyPlaces = normalizeApiResponse(placesEarly) as Array<Record<string, unknown>>;

          if (
            Array.isArray(earlyEvents) &&
            earlyEvents.length > 0 &&
            Array.isArray(earlyPlaces) &&
            earlyPlaces.length > 0
          ) {
            const earlyEventId = String(earlyEvents[0].id);
            const earlyPlaceId = String(earlyPlaces[0].id);

            // Fetch available dates for all matching doctors in parallel
            const MAX_SLOTS_PER_DOCTOR = 5;
            const allSchedules: Array<{
              docName: string;
              docId: string;
              sub: string;
              slots: Array<{ date: string; label: string; times: string[] }>;
            }> = [];

            const datePromises = schedulableDoctors.map(async (doc) => {
              try {
                const availResult = await tryFetch(
                  `doctors/${doc.id}/available-dates?event_id=${earlyEventId}&place_id=${earlyPlaceId}&company_id=${companyId}`,
                  amigoToken,
                );
                const availDates = normalizeApiResponse(availResult);
                if (!Array.isArray(availDates) || availDates.length === 0) return null;

                // Fetch calendar for this doctor
                const calResult = await tryFetch(
                  `calendar?place_id=${earlyPlaceId}&event_id=${earlyEventId}&user_id=${doc.id}&company_id=${companyId}`,
                  amigoToken,
                );
                const calData = normalizeApiResponse(calResult) as Array<Record<string, unknown>>;

                // Parse slots from calendar
                const slotsMap = new Map<string, string[]>();
                if (Array.isArray(calData)) {
                  for (const dayObj of calData) {
                    const dateKey = String(dayObj.date || dayObj.day || dayObj.data || "");
                    if (!dateKey) continue;
                    if (_listGateMin && dateKey.slice(0, 10) < _listGateMin) continue; // piso do retorno (convênio)
                    const times: string[] = [];
                    const slotsByUser = (dayObj.slotsByUser || dayObj.slots_by_user || dayObj.slotsbyuser) as
                      | Array<Record<string, unknown>>
                      | undefined;
                    if (slotsByUser && Array.isArray(slotsByUser)) {
                      for (const userSlots of slotsByUser) {
                        const user = (userSlots.user || userSlots.User) as Record<string, unknown> | undefined;
                        const userId = user?.id || userSlots.user_id || userSlots.userId;
                        if (userId && String(userId) !== String(doc.id)) continue;
                        // Fail-closed (30/06 conv 76): bloco SEM userId numa resposta
                        // multi-usuario nao e' atribuivel ao medico consultado — pular
                        // em vez de incluir (incluia a mesma lista pra medicos diferentes).
                        if (!userId && slotsByUser.length > 1) continue;
                        const slots = (userSlots.slots || userSlots.Slots || userSlots.available_slots) as
                          | Array<Record<string, unknown>>
                          | undefined;
                        if (slots && Array.isArray(slots)) {
                          for (const slot of slots) {
                            const raw = String(
                              slot.start_time ||
                                slot.startTime ||
                                slot.start ||
                                slot.time ||
                                slot.hour ||
                                slot.hora ||
                                "",
                            );
                            const match = raw.match(/(\d{2}:\d{2})/);
                            if (match) times.push(match[1]);
                          }
                        }
                      }
                    } else {
                      const directSlots = (dayObj.slots || dayObj.Slots || dayObj.available_slots) as
                        | Array<Record<string, unknown>>
                        | undefined;
                      if (directSlots && Array.isArray(directSlots)) {
                        for (const slot of directSlots) {
                          const slotUserId = slot.user_id || slot.userId || (slot.user as Record<string, unknown>)?.id;
                          if (slotUserId && String(slotUserId) !== String(doc.id)) continue;
                          const raw = String(
                            slot.start_time ||
                              slot.startTime ||
                              slot.start ||
                              slot.time ||
                              slot.hour ||
                              slot.hora ||
                              "",
                          );
                          const match = raw.match(/(\d{2}:\d{2})/);
                          if (match) times.push(match[1]);
                        }
                      }
                    }
                    if (times.length > 0) {
                      slotsMap.set(dateKey, [...new Set(times)].sort());
                    }
                  }
                }

                // Build slots array (limited)
                const docSlots: Array<{ date: string; label: string; times: string[] }> = [];
                let totalSlots = 0;
                const weekDays = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
                for (const dateStr of availDates as string[]) {
                  if (totalSlots >= MAX_SLOTS_PER_DOCTOR) break;
                  // Convert to ISO
                  let isoDate = dateStr;
                  if (dateStr.includes("/")) {
                    const [d, m, y] = dateStr.split("/");
                    isoDate = `${y}-${m}-${d}`;
                  }
                  const slots = slotsMap.get(isoDate);
                  if (!slots || slots.length === 0) continue;
                  const remaining = MAX_SLOTS_PER_DOCTOR - totalSlots;
                  const taken = slots.slice(0, remaining);
                  totalSlots += taken.length;
                  // Format date label
                  const parts = isoDate.split("-").map(Number);
                  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
                  const label = `${String(parts[2]).padStart(2, "0")}/${String(parts[1]).padStart(2, "0")} (${weekDays[dt.getDay()]})`;
                  docSlots.push({ date: isoDate, label, times: taken });
                }

                if (docSlots.length > 0) {
                  const sub = subspecialtyMap.get(String(doc.id)) || "";
                  return { docName: (doc.name as string) || "Médico", docId: String(doc.id), sub, slots: docSlots };
                }
              } catch (e) {
                console.log(`[Webhook] Error fetching schedule for doctor ${doc.id}: ${e.message}`);
              }
              return null;
            });

            const results = await Promise.all(datePromises);
            for (const r of results) {
              if (r) allSchedules.push(r);
            }

            if (allSchedules.length > 0) {
              console.log(`[Webhook] Fetched schedules for ${allSchedules.length} doctors`);
              // Relatorio 06/07 conversa 40 (Henrique): a IA listou 9 especialistas de
              // uma vez. Regra da clinica: NUNCA listar mais de 3 medicos. Sem
              // qualificacao (queixa/regiao), pergunta primeiro; com qualificacao,
              // mostra so os 3 primeiros e oferece filtrar o resto.
              const _hasQualification = Boolean(
                (entities.subspecialty && String(entities.subspecialty).trim().length > 1) ||
                  (entities.complaint && String(entities.complaint).trim().length > 3),
              );
              if (allSchedules.length > 3 && !_hasQualification) {
                console.log(
                  `[Webhook] agendar - ${allSchedules.length} medicos sem qualificacao — perguntando regiao em vez de listar`,
                );
                const qualifyMsg =
                  "Temos diversos especialistas aqui na clínica! 😊 Pra eu te indicar o médico certo: qual região do corpo você quer tratar? (joelho, ombro, coluna, quadril, pé e tornozelo, mão...)";
                return { status: "needs_info", response: qualifyMsg, error: qualifyMsg, bypassAiRewrite: true } as any;
              }
              const shown = allSchedules.slice(0, 3);
              const extraCount = allSchedules.length - shown.length;
              const lines: string[] = [];
              for (const sched of shown) {
                lines.push(`*${sched.docName}*${sched.sub ? ` (${sched.sub})` : ""}:`);
                for (const s of sched.slots) {
                  lines.push(`  ${s.label}: ${s.times.join(", ")}`);
                }
                lines.push("");
              }
              const extraNote = extraCount > 0
                ? `\n(Temos mais ${extraCount} especialistas com agenda — me diga a região do corpo que eu filtro pra você! 😊)\n\n`
                : "";
              const msg = `Encontrei estes especialistas com disponibilidade:\n\n${lines.join("\n")}${extraNote}Qual médico e horário prefere?`;
              return { status: "needs_info", response: msg, error: msg, verifiedSchedule: true } as any;
            }
          }

          // Fallback: just list doctors without schedules (mesma regra dos 3)
          if (schedulableDoctors.length > 3) {
            const qualifyMsg2 =
              "Temos diversos especialistas aqui na clínica! 😊 Pra eu te indicar o médico certo: qual região do corpo você quer tratar? (joelho, ombro, coluna, quadril, pé e tornozelo, mão...)";
            return { status: "needs_info", response: qualifyMsg2, error: qualifyMsg2, bypassAiRewrite: true } as any;
          }
          const doctorList = schedulableDoctors
            .map((d, i) => {
              const sub = subspecialtyMap.get(String(d.id));
              return `${i + 1}. ${d.name}${sub ? ` (${sub})` : ""}`;
            })
            .join("\n");
          return {
            status: "needs_info",
            response: "",
            error: `Para qual médico você gostaria de agendar? Os especialistas disponíveis são:\n${doctorList}`,
          };
        }

        // Step 3: Fetch events (tipos de consulta) and places (unidades) — only needed after doctor selection
        const [eventsResult, placesResult] = await Promise.all([
          tryFetch(`events?company_id=${companyId}`, amigoToken),
          tryFetch(`places?company_id=${companyId}`, amigoToken),
        ]);

        const events = normalizeApiResponse(eventsResult) as Array<Record<string, unknown>>;
        const places = normalizeApiResponse(placesResult) as Array<Record<string, unknown>>;

        // Tema 3: queda do Amigo (502/5xx) != "clinica sem tipos/unidades configurados".
        if (isAuthApiFailure(eventsResult.status) || isAuthApiFailure(placesResult.status)) {
          return { status: "transient_error", response: AMIGO_AUTH_MESSAGE, bypassAiRewrite: true, error: amigoAuthAlert(eventsResult.status || placesResult.status, "events/places") };
        }
        if (isTransientApiFailure(eventsResult.status) || isTransientApiFailure(placesResult.status)) {
          return { status: "transient_error", response: TRANSIENT_API_MESSAGE, bypassAiRewrite: true, error: `Amigo transient (events=${eventsResult.status} places=${placesResult.status})` };
        }
        if (!Array.isArray(events) || events.length === 0) {
          return { status: "failed", response: "", error: "Não há tipos de consulta configurados na clínica." };
        }
        if (!Array.isArray(places) || places.length === 0) {
          return { status: "failed", response: "", error: "Não há unidades configuradas na clínica." };
        }

        // agendar = paciente existente (novo cai em needs_registration) -> consulta normal
        const _pickedEvent = pickEventForBooking(events);
        const eventId = String(_pickedEvent.id);
        const pickedEventName = String((_pickedEvent as any).name || (_pickedEvent as any).nome || "");
        const allEventNames = events.map((e) => String((e as any).name || (e as any).nome || "?")).join(" | ");
        const placeId = String(places[0].id);
        console.log(`[Webhook] Using event_id=${eventId}, place_id=${placeId}`);

        // Navigates the nested slotsByUser structure and filters by doctorId
        const fetchSlotsForDate = async (
          date: string,
          filterDoctorId?: string,
          periodFilter?: string,
        ): Promise<string[]> => {
          try {
            const targetDoctorId = filterDoctorId || doctorId;
            // Convert date to ISO format (YYYY-MM-DD) for the API
            const isoDate = toIsoDate(date);
            // NOTE: Do NOT pass &date= to the Amigo calendar API — it returns wrong data
            // when the date param is specified (e.g. returns 2026-04-10 when asked for 2026-04-22).
            // Client-side filtering by dayDate !== isoDate (below) handles date matching correctly.
            const calUrl = `calendar?place_id=${placeId}&event_id=${eventId}&user_id=${targetDoctorId}&company_id=${companyId}`;

            console.log(`[Webhook] Fetching calendar for ${date} (iso: ${isoDate}): ${calUrl}`);
            const calResult = await tryFetch(calUrl, amigoToken);
            const calData = normalizeApiResponse(calResult) as Array<Record<string, unknown>>;
            console.log(
              `[Webhook] Calendar ${date} response (status ${calResult.status}): ${JSON.stringify(calData).substring(0, 500)}`,
            );
            if (Array.isArray(calData)) {
              const times: string[] = [];
              if (calData.length > 0) {
                console.log(`[Webhook] fetchSlotsForDate dayObj[0] keys: ${Object.keys(calData[0]).join(", ")}`);
              }
              for (const dayObj of calData) {
                // Filter by the correct date in the response (API may return multiple days)
                const dayDate = String(dayObj.date || dayObj.day || dayObj.data || "");
                if (dayDate && dayDate !== isoDate) continue;

                const slotsByUser = (dayObj.slotsByUser ||
                  dayObj.slots_by_user ||
                  dayObj.slotsbyuser ||
                  dayObj.SlotsByUser) as Array<Record<string, unknown>> | undefined;
                if (slotsByUser && Array.isArray(slotsByUser)) {
                  for (const userSlots of slotsByUser) {
                    const user = (userSlots.user || userSlots.User) as Record<string, unknown> | undefined;
                    const userId = user?.id || user?.user_id || user?.Id || userSlots.user_id || userSlots.userId;
                    if (targetDoctorId && userId && String(userId) !== String(targetDoctorId)) continue;
                    // Fail-closed (30/06 conv 76): bloco sem userId em resposta multi-usuario.
                    if (targetDoctorId && !userId && slotsByUser.length > 1) continue;
                    const slots = (userSlots.slots || userSlots.Slots || userSlots.available_slots) as
                      | Array<Record<string, unknown>>
                      | undefined;
                    if (slots && Array.isArray(slots)) {
                      for (const slot of slots) {
                        const raw = String(
                          slot.start_time || slot.startTime || slot.start || slot.time || slot.hour || slot.hora || "",
                        );
                        const match = raw.match(/(\d{2}:\d{2})/);
                        if (match) times.push(match[1]);
                      }
                    }
                  }
                } else {
                  // Fallback: flat slots on dayObj
                  const directSlots = (dayObj.slots ||
                    dayObj.Slots ||
                    dayObj.available_slots ||
                    dayObj.availableSlots) as Array<Record<string, unknown>> | undefined;
                  if (directSlots && Array.isArray(directSlots)) {
                    for (const slot of directSlots) {
                      const slotUserId = slot.user_id || slot.userId || (slot.user as Record<string, unknown>)?.id;
                      if (targetDoctorId && slotUserId && String(slotUserId) !== String(targetDoctorId)) continue;
                      const raw = String(
                        slot.start_time || slot.startTime || slot.start || slot.time || slot.hour || slot.hora || "",
                      );
                      const match = raw.match(/(\d{2}:\d{2})/);
                      if (match) times.push(match[1]);
                    }
                  } else if (
                    dayObj.available === true ||
                    dayObj.status === "available" ||
                    dayObj.status === "AVAILABLE"
                  ) {
                    const raw = String(
                      dayObj.start_time || dayObj.startTime || dayObj.time || dayObj.hour || dayObj.hora || "",
                    );
                    const match = raw.match(/(\d{2}:\d{2})/);
                    if (match) times.push(match[1]);
                  }
                }
              }
              // Remove duplicates, sort, apply period filter
              let unique = [...new Set(times)].sort();
              if (periodFilter === "manha") {
                unique = unique.filter((t) => t < "12:00");
              } else if (periodFilter === "tarde") {
                unique = unique.filter((t) => t >= "12:00");
              }
              return unique.slice(0, 10);
            }
          } catch (e) {
            console.log(`[Webhook] Could not fetch calendar for ${date}:`, e.message);
          }
          return [];
        };

        // Helper: format date as "DD/MM (dia_semana)" - supports both DD/MM/YYYY and YYYY-MM-DD
        const formatDateLabel = (dateStr: string): string => {
          const weekDays = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
          let d: number, m: number, y: number;
          if (dateStr.includes("/")) {
            // DD/MM/YYYY format
            const parts = dateStr.split("/").map(Number);
            d = parts[0];
            m = parts[1];
            y = parts[2];
          } else {
            // YYYY-MM-DD format
            const clean = dateStr.replace(/[TZ]/g, " ").trim().split(" ")[0];
            const parts = clean.split("-").map(Number);
            y = parts[0];
            m = parts[1];
            d = parts[2];
          }
          const dt = new Date(y, m - 1, d);
          const dayName = weekDays[dt.getDay()];
          return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} (${dayName})`;
        };

        // Helper: convert DD/MM/YYYY to YYYY-MM-DD
        const toIsoDate = (dateStr: string): string => {
          if (dateStr.includes("/")) {
            const [d, m, y] = dateStr.split("/");
            return `${y}-${m}-${d}`;
          }
          return dateStr;
        };

        // Helper: get weekday index (0=domingo) from DD/MM/YYYY or YYYY-MM-DD
        const getWeekday = (dateStr: string): number => {
          let d: number, m: number, y: number;
          if (dateStr.includes("/")) {
            const parts = dateStr.split("/").map(Number);
            d = parts[0];
            m = parts[1];
            y = parts[2];
          } else {
            const parts = dateStr.split("-").map(Number);
            y = parts[0];
            m = parts[1];
            d = parts[2];
          }
          return new Date(y, m - 1, d).getDay();
        };

        // Step 4.5: Handle partial dates (month-only like "2026-05") — search for available dates in that month
        const originalDateInput = entities.date || "";
        const wasPartialDate = isPartialDate(originalDateInput);
        if (wasPartialDate && entities.date) {
          const monthNames = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
          const normalizedDate = normalizeDateToISO(originalDateInput);
          const targetMonth = normalizedDate.substring(0, 7); // "YYYY-MM"
          const monthNum = parseInt(normalizedDate.substring(5, 7)) - 1;
          const monthLabel = monthNames[monthNum] || targetMonth;
          console.log(`[Webhook] Partial date detected: "${originalDateInput}" → searching month ${targetMonth}`);
          
          if (doctorId) {
            try {
              const availUrl = `doctors/${doctorId}/available-dates?event_id=${eventId}&place_id=${placeId}&company_id=${companyId}`;
              const availResult = await tryFetch(availUrl, amigoToken);
              const availDates = normalizeApiResponse(availResult);
              
              if (Array.isArray(availDates) && availDates.length > 0) {
                // Filter dates to the requested month
                const monthDates = availDates.filter((d: string) => {
                  const iso = normalizeDateToISO(d);
                  if (_listGateMin && iso < _listGateMin) return false; // piso do retorno (convênio)
                  return iso.startsWith(targetMonth);
                });
                
                if (monthDates.length > 0) {
                  // Show available dates in the month with time slots
                  const top5 = monthDates.slice(0, 5);
                  const slotLines: string[] = [];
                  let firstIsoWithSlots = "";
                  for (const dateStr of top5) {
                    const isoD = normalizeDateToISO(dateStr) || dateStr;
                    const slots = await fetchSlotsForDate(isoD, doctorId);
                    if (slots.length > 0) {
                      if (!firstIsoWithSlots) firstIsoWithSlots = isoD;
                      slotLines.push(`${formatDateLabel(isoD)}: ${slots.slice(0, 5).join(", ")}`);
                    }
                  }
                  if (slotLines.length > 0) {
                    const msg = `Horários disponíveis com ${doctorName || "o médico"} em ${monthLabel}:\n\n${slotLines.join("\n")}\n\nQual data e horário prefere?${_listGateNote}`;
                    return { status: "needs_info", response: msg, error: msg, verifiedSchedule: true } as any;
                  }
                }
                
                // Month has no dates — agenda not yet open
                return {
                  status: "needs_info",
                  response: "",
                  error: `A agenda do(a) ${doctorName || "médico"} para ${monthLabel} ainda não foi aberta no sistema. Gostaria de verificar uma data mais próxima?`,
                };
              }
              
              return {
                status: "needs_info",
                response: "",
                error: `A agenda do(a) ${doctorName || "médico"} para ${monthLabel} ainda não foi aberta no sistema. Gostaria de verificar uma data mais próxima?`,
              };
            } catch (e) {
              console.log(`[Webhook] Partial date fetch error: ${(e as Error).message}`);
            }
          }
          
          // No doctor selected, but partial date — clear the date to let normal flow ask for specifics
          entities.date = "";
        }

        // Step 5: If no date provided, fetch available dates WITH time slots (single calendar call)
        if (!entities.date) {
          if (doctorId) {
            try {
              // 1. Fetch available dates
              const availUrl = `doctors/${doctorId}/available-dates?event_id=${eventId}&place_id=${placeId}&company_id=${companyId}`;
              console.log(`[Webhook] Fetching available dates: ${availUrl}`);
              const availResult = await tryFetch(availUrl, amigoToken);
              const availDates = normalizeApiResponse(availResult);
              console.log(
                `[Webhook] Available dates response (${Array.isArray(availDates) ? availDates.length : 0} dates)`,
              );

              if (Array.isArray(availDates) && availDates.length > 0) {
                // 2. Single calendar call to get ALL slots
                const calUrl = `calendar?place_id=${placeId}&event_id=${eventId}&user_id=${doctorId}&company_id=${companyId}`;
                console.log(`[Webhook] Single calendar call: ${calUrl}`);
                const calResult = await tryFetch(calUrl, amigoToken);
                const calData = normalizeApiResponse(calResult) as Array<Record<string, unknown>>;
                console.log(`[Webhook] Calendar returned ${Array.isArray(calData) ? calData.length : 0} day objects`);

                // 3. Build slotsMap: date ISO → time strings[]
                const slotsMap = new Map<string, string[]>();
                if (Array.isArray(calData)) {
                  // Log the FIRST dayObj to understand the real API structure
                  if (calData.length > 0) {
                    console.log("[Webhook] First dayObj structure: " + JSON.stringify(calData[0]).substring(0, 1500));
                    // Also log all top-level keys
                    console.log("[Webhook] dayObj keys: " + Object.keys(calData[0]).join(", "));
                  }

                  for (const dayObj of calData) {
                    const dateKey = String(dayObj.date || dayObj.day || dayObj.data || "");
                    if (!dateKey) continue;
                    if (_listGateMin && dateKey.slice(0, 10) < _listGateMin) continue; // piso do retorno (convênio)
                    const times: string[] = [];

                    // Try multiple key names for slotsByUser (camelCase, snake_case, lowercase)
                    const slotsByUser = (dayObj.slotsByUser ||
                      dayObj.slots_by_user ||
                      dayObj.slotsbyuser ||
                      dayObj.SlotsByUser) as Array<Record<string, unknown>> | undefined;

                    if (slotsByUser && Array.isArray(slotsByUser)) {
                      for (const userSlots of slotsByUser) {
                        // Try multiple key names for user id
                        const user = (userSlots.user || userSlots.User) as Record<string, unknown> | undefined;
                        const userId = user?.id || user?.user_id || user?.Id || userSlots.user_id || userSlots.userId;
                        if (userId && String(userId) !== String(doctorId)) continue;
                        // Fail-closed (30/06 conv 76): bloco sem userId em resposta multi-usuario.
                        if (!userId && slotsByUser.length > 1) continue;
                        // Try multiple key names for slots array
                        const slots = (userSlots.slots || userSlots.Slots || userSlots.available_slots) as
                          | Array<Record<string, unknown>>
                          | undefined;
                        if (slots && Array.isArray(slots)) {
                          for (const slot of slots) {
                            const raw = String(
                              slot.start_time ||
                                slot.startTime ||
                                slot.start ||
                                slot.time ||
                                slot.hour ||
                                slot.hora ||
                                "",
                            );
                            const match = raw.match(/(\d{2}:\d{2})/);
                            if (match) times.push(match[1]);
                          }
                        }
                      }
                    } else {
                      // Fallback: try flat slots directly on dayObj
                      const directSlots = (dayObj.slots ||
                        dayObj.Slots ||
                        dayObj.available_slots ||
                        dayObj.availableSlots) as Array<Record<string, unknown>> | undefined;
                      if (directSlots && Array.isArray(directSlots)) {
                        for (const slot of directSlots) {
                          // Check if slot belongs to the right doctor
                          const slotUserId = slot.user_id || slot.userId || (slot.user as Record<string, unknown>)?.id;
                          if (slotUserId && String(slotUserId) !== String(doctorId)) continue;
                          const raw = String(
                            slot.start_time ||
                              slot.startTime ||
                              slot.start ||
                              slot.time ||
                              slot.hour ||
                              slot.hora ||
                              "",
                          );
                          const match = raw.match(/(\d{2}:\d{2})/);
                          if (match) times.push(match[1]);
                        }
                      } else if (
                        dayObj.available === true ||
                        dayObj.status === "available" ||
                        dayObj.status === "AVAILABLE"
                      ) {
                        // Ultra-fallback: single time on dayObj itself
                        const raw = String(
                          dayObj.start_time || dayObj.startTime || dayObj.time || dayObj.hour || dayObj.hora || "",
                        );
                        const match = raw.match(/(\d{2}:\d{2})/);
                        if (match) times.push(match[1]);
                      }
                    }

                    if (times.length > 0) {
                      slotsMap.set(dateKey, [...new Set(times)].sort());
                    }
                  }
                }
                console.log(
                  `[Webhook] slotsMap has ${slotsMap.size} dates with slots. Sample: ${JSON.stringify([...slotsMap.entries()].slice(0, 3)).substring(0, 500)}`,
                );
                // 4. Convert available dates to ISO and cross-reference with slotsMap
                const availableIso = (availDates as string[]).map((d: string) => toIsoDate(d));

                // 5. Apply weekday filter
                let filteredIso = availableIso;
                if (entities.preferred_weekday) {
                  const weekdayMap: Record<string, number> = {
                    domingo: 0,
                    segunda: 1,
                    terca: 2,
                    terça: 2,
                    quarta: 3,
                    quinta: 4,
                    sexta: 5,
                    sabado: 6,
                    sábado: 6,
                  };
                  const targetDay = weekdayMap[entities.preferred_weekday.toLowerCase()];
                  if (targetDay !== undefined) {
                    filteredIso = filteredIso.filter((d) => getWeekday(d) === targetDay);
                    console.log(`[Webhook] Filtered to ${filteredIso.length} dates on ${entities.preferred_weekday}`);
                  }
                }

                // 6. Build date+slots pairs from slotsMap, apply period filter
                const periodFilter = entities.preferred_period || undefined;
                const MAX_TOTAL_SLOTS = 10;
                let totalSlots = 0;
                const datesWithSlots: Array<{ date: string; label: string; slots: string[] }> = [];
                for (const d of filteredIso) {
                  if (!slotsMap.has(d)) continue;
                  if (isWeekendISO(d)) continue; // clínica fechada sáb/dom (caso Caio, 11/08)
                  if (totalSlots >= MAX_TOTAL_SLOTS) break;
                  let slots = slotsMap.get(d)!;
                  if (periodFilter === "manha") slots = slots.filter((t) => t < "12:00");
                  if (periodFilter === "tarde") slots = slots.filter((t) => t >= "12:00");
                  if (slots.length === 0) continue;
                  const remaining = MAX_TOTAL_SLOTS - totalSlots;
                  const taken = slots.slice(0, remaining);
                  totalSlots += taken.length;
                  datesWithSlots.push({ date: d, label: formatDateLabel(d), slots: taken });
                }

                if (datesWithSlots.length > 0) {
                  const periodLabel =
                    periodFilter === "manha" ? " (manhã)" : periodFilter === "tarde" ? " (tarde)" : "";
                  const header = `Horários disponíveis com ${doctorName || "o médico"}${periodLabel}:\n\n`;
                  const body = datesWithSlots.map((p) => `${p.label}: ${p.slots.join(", ")}`).join("\n");
                  const footer = "\n\nQual data e horário prefere?";
                  const fullMsg = header + body + footer;
                  console.log(`[Webhook] Returning ${datesWithSlots.length} dates with slots`);
                  // Lock presented slots (1 min TTL) to prevent them from being taken while patient decides
                  if (supabaseClient && clinicTokenId && doctorId) {
                    await lockPresentedSlots(
                      supabaseClient,
                      clinicTokenId,
                      doctorId,
                      datesWithSlots,
                      senderPhone || "",
                    );
                  }
                  return { status: "needs_info", response: fullMsg, error: fullMsg, verifiedSchedule: true } as any;
                } else {
                  // Dates exist but no slots found from bulk fetch — fetch individually per date
                  const top5 = filteredIso.filter((d: string) => !isWeekendISO(d)).slice(0, 5);
                  if (top5.length > 0) {
                    console.log(`[Webhook] slotsMap empty — fetching slots individually for ${top5.length} dates`);
                    const individualResults: Array<{ date: string; label: string; slots: string[] }> = [];
                    const periodFilter2 = entities.preferred_period || undefined;

                    await Promise.all(
                      top5.map(async (d: string) => {
                        try {
                          let slots = await fetchSlotsForDate(d, doctorId || undefined, undefined);
                          if (periodFilter2 === "manha") slots = slots.filter((t) => t < "12:00");
                          if (periodFilter2 === "tarde") slots = slots.filter((t) => t >= "12:00");
                          if (slots.length > 0) {
                            individualResults.push({ date: d, label: formatDateLabel(d), slots: slots.slice(0, 5) });
                          }
                        } catch (e) {
                          console.log(`[Webhook] Individual fetch failed for ${d}: ${e}`);
                        }
                      }),
                    );

                    // Sort by date
                    individualResults.sort((a, b) => a.date.localeCompare(b.date));

                    if (individualResults.length > 0) {
                      const periodLabel2 =
                        periodFilter2 === "manha" ? " (manhã)" : periodFilter2 === "tarde" ? " (tarde)" : "";
                      const header2 = `Horários disponíveis com ${doctorName || "o médico"}${periodLabel2}:\n\n`;
                      const body2 = individualResults.map((p) => `${p.label}: ${p.slots.join(", ")}`).join("\n");
                      const footer2 = "\n\nQual data e horário prefere?";
                      const fullMsg2 = header2 + body2 + footer2;
                      console.log(`[Webhook] Individual fetch returned ${individualResults.length} dates with slots`);
                      // Lock presented slots (1 min TTL)
                      if (supabaseClient && clinicTokenId && doctorId) {
                        await lockPresentedSlots(
                          supabaseClient,
                          clinicTokenId,
                          doctorId,
                          individualResults,
                          senderPhone || "",
                        );
                      }
                      return { status: "needs_info", response: fullMsg2, error: fullMsg2, verifiedSchedule: true } as any;
                    } else {
                      // Even individual fetches returned no slots — anti-hallucination guard
                      const nextDates = top5.map((d: string) => formatDateLabel(d)).join(", ");
                      console.log(`[Webhook] Anti-hallucination guard: no slots found even with individual fetch`);
                      return {
                        status: "needs_info",
                        response: "",
                        error: `Não foram encontrados horários específicos para ${doctorName || "o médico"} nas datas ${nextDates}.`,
                        internal_instruction: `As datas ${nextDates} aparecem na agenda mas não retornaram horários específicos. Informe ao paciente que essas datas precisam ser confirmadas diretamente com a recepção, ou sugira que tente outra data/médico. PROIBIDO inventar ou sugerir qualquer horário que não esteja explicitamente nos dados.`,
                      };
                    }
                  }
                }
              } else {
                console.log(
                  `[Webhook] No available dates found for doctor ${doctorId} (${doctorName}). Attempting multi-doctor fallback...`,
                );
                // OVERRIDE 2 compliance: if patient requested a specific doctor by name, do NOT suggest others
                if (entities.doctor_name) {
                  console.log(
                    `[Webhook] Patient requested specific doctor "${entities.doctor_name}" — skipping multi-doctor fallback (OVERRIDE 2)`,
                  );
                  return {
                    status: "needs_info",
                    response: "",
                    error: `Verifiquei aqui e o(a) Dr(a). ${doctorName || entities.doctor_name} não tem horários disponíveis no momento.`,
                    internal_instruction: "Pergunte se o paciente gostaria de tentar em outro dia com o mesmo médico. NÃO sugira outro profissional, pois o paciente pediu este médico especificamente.",
                  };
                }
                // FALLBACK: Search other schedulable doctors for availability (only when no specific doctor was requested)
                if (schedulableDoctors.length > 1) {
                  const otherDocs = schedulableDoctors.filter(
                    (d) => String(d.id) !== String(doctorId) && !semEncaixeGeralAg.has(String(d.id)),
                  );
                  const fallbackSchedules: Array<{
                    id: any;
                    name: string;
                    sub: string;
                    slots: Array<{ label: string; date: string; times: string[] }>;
                  }> = [];
                  const fallbackPromises = otherDocs.slice(0, 5).map(async (doc) => {
                    try {
                      const fbAvail = await tryFetch(
                        `doctors/${doc.id}/available-dates?event_id=${eventId}&place_id=${placeId}&company_id=${companyId}`,
                        amigoToken,
                      );
                      const fbDates = normalizeApiResponse(fbAvail);
                      if (!Array.isArray(fbDates) || fbDates.length === 0) return null;
                      const fbCal = await tryFetch(
                        `calendar?place_id=${placeId}&event_id=${eventId}&user_id=${doc.id}&company_id=${companyId}`,
                        amigoToken,
                      );
                      const fbCalData = normalizeApiResponse(fbCal) as Array<Record<string, unknown>>;
                      const fbSlotsMap = new Map<string, string[]>();
                      if (Array.isArray(fbCalData)) {
                        for (const dayObj of fbCalData) {
                          const dateKey = String(dayObj.date || dayObj.day || dayObj.data || "");
                          if (!dateKey) continue;
                          if (_listGateMin && dateKey.slice(0, 10) < _listGateMin) continue; // piso do retorno (convênio)
                          const times: string[] = [];
                          const slotsByUser = (dayObj.slotsByUser || dayObj.slots_by_user || dayObj.slotsbyuser) as
                            | Array<Record<string, unknown>>
                            | undefined;
                          if (slotsByUser && Array.isArray(slotsByUser)) {
                            for (const userSlots of slotsByUser) {
                              const user = (userSlots.user || userSlots.User) as Record<string, unknown> | undefined;
                              const userId = user?.id || userSlots.user_id || userSlots.userId;
                              if (userId && String(userId) !== String(doc.id)) continue;
                              const slots = (userSlots.slots || userSlots.Slots || userSlots.available_slots) as
                                | Array<Record<string, unknown>>
                                | undefined;
                              if (slots && Array.isArray(slots)) {
                                for (const slot of slots) {
                                  const raw = String(
                                    slot.start_time ||
                                      slot.startTime ||
                                      slot.start ||
                                      slot.time ||
                                      slot.hour ||
                                      slot.hora ||
                                      "",
                                  );
                                  const match = raw.match(/(\d{2}:\d{2})/);
                                  if (match) times.push(match[1]);
                                }
                              }
                            }
                          } else {
                            const directSlots = (dayObj.slots || dayObj.Slots || dayObj.available_slots) as
                              | Array<Record<string, unknown>>
                              | undefined;
                            if (directSlots && Array.isArray(directSlots)) {
                              for (const slot of directSlots) {
                                const raw = String(
                                  slot.start_time ||
                                    slot.startTime ||
                                    slot.start ||
                                    slot.time ||
                                    slot.hour ||
                                    slot.hora ||
                                    "",
                                );
                                const match = raw.match(/(\d{2}:\d{2})/);
                                if (match) times.push(match[1]);
                              }
                            }
                          }
                          if (times.length > 0) fbSlotsMap.set(dateKey, [...new Set(times)].sort());
                        }
                      }
                      const weekDaysFb = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
                      const docSlots: Array<{ label: string; date: string; times: string[] }> = [];
                      let total = 0;
                      for (const dateStr of fbDates as string[]) {
                        if (total >= 5) break;
                        let isoD = dateStr;
                        if (dateStr.includes("/")) {
                          const [dd, mm, yy] = dateStr.split("/");
                          isoD = `${yy}-${mm}-${dd}`;
                        }
                        const ss = fbSlotsMap.get(isoD);
                        if (!ss || ss.length === 0) continue;
                        const taken = ss.slice(0, 5 - total);
                        total += taken.length;
                        const pts = isoD.split("-").map(Number);
                        const dt = new Date(pts[0], pts[1] - 1, pts[2]);
                        docSlots.push({
                          label: `${String(pts[2]).padStart(2, "0")}/${String(pts[1]).padStart(2, "0")} (${weekDaysFb[dt.getDay()]})`,
                          date: isoD,
                          times: taken,
                        });
                      }
                      if (docSlots.length > 0) {
                        const sub = subspecialtyMap.get(String(doc.id)) || "";
                        return { id: doc.id, name: (doc.name as string) || "Médico", sub, slots: docSlots };
                      }
                    } catch (e) {
                      console.log(`[Webhook] Fallback doctor ${doc.id} error: ${e.message}`);
                    }
                    return null;
                  });
                  const fbResults = await Promise.all(fallbackPromises);
                  for (const r of fbResults) {
                    if (r) fallbackSchedules.push(r);
                  }
                  if (fallbackSchedules.length > 0) {
                    const lines: string[] = [];
                    for (const sched of fallbackSchedules) {
                      lines.push(`*${sched.name}*${sched.sub ? ` (${sched.sub})` : ""}:`);
                      for (const s of sched.slots) {
                        lines.push(`  ${s.label}: ${s.times.join(", ")}`);
                      }
                      lines.push("");
                    }
                    const fallbackMsg = `${doctorName || "O médico solicitado"} não possui horários disponíveis no momento. Porém, encontrei disponibilidade com outros especialistas:\n\n${lines.join("\n")}Qual médico e horário prefere?`;
                    console.log(`[Webhook] Fallback found ${fallbackSchedules.length} other doctors with availability`);
                    // Lock presented slots PER DOCTOR so the patient's later choice (date+time,
                    // possibly without naming the doctor) can be resolved back to the right doctor.
                    if (supabaseClient && clinicTokenId) {
                      for (const sched of fallbackSchedules) {
                        if (!sched.id) continue;
                        const datesWithSlots = sched.slots.map((s) => ({ date: s.date, slots: s.times }));
                        await lockPresentedSlots(
                          supabaseClient,
                          clinicTokenId,
                          String(sched.id),
                          datesWithSlots,
                          senderPhone || "",
                        );
                      }
                    }
                    return { status: "needs_info", response: fallbackMsg, error: fallbackMsg, verifiedSchedule: true } as any;
                  }
                }
                return {
                  status: "needs_info",
                  response: "",
                  error: `Sem horários disponíveis com ${doctorName || "o médico solicitado"} no momento, e também não há disponibilidade com outros especialistas.`,
                  internal_instruction: "Sugira que o paciente entre em contato com a recepção ou tente novamente mais tarde. NÃO invente horários.",
                };
              }
            } catch (e) {
              console.log("[Webhook] Could not fetch available dates:", e.message);
            }
          }
          return {
            status: "needs_info",
            response: "",
            error: "Para qual data gostaria de agendar sua consulta? Por favor, informe a data desejada.",
          };
        }

        // Step 6: If no time, fetch and show formatted slots for the chosen date
        if (!entities.time) {
          const dateLabel = formatDateLabel(entities.date);
          if (doctorId) {
            const slots = await fetchSlotsForDate(entities.date, doctorId, entities.preferred_period || undefined);
            if (slots.length > 0) {
              const msg = `Horários disponíveis em ${dateLabel}: ${slots.join(", ")}\n\nQual horário prefere?`;
              // Lock presented slots (1 min TTL)
              if (supabaseClient && clinicTokenId && doctorId) {
                await lockPresentedSlots(
                  supabaseClient,
                  clinicTokenId,
                  doctorId,
                  [{ date: entities.date, slots }],
                  senderPhone || "",
                );
              }
              return { status: "needs_info", response: msg, error: msg, verifiedSchedule: true } as any;
            }
            // Doctor selected but no slots available — try fallback to other doctors on same date
            // OVERRIDE 2: if patient requested specific doctor, do NOT suggest others
            if (entities.doctor_name) {
              console.log(
                `[Webhook] Patient requested specific doctor "${entities.doctor_name}" on ${entities.date} — no fallback (OVERRIDE 2)`,
              );
              return {
                status: "needs_info",
                response: "",
                error: `Sem horários com ${doctorName || entities.doctor_name} em ${dateLabel}.`,
                internal_instruction: "Pergunte se deseja tentar outra data com o mesmo médico. NÃO sugira outro profissional, pois o paciente pediu este médico especificamente.",
              };
            }
            console.log(`[Webhook] No slots for ${doctorName} on ${entities.date}. Trying other doctors...`);
            const fbOtherDocs = schedulableDoctors.filter(
              (d) => String(d.id) !== String(doctorId) && !semEncaixeGeralAg.has(String(d.id)),
            );
            const fbDateSlots: string[] = [];
            for (const doc of fbOtherDocs) {
              try {
                const docSlots = await fetchSlotsForDate(
                  entities.date,
                  String(doc.id),
                  entities.preferred_period || undefined,
                );
                if (docSlots.length > 0) {
                  fbDateSlots.push(`${(doc.name as string) || "Médico"}: ${docSlots.join(", ")}`);
                }
              } catch (e) {
                console.log(`[Webhook] Fallback date slots error for ${doc.id}: ${e.message}`);
              }
            }
            if (fbDateSlots.length > 0) {
              const fbMsg = `Infelizmente ${doctorName || "o médico"} não possui horários em ${dateLabel}. Porém, encontrei disponibilidade com outros especialistas:\n\n${fbDateSlots.join("\n")}\n\nQual médico e horário prefere? Ou deseja tentar outra data?`;
              return { status: "needs_info", response: fbMsg, error: fbMsg, verifiedSchedule: true } as any;
            }
            return {
              status: "needs_info",
              response: "",
              error: `Sem horários para ${doctorName || "o médico"} em ${dateLabel}, e nenhum outro médico tem disponibilidade nesta data.`,
              internal_instruction: "Pergunte se o paciente deseja tentar outra data. NÃO invente horários ou datas.",
            };
          }

          // No doctorId — search slots for all schedulable doctors on this date
          console.log(
            `[Webhook] No doctorId set, searching slots for all ${schedulableDoctors.length} schedulable doctors on ${entities.date}`,
          );
          const allDoctorSlots: string[] = [];
          for (const doc of schedulableDoctors) {
            try {
              const docSlots = await fetchSlotsForDate(
                entities.date,
                String(doc.id),
                entities.preferred_period || undefined,
              );
              if (docSlots.length > 0) {
                const docName = (doc.name as string) || "Médico";
                allDoctorSlots.push(`${docName}: ${docSlots.join(", ")}`);
              }
            } catch (e) {
              console.log(`[Webhook] Error fetching slots for doctor ${doc.id}: ${e.message}`);
            }
          }

          if (allDoctorSlots.length > 0) {
            const msg = `Horários disponíveis em ${dateLabel}:\n${allDoctorSlots.join("\n")}\n\nQual médico e horário prefere?`;
            return { status: "needs_info", response: msg, error: msg, verifiedSchedule: true } as any;
          }

          // No slots found for any doctor
          return {
            status: "needs_info",
            response: "",
            error: `Sem horários disponíveis em ${dateLabel} para nenhum dos nossos médicos.`,
            internal_instruction: "Informe ao paciente que não há disponibilidade nesta data e pergunte se deseja tentar outra data. NÃO invente horários.",
          };
        }

        // Step 6.5: VALIDATE that the requested time actually exists in calendar
        if (entities.time && doctorId) {
          const realSlots = await fetchSlotsForDate(entities.date, doctorId);
          const dateLabel = formatDateLabel(entities.date);
          if (realSlots.length > 0 && !realSlots.includes(entities.time)) {
            // Requested time doesn't exist — show real slots
            const msg = `O horário ${entities.time} não está disponível com ${doctorName} em ${dateLabel}. Os horários disponíveis são: ${realSlots.join(", ")}.\n\nQual horário prefere?`;
            console.log(
              `[Webhook] Step 6.5: Time ${entities.time} NOT in real slots [${realSlots.join(",")}] for ${doctorName} on ${entities.date}`,
            );
            return { status: "needs_info", response: msg, error: msg, verifiedSchedule: true } as any;
          } else if (realSlots.length === 0) {
            // No slots at all for this date — try next 7 days for the SAME doctor before giving up
            console.log(
              `[Webhook] Step 6.5: No slots at all for ${doctorName} on ${entities.date} — searching next 7 days`,
            );
            const nextDays: { date: string; label: string; slots: string[] }[] = [];
            const baseParts = entities.date.split("-").map(Number);
            const baseDate = new Date(baseParts[0], baseParts[1] - 1, baseParts[2]);
            for (let i = 1; i <= 7 && nextDays.length < 3; i++) {
              const nd = new Date(baseDate);
              nd.setDate(nd.getDate() + i);
              const ndIso = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-${String(nd.getDate()).padStart(2, "0")}`;
              // Fim de semana nunca vira oferta (caso Caio, 11/08): a clínica não
              // abre sáb/dom e a marcação seria recusada no final do fluxo.
              if (isWeekendISO(ndIso)) continue;
              try {
                const ndSlots = await fetchSlotsForDate(ndIso, doctorId);
                if (ndSlots.length > 0) {
                  nextDays.push({
                    date: ndIso,
                    label: formatDateLabel(ndIso),
                    slots: ndSlots.slice(0, 4),
                  });
                }
              } catch (_) {
                /* non-blocking */
              }
            }

            if (nextDays.length > 0) {
              const lines = nextDays.map((d) => `${d.label}: ${d.slots.join(", ")}`).join("\n");
              // TOM (reclamação do dono, 11/08: "você está respondendo de forma
              // agressiva"). Esta mensagem passa por bypassAiRewrite, ou seja, sai
              // literal — e no caso ela NEGOU um dia que a própria Julia
              // tinha acabado de oferecer ("22/08, que é um sábado, às 08:30, 09:10
              // e 10:20" → "Cristian Vilela dos Santos não tem horários em 22/08"),
              // sem pedir desculpa e sem chamar o paciente pelo nome. Ler isso
              // depois de escolher um horário soa como se a culpa fosse dele.
              // O texto assume o erro; a lista real de horários continua idêntica.
              const altMsg =
                `Me desculpe — me confundi aqui: ${doctorName} não tem horários em ${dateLabel}. 🙏\n\n` +
                `Estas são as datas que ele realmente tem:\n${lines}\n\nAlguma delas te atende?`;
              return { status: "needs_info", response: altMsg, error: altMsg, verifiedSchedule: true } as any;
            }

            return {
              status: "needs_info",
              response: "",
              error: `Sem horários com ${doctorName} em ${dateLabel} nem nos próximos 7 dias.`,
              internal_instruction:
                "Informe que não há disponibilidade nem na data pedida nem nos próximos 7 dias com este médico, e pergunte se deseja tentar outro profissional. NÃO invente horários.",
            };
          }
          console.log(`[Webhook] Step 6.5: Time ${entities.time} validated OK in slots [${realSlots.join(",")}]`);
        }

        // Step 7: If no doctor selected, use complaint-based triage or ask
        if (!doctorId) {
          if (schedulableDoctors.length === 1) {
            doctorId = String(schedulableDoctors[0].id);
            doctorName = (schedulableDoctors[0].name as string) || "Médico";
          } else if (schedulableDoctors.length > 1) {
            // Try complaint-based triage if complaint is available
            if (entities.complaint && subspecialtyMap.size > 0) {
              console.log(`[Webhook] Attempting complaint-based triage: "${entities.complaint}"`);
              try {
                // Use AI to map complaint to subspecialty
                const subspecialtiesList = Array.from(subspecialtyMap.entries())
                  .map(([docId, sub]) => {
                    const doc = schedulableDoctors.find((d) => String(d.id) === docId);
                    return doc ? `${doc.name}: ${sub}` : null;
                  })
                  .filter(Boolean)
                  .join("\n");

                if (llmApiKey()) {
                  const mapResponse = await postLLM({
                    method: "POST",
                    headers: llmHeaders(),
                    body: JSON.stringify({
                      model: LLM_MODEL,
                      usage: LLM_USAGE_INCLUDE,
                      messages: [
                        {
                          role: "system",
                          content: `Você é um classificador médico. Dado a queixa do paciente e a lista de médicos com suas subespecialidades, retorne APENAS o nome exato da subespecialidade que melhor se encaixa. Se nenhuma se encaixar, retorne "NENHUMA".

Médicos e subespecialidades disponíveis:
${subspecialtiesList}

Responda APENAS com o nome da subespecialidade, sem explicações.`,
                        },
                        { role: "user", content: `Queixa do paciente: ${entities.complaint}` },
                      ],
                    }),
                  }, 15000);

                  if (mapResponse.ok) {
                    const mapResult = await mapResponse.json();
                    logAiUsage(
                      clinicTokenId,
                      "whatsapp-webhook/triage",
                      LLM_MODEL,
                      mapResult.usage,
                    );
                    const mappedSub = (mapResult.choices?.[0]?.message?.content || "").trim();
                    console.log(`[Webhook] AI mapped complaint "${entities.complaint}" -> subspecialty "${mappedSub}"`);

                    if (mappedSub && mappedSub !== "NENHUMA") {
                      const normalizedMapped = mappedSub
                        .toLowerCase()
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, "");
                      const matchingDocs = schedulableDoctors.filter((d) => {
                        const sub = subspecialtyMap.get(String(d.id));
                        if (!sub) return false;
                        const normalizedSub = sub
                          .toLowerCase()
                          .normalize("NFD")
                          .replace(/[\u0300-\u036f]/g, "");
                        return normalizedSub.includes(normalizedMapped) || normalizedMapped.includes(normalizedSub);
                      });

                      if (matchingDocs.length === 1) {
                        doctorId = String(matchingDocs[0].id);
                        doctorName = (matchingDocs[0].name as string) || "Médico";
                        const sub = subspecialtyMap.get(doctorId);
                        console.log(`[Webhook] Complaint triage: selected ${doctorName} (${sub})`);
                      } else if (matchingDocs.length > 1) {
                        const docList = matchingDocs
                          .map((d) => {
                            const sub = subspecialtyMap.get(String(d.id));
                            return `${d.name}${sub ? ` (${sub})` : ""}`;
                          })
                          .join(", ");
                        return {
                          status: "needs_info",
                          response: "",
                          error: `Para sua queixa encontrei ${matchingDocs.length} especialistas: ${docList}. Com qual gostaria de agendar?`,
                        };
                      }
                    }
                  }
                }
              } catch (triageErr) {
                console.log(`[Webhook] Complaint triage error: ${triageErr.message}`);
              }
            }

            // If still no doctor and no complaint was provided, ask for complaint
            if (!doctorId && !entities.complaint) {
              return {
                status: "needs_info",
                response: "",
                error: "Qual a sua queixa ou motivo da consulta? Isso me ajuda a direcionar para o especialista certo.",
              };
            }

            // Fallback: if complaint didn't resolve, try to find one available for the date/time
            if (!doctorId) {
              for (const doc of schedulableDoctors) {
                try {
                  const availResult = await tryFetch(
                    `doctors/${doc.id}/available-dates?event_id=${eventId}&place_id=${placeId}&company_id=${companyId}`,
                    amigoToken,
                  );
                  const availDates = normalizeApiResponse(availResult);
                  if (Array.isArray(availDates) && availDates.includes(entities.date)) {
                    doctorId = String(doc.id);
                    doctorName = (doc.name as string) || "Médico";
                    break;
                  }
                } catch (_) {
                  /* continue */
                }
              }
              if (!doctorId) {
                const docList = schedulableDoctors
                  .map((d) => {
                    const sub = subspecialtyMap.get(String(d.id));
                    return `${d.name}${sub ? ` (${sub})` : ""}`;
                  })
                  .join(", ");
                return {
                  status: "needs_info",
                  response: "",
                  error: `Com qual médico gostaria de agendar? Opções: ${docList}`,
                };
              }
            }
          }
        }

        // Step 7.5: NOW ask for CPF (after doctor+date+time are selected)
        // Create a slot lock to reserve this time while waiting for CPF
        if (supabaseClient && clinicTokenId && doctorId && entities.date && entities.time) {
          try {
            // Clean expired locks
            await supabaseClient.from("slot_locks").delete().lt("expires_at", new Date().toISOString());
            // Insert lock with 3-minute TTL
            const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
            const currentPhone = senderPhone?.replace(/\D/g, "") || "";
            await supabaseClient
              .from("slot_locks")
              .upsert(
                {
                  clinic_token_id: clinicTokenId,
                  doctor_id: doctorId,
                  slot_date: entities.date,
                  slot_time: entities.time + ":00",
                  phone: currentPhone,
                  expires_at: expiresAt,
                  // ESCOLHA REAL do paciente — esta sim bloqueia outros por 3 min
                  // (a apresentação da lista grava 'presented' e não bloqueia ninguém).
                  kind: "selected",
                },
                { onConflict: "clinic_token_id,doctor_id,slot_date,slot_time" },
              )
              .throwOnError();
            console.log(
              `[Webhook] Slot locked: ${doctorId} ${entities.date} ${entities.time} for ${currentPhone} (expires ${expiresAt})`,
            );
          } catch (lockErr) {
            console.log("[Webhook] Slot lock creation error (non-blocking): " + (lockErr as Error).message);
          }
        }

        // If CPF is already known (from phone lookup or conversation memory), skip asking
        if (!entities.cpf) {
          const patientRef = entities.patient_full_name ? `de ${entities.patient_full_name}` : "seu";
          const cpfRef = entities.patient_full_name ? `do(a) ${entities.patient_full_name}` : "seu";
          // FIX (<paciente> <telefone-removido>): NÃO afirmar "agendado/confirmado" antes do POST real
          // no Amigo. Apenas reservar o horário (slot_lock já criado acima por 3 min) e
          // pedir o CPF. A confirmação real só acontece depois do POST com sucesso.
          if (supabaseClient && clinicTokenId && senderPhone) {
            await transitionConversationState(supabaseClient, {
              clinicTokenId,
              conversationId: conversationIdParam || null,
              phone: senderPhone,
              toState: "awaiting_cpf",
              trigger: "agendar:slot_locked_no_cpf",
              contextPatch: {
                doctor_id: doctorId,
                doctor_name: doctorName,
                date: entities.date,
                time: entities.time,
                insurance_choice: entities.insurance_choice || null,
                slot_lock_expires_at: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
              },
              expectedInputs: ["cpf"],
              messageId: null,
            });
          }
          return {
            status: "needs_info",
            response: "",
            error: `Estou reservando o horário das ${entities.time} no dia ${entities.date} com ${doctorName || "o médico"} ${patientRef} (reserva válida por 3 minutos). Para concluir e confirmar oficialmente, me passe o CPF ${cpfRef}, por favor.`,
            verifiedSchedule: true,
          } as any;
        }
        console.log(`[Webhook] CPF already available (${entities.cpf}) — skipping CPF question, proceeding to confirm`);

        // Step 7.6: Search patient by CPF
        const cleanCpf = entities.cpf.replace(/\D/g, "");
        const patResult = await tryFetch(
          `patients/exists?cpf=${cleanCpf}&company_id=${companyId}`,
          amigoToken,
          "GET",
          undefined,
          true,
        );
        const patData = normalizeApiResponse(patResult) as Record<string, unknown>;
        // Tema 3: queda do Amigo (502/5xx) != "paciente nao cadastrado". Nao empurra
        // um paciente JA existente pro fluxo de cadastro (risco de duplicata).
        if (isAuthApiFailure(patResult.status)) {
          return { status: "transient_error", response: AMIGO_AUTH_MESSAGE, bypassAiRewrite: true, error: amigoAuthAlert(patResult.status, "agendar lookup") };
        }
        if (isTransientApiFailure(patResult.status)) {
          return { status: "transient_error", response: TRANSIENT_API_MESSAGE, bypassAiRewrite: true, error: `Amigo transient ${patResult.status} (agendar lookup) [${amigoFailReason(patResult.data)}]` };
        }
        if (!patData || patResult.status >= 400) {
          // Patient not found - initiate registration flow
          console.log("[Webhook] Patient not found by CPF, initiating registration flow");
          let insList = "";
          try {
            const insResult = await tryFetch(`insurances?company_id=${companyId}`, amigoToken);
            const insurances = normalizeApiResponse(insResult) as Array<Record<string, unknown>>;
            if (Array.isArray(insurances) && insurances.length > 0) {
              insList = insurances.map((ins, i) => `${i + 1}. ${ins.name}`).join("\n");
            }
          } catch (e) {
            console.log("[Webhook] Could not fetch insurances for registration: " + e.message);
          }
          return {
            status: "needs_registration",
            response: "",
            error: `Não encontrei seu cadastro na clínica. Para cadastrá-lo, preciso de algumas informações:\n\n1. Qual o seu *nome completo*?\n2. Qual a sua *data de nascimento*?\n3. Qual o seu *convênio* e *plano*?\n4. Qual o seu *endereço completo* (ou CEP)?\n\n${insList ? "Convênios disponíveis:\n" + insList : ""}\n\nSe não tiver convênio, responda "particular".`,
            // Preserve scheduling entities so they can be recovered after registration
            schedulingContext: {
              doctor_name: doctorName || entities.doctor_name || "",
              date: entities.date || "",
              time: entities.time || "",
              cpf: cleanCpf || "",
              subspecialty: entities.subspecialty || "",
            },
          };
        }
        const patId = patData.id || patData.patient_id;
        const patientName = String(patData.name || patData.full_name || (entities as any)._patientName || "");
        console.log(`[Webhook] Patient identified: ${patientName} (id: ${patId})`);
        // Save/update patient cache in local_patients
        if (supabaseClient && clinicTokenId && senderPhone) {
          try {
            const { data: whForCache } = await supabaseClient
              .from("user_webhooks")
              .select("user_id")
              .eq("clinic_token_id", clinicTokenId)
              .limit(1)
              .maybeSingle();
            if (whForCache?.user_id) {
              // AGENDAR PARA UM PARENTE NÃO PODE ROUBAR O TELEFONE DELE (11/08).
              // O upsert casa por (user_id, cpf) e sobrescrevia a coluna `phone`:
              // quando a mãe agenda para o filho, a linha do FILHO passava a ter o
              // telefone da MÃE. Dali em diante, qualquer busca por telefone naquele
              // número devolvia o nome do filho — e era assim que a pessoa era
              // chamada pelo nome de outra. O envenenamento é permanente: o cache
              // nunca se corrige sozinho.
              const _telAtual = senderPhone.replace(/\D/g, "");
              const { data: _jaExiste } = await supabaseClient
                .from("local_patients")
                .select("id, phone")
                .eq("user_id", whForCache.user_id)
                .eq("cpf", cleanCpf)
                .limit(1)
                .maybeSingle();
              const _telDeOutro =
                _jaExiste?.phone &&
                String(_jaExiste.phone).replace(/\D/g, "") !== _telAtual;
              if (_telDeOutro) {
                // Já conhecíamos este paciente com OUTRO telefone: atualiza o resto,
                // preserva o telefone dele.
                await supabaseClient
                  .from("local_patients")
                  .update({ name: patientName || "Paciente", amigo_patient_id: String(patId || "") })
                  .eq("id", _jaExiste.id);
                console.log(
                  `[Webhook] Cache: paciente ${cleanCpf.slice(0, 3)}*** já tem telefone próprio — não sobrescrevi com o de quem está agendando`,
                );
              } else {
                await supabaseClient.from("local_patients").upsert(
                  {
                    user_id: whForCache.user_id,
                    phone: _telAtual,
                    cpf: cleanCpf,
                    name: patientName || "Paciente",
                    amigo_patient_id: String(patId || ""),
                  },
                  { onConflict: "user_id,cpf" },
                );
                console.log("[Webhook] Patient cache saved/updated in local_patients");
              }
            }
          } catch (cacheErr) {
            console.log("[Webhook] Cache save error: " + cacheErr.message);
          }
        }
        if (!patId) {
          return { status: "failed", response: "", error: "Paciente não encontrado" };
        }

        // Step 8: Check for conflicting appointments on the same day/time
        // BUG-1 FIX: build start_date from already-normalized values, with explicit seconds to
        // satisfy strict parsers on the Amigo side. extractDateAndTime in verify-booking accepts
        // both "YYYY-MM-DD HH:mm" and "YYYY-MM-DD HH:mm:ss".
        const isoDate = normalizeDateToISO(entities.date);
        const isoTime = normalizeTimeToHHMM(entities.time);
        if (!isoDate || !isoTime) {
          return {
            status: "failed",
            response: "",
            error: "Data ou horário inválidos. Por favor, informe novamente a data (DD/MM/AAAA) e horário (HH:mm).",
          };
        }
        const startDate = `${isoDate} ${isoTime}`; // canonical "YYYY-MM-DD HH:mm"

        if (patId) {
          try {
            console.log("[Webhook] agendar - Checking for conflicting appointments for patient " + patId);
            const existingAtts = await tryFetch(`attendances/${patId}?company_id=${companyId}`, amigoToken);
            const existingList = normalizeApiResponse(existingAtts) as Array<Record<string, unknown>>;
            if (Array.isArray(existingList) && existingList.length > 0) {
              const conflicting = existingList.filter((a) => {
                const status = String(a.status || "").toLowerCase();
                const canceled = a.canceled;
                if (status === "cancelled" || status === "cancelado" || canceled === true || canceled === "true")
                  return false;
                const aDate = String(a.start_date || a.date || "");
                const aDateOnly = aDate.split(" ")[0].split("T")[0];
                const aTime = aDate.includes(" ")
                  ? aDate.split(" ")[1]?.substring(0, 5)
                  : aDate.includes("T")
                    ? aDate.split("T")[1]?.substring(0, 5)
                    : "";
                // Check same day AND same time
                if (aDateOnly === entities.date && aTime === entities.time) return true;
                return false;
              });
              if (conflicting.length > 0) {
                const c = conflicting[0];
                const confDoctorId = String(c.user_id || (c.user as Record<string, unknown>)?.id || "");
                const confDoc = (() => {
                  const u = c.user as Record<string, unknown> | undefined;
                  return u?.name || c.doctor_name || c.user_name || "médico";
                })();

                // If the conflicting appointment is with the SAME doctor the patient is trying to book,
                // this IS the patient's own booking (re-triggered flow). Confirm instead of blocking.
                if (confDoctorId === String(doctorId)) {
                  console.log(
                    `[Webhook] agendar - Conflict is patient's OWN booking with same doctor (${confDoctorId}). Confirming.`,
                  );
                  return {
                    status: "success",
                    response: `Sua consulta já está agendada com ${confDoc} no dia ${entities.date} às ${entities.time}. Posso ajudar em mais alguma coisa?`,
                    error: "",
                    patientAlreadyBookedThisSlot: true,
                  };
                }

                // Different doctor = real conflict
                console.log(
                  "[Webhook] agendar - CONFLICT found: patient already has appointment at " +
                    startDate +
                    " with different doctor " +
                    confDoctorId,
                );
                return {
                  status: "failed",
                  response: "",
                  error: `Você já possui um agendamento neste mesmo dia e horário (${entities.date} às ${entities.time}) com ${confDoc}. Deseja escolher outro horário?`,
                };
              }
              // Check same day, different time — warn but allow
              const sameDayDiffTime = existingList.filter((a) => {
                const status = String(a.status || "").toLowerCase();
                const canceled = a.canceled;
                if (status === "cancelled" || status === "cancelado" || canceled === true || canceled === "true")
                  return false;
                const aDate = String(a.start_date || a.date || "");
                const aDateOnly = aDate.split(" ")[0].split("T")[0];
                return aDateOnly === entities.date;
              });
              if (sameDayDiffTime.length > 0) {
                console.log("[Webhook] agendar - Same day appointment exists but different time, proceeding");
              }
            }
          } catch (conflictErr) {
            console.log("[Webhook] agendar - Conflict check error (non-blocking): " + conflictErr.message);
          }
        }

        // Step 8b: Check slot lock — ensure no one else locked this slot
        if (supabaseClient && clinicTokenId) {
          try {
            // Clean expired locks first
            await supabaseClient.from("slot_locks").delete().lt("expires_at", new Date().toISOString());

            // Check if slot is locked by someone else.
            // SÓ escolha real bloqueia (kind='selected'). Quem apenas VIU a agenda
            // ('presented') não pode tirar a vaga de ninguém — era exatamente isso que
            // fazia a Julia dizer "reservado por outro paciente" sobre a vaga que ela
            // mesma tinha separado para este paciente (relato das atendentes 02/08).
            const { data: existingLock } = await supabaseClient
              .from("slot_locks")
              .select("phone")
              .eq("clinic_token_id", clinicTokenId)
              .eq("doctor_id", doctorId)
              .eq("slot_date", entities.date)
              .eq("slot_time", entities.time + ":00")
              .eq("kind", "selected")
              .gt("expires_at", new Date().toISOString())
              .maybeSingle();

            const currentPhone = senderPhone?.replace(/\D/g, "") || "";
            // Comparação por VARIANTES (11/13 dígitos, com e sem o 9): igualdade de
            // string crua trataria o MESMO paciente como "outro" se a trava tivesse
            // sido gravada com outra normalização — e ele levaria "reservado por outro
            // paciente" na própria vaga. Regra do CLAUDE.md para telefone brasileiro.
            const _minhasVariantes = new Set(getPhoneVariants(currentPhone).map((p) => p.replace(/\D/g, "")));
            const _donoDaTrava = String(existingLock?.phone || "").replace(/\D/g, "");
            if (existingLock && !_minhasVariantes.has(_donoDaTrava)) {
              console.log("[Webhook] agendar - Slot locked by another user");
              return {
                status: "failed",
                response: "",
                error: "Este horário acabou de ser reservado por outro paciente. Por favor, escolha outro horário.",
              };
            }
          } catch (lockErr) {
            console.log("[Webhook] agendar - Lock check error (non-blocking): " + lockErr.message);
          }
        }

        // Step 8c: DOUBLE VALIDATION — re-check slot availability right before booking
        // Skip if patient already owns this exact slot (detected in Step 8)
        if (doctorId && entities.date && entities.time) {
          try {
            // Re-check if patient already has this exact booking (from Step 8 result cached earlier)
            // If the conflict check found patient's own booking with same doctor, skip double validation
            let patientOwnsSlot = false;
            if (patId) {
              try {
                const recheckAtts = await tryFetch(`attendances/${patId}?company_id=${companyId}`, amigoToken);
                const recheckList = normalizeApiResponse(recheckAtts) as Array<Record<string, unknown>>;
                if (Array.isArray(recheckList)) {
                  patientOwnsSlot = recheckList.some((a) => {
                    const status = String(a.status || "").toLowerCase();
                    const canceled = a.canceled;
                    if (status === "cancelled" || status === "cancelado" || canceled === true || canceled === "true")
                      return false;
                    const aDate = String(a.start_date || a.date || "");
                    const aDateOnly = aDate.split(" ")[0].split("T")[0];
                    const aTime = aDate.includes(" ")
                      ? aDate.split(" ")[1]?.substring(0, 5)
                      : aDate.includes("T")
                        ? aDate.split("T")[1]?.substring(0, 5)
                        : "";
                    const aDoctorId = String(a.user_id || (a.user as Record<string, unknown>)?.id || "");
                    return aDateOnly === entities.date && aTime === entities.time && aDoctorId === String(doctorId);
                  });
                }
              } catch (_) {
                /* non-blocking */
              }
            }

            if (patientOwnsSlot) {
              console.log(
                `[Webhook] agendar - Skipping double validation — patient already owns this slot with doctor ${doctorId}`,
              );
            } else {
              const freshSlots = await fetchSlotsForDate(entities.date, doctorId);
              if (freshSlots.length > 0 && !freshSlots.includes(entities.time)) {
                console.log(
                  `[Webhook] agendar - DOUBLE VALIDATION FAILED: ${entities.time} no longer available. Fresh slots: [${freshSlots.join(",")}]`,
                );
                return {
                  status: "failed",
                  response: "",
                  error: `O horário ${entities.time} não está mais disponível com ${doctorName} em ${entities.date}. Horários disponíveis AGORA: ${freshSlots.join(", ")}. Ofereça esses horários ao paciente.`,
                };
              }
              console.log(`[Webhook] agendar - Double validation OK: ${entities.time} still available`);
            }
          } catch (dvErr) {
            console.log("[Webhook] agendar - Double validation error (non-blocking): " + (dvErr as Error).message);
          }
        }

        // Step 9: Create appointment — resolve insurance from patient data
        //
        // CONVÊNIO VIRANDO PARTICULAR (relato do dono, 04/08). Medido no banco:
        // 63 dos 75 agendamentos auditados (84%) foram gravados como particular, e
        // os 12 que levaram convênio usaram só DOIS ids — justamente os dois mais
        // frequentes do cache `local_patients`. Nenhum id fora do cache jamais
        // apareceu: o convênio nunca veio da Amigo, só do nosso próprio cache, que
        // tem convênio em 42 de 1276 pacientes (os que nós mesmos cadastramos).
        // As correções, na ordem em que entram abaixo.
        let patientInsuranceId: string | number | null = null;
        let _insSource = "nenhuma";
        let _insDebug = "sem_fetch";
        // Source 0: full patient record from Amigo (patients/exists doesn't return insurance_id)
        // O leitor agora tolera o formato (insurance_id, insurance.id, convenio_id…)
        // em vez de exigir a chave exata `insurance_id`, e grava QUAIS chaves vieram
        // — só nomes de campo, nunca valores — porque o sandbox não alcança a Amigo
        // e esse registro é a única forma de conferir o formato real em produção.
        if (patId) {
          try {
            const fullPatRes = await tryFetch(
              `patients/${patId}?company_id=${companyId}`,
              amigoToken,
              "GET",
              undefined,
              true,
            );
            if (fullPatRes.status >= 200 && fullPatRes.status < 300 && fullPatRes.data) {
              const fp = normalizeApiResponse(fullPatRes);
              _insDebug = `status=${fullPatRes.status} ${describeInsuranceShape(fp)}`.slice(0, 300);
              const _lido = readPatientInsurance(fp);
              if (_lido.id) {
                patientInsuranceId = _lido.id;
                _insSource = `cadastro_amigo:${_lido.source}`;
                console.log(`[Webhook] agendar - convênio do cadastro Amigo: ${_lido.id} (chave ${_lido.source})`);
              } else {
                console.log(`[Webhook] agendar - cadastro Amigo sem convênio (${_lido.source}) — ${_insDebug}`);
              }
            } else {
              _insDebug = `fetch_status=${fullPatRes.status}`;
            }
          } catch (fetchErr) {
            _insDebug = `fetch_erro:${(fetchErr as Error).message}`.slice(0, 120);
            console.log(`[Webhook] agendar - Full patient fetch error (non-blocking): ${(fetchErr as Error).message}`);
          }
        }
        // Source 1: patient data from API (patData fetched in Step 7.6)
        if (!patientInsuranceId && patData) {
          const _lido1 = readPatientInsurance(patData);
          if (_lido1.id) {
            patientInsuranceId = _lido1.id;
            _insSource = `patients_exists:${_lido1.source}`;
            console.log(`[Webhook] agendar - convênio do patients/exists: ${_lido1.id}`);
          }
        }
        // Source 2: cache local — POR IDENTIDADE, nunca por telefone.
        // 41 telefones do cache têm mais de uma linha; em 30 deles uma linha tem
        // convênio e a outra não (o `limit 1` derrubava o convênio), e em 7 as
        // linhas são de PACIENTES DIFERENTES — parentes no mesmo celular. Buscar
        // por telefone podia faturar a consulta no plano do parente errado.
        if (!patientInsuranceId && supabaseClient) {
          const _cpfLimpo = String((entities as any).cpf || "").replace(/\D/g, "");
          const _identidades: Array<{ col: string; val: string }> = [];
          if (patId) _identidades.push({ col: "amigo_patient_id", val: String(patId) });
          if (_cpfLimpo.length === 11) _identidades.push({ col: "cpf", val: _cpfLimpo });
          for (const ident of _identidades) {
            if (patientInsuranceId) break;
            try {
              const { data: cachedPat } = await supabaseClient
                .from("local_patients")
                .select("insurance_id, amigo_patient_id")
                .eq(ident.col, ident.val)
                .not("insurance_id", "is", null)
                .limit(1)
                .maybeSingle();
              // Guarda de identidade: se viemos pelo CPF mas a linha aponta para
              // OUTRO paciente da Amigo, não é a mesma pessoa — descarta.
              if (
                cachedPat?.insurance_id &&
                (!patId || !cachedPat.amigo_patient_id ||
                  String(cachedPat.amigo_patient_id) === String(patId))
              ) {
                patientInsuranceId = cachedPat.insurance_id;
                _insSource = `cache:${ident.col}`;
                console.log(`[Webhook] agendar - convênio do cache por ${ident.col}: ${patientInsuranceId}`);
              }
            } catch (cacheErr) {
              console.log(
                `[Webhook] agendar - Cache insurance lookup error (non-blocking): ${(cacheErr as Error).message}`,
              );
            }
          }
        }
        // Source 3: o que o paciente disse na conversa.
        // "particular"/"reembolso" NÃO é convênio: virava id e caía no guard P4,
        // que respondia ao paciente que o convênio "particular" não estava na
        // nossa lista de atendimento. Aconteceu em produção.
        // === Source 2.5: O QUE O PACIENTE ESCREVEU, SEM DEPENDER DO MODELO (17/08) ===
        // Pedido do dono: "você continua marcando as consultas como particular. As
        // meninas não sabem checar a questão do convênio. Se a pessoa fala o
        // convênio, você marca de acordo com ele."
        //
        // Todo o encanamento abaixo (Source 3 + guard P4 + resolução do plano) já
        // funcionava — só que dependia de o classificador preencher
        // `insurance_choice`, campo OPCIONAL do schema (required é só intent e
        // confidence). Medido em 10 dias: 1 de 74 mensagens de cadastro tinham o
        // campo. No caso Gabriela (17/08) a paciente escreveu "SulAmérica, Especial
        // 100" e o objeto voltou SEM a chave. Sem convênio, o Amigo grava particular
        // e a recepção perde a checagem de autorização.
        //
        // Aqui o convênio é lido do TEXTO, comparado com a lista real da clínica.
        // Não substitui nada: só preenche a lacuna para o guard P4 validar como
        // sempre validou. Olha a mensagem atual E as recentes, porque o paciente diz
        // o convênio num turno e o agendamento acontece dois turnos depois.
        if (!patientInsuranceId && !(entities as any).insurance_choice) {
          try {
            const _falas = [
              ...(Array.isArray(recentMessages) ? recentMessages : [])
                .filter((m: any) => m?.role === "user")
                .map((m: any) => String(m?.content || "")),
              String(currentMessageText || ""),
            ].join(" \n ");
            if (_falas.trim()) {
              const _insRes = await tryFetch(`insurances?company_id=${companyId}`, amigoToken);
              const _grupos = (normalizeApiResponse(_insRes) as Array<Record<string, unknown>>) || [];
              const _achado = casarConvenioNoTexto(_falas, _grupos as any);
              if (_achado) {
                (entities as any).insurance_choice = _achado.name;
                console.log(`[Webhook] agendar - convênio lido do texto do paciente: "${_achado.name}" (id do grupo ${_achado.id})`);
              } else {
                console.log("[Webhook] agendar - nenhum convênio da lista apareceu no texto do paciente");
              }
            }
          } catch (e) {
            console.log(`[Webhook] agendar - leitura de convênio no texto falhou (non-blocking): ${(e as Error).message}`);
          }
        }

        if (!patientInsuranceId && (entities as any).insurance_choice) {
          const _claim = String((entities as any).insurance_choice);
          if (isNegativeInsuranceClaim(_claim)) {
            _insSource = "particular_declarado";
            console.log(`[Webhook] agendar - paciente declarou "${_claim}" → particular, sem convênio`);
          } else {
            patientInsuranceId = _claim;
            _insSource = "conversa";
            console.log(`[Webhook] agendar - Insurance from conversation entities: ${patientInsuranceId}`);
          }
        }

        // === P4 GUARD: validar convênio contra lista oficial /insurances ===
        // Caso Conv. 81 (17/06, Maria Cecilia): IA confirmou booking pra "MedSenior",
        // convênio que NÃO atendemos. Atendente Laiz teve que corrigir. Causa:
        // a "Source 3" acima aceitava qualquer string que o paciente dissesse como
        // convênio, sem validar contra a lista real da Amigo.
        //
        // Duas correções em cima disso (04/08):
        //  • `insurances` devolve GRUPOS ("SUL AMERICA"); o attendance quer um
        //    PLANO ("PLANO ESPECIAL 100"). São espaços de id diferentes, e o guard
        //    mandava o id do GRUPO. O paciente costuma dizer o plano inteiro
        //    ("SulAmérica plano especial 100"), então dá para casar o grupo e
        //    depois resolver o plano dentro dele — é o que o cadastro já faz.
        //  • Um número solto ("2") era aceito como id literal, mas na conversa ele
        //    é a POSIÇÃO da lista que nós mesmos numeramos. Vira busca por nome.
        if (patientInsuranceId && _insSource === "conversa") {
          try {
            const insRes = await tryFetch(`insurances?company_id=${companyId}`, amigoToken);
            const insList = normalizeApiResponse(insRes) as Array<Record<string, unknown>>;
            if (Array.isArray(insList) && insList.length > 0) {
              const _claimTxt = String(patientInsuranceId).trim();
              const _pos = /^\d{1,2}$/.test(_claimTxt) ? Number(_claimTxt) : 0;
              const matched = _pos >= 1 && _pos <= insList.length
                ? insList[_pos - 1]
                : matchInsuranceGroup(_claimTxt, insList);
              if (matched) {
                let _resolvido = toInsuranceId(matched.id);
                let _nomeFinal = String(matched.name || "");
                try {
                  const plansRes = await tryFetch(
                    `insurances/plans/${matched.id}?company_id=${companyId}`,
                    amigoToken,
                  );
                  const plano = pickPlanFromGroup(normalizeApiResponse(plansRes), _claimTxt);
                  if (plano) {
                    _resolvido = plano.id;
                    _nomeFinal = plano.name || _nomeFinal;
                  }
                } catch (planErr) {
                  console.log(`[Webhook] P4: falha ao resolver plano (non-blocking): ${(planErr as Error).message}`);
                }
                if (_resolvido) {
                  patientInsuranceId = _resolvido;
                  _insSource = "conversa_validada";
                  console.log(
                    `[Webhook] P4: resolved insurance "${_claimTxt}" → id=${patientInsuranceId} (${_nomeFinal})`,
                  );
                } else {
                  patientInsuranceId = null;
                  _insSource = "conversa_sem_id";
                  console.log(`[Webhook] P4: grupo "${matched.name}" sem id utilizável — segue particular`);
                }
              } else {
                const listNames = insList.slice(0, 10).map((i) => `• ${i.name}`).join("\n");
                console.log(
                  `[Webhook] ⛔ P4: insurance "${_claimTxt}" NAO esta na lista oficial. Bloqueando booking.`,
                );
                return {
                  status: "needs_info",
                  response: "",
                  error: `Esse convênio "${_claimTxt}" não está na nossa lista de atendimento direto. Os convênios que atendemos diretamente são:\n\n${listNames}\n\nTambém atendemos *particular* e por *reembolso* (você paga a consulta e pede o ressarcimento ao seu convênio). Como você prefere?`,
                  verifiedSchedule: true,
                } as any;
              }
            }
          } catch (e) {
            console.log(`[Webhook] P4 guard error (non-blocking): ${(e as Error).message}`);
          }
        }
        // Rede final: só id numérico entra no POST. Qualquer resto de texto que
        // tenha escapado das etapas acima vira particular em vez de payload sujo.
        if (patientInsuranceId && !toInsuranceId(patientInsuranceId)) {
          console.log(`[Webhook] agendar - convênio "${patientInsuranceId}" não é id numérico — descartado`);
          patientInsuranceId = null;
          _insSource = "descartado_nao_numerico";
        }

        const attendanceBody: Record<string, unknown> = {
          start_date: startDate,
          user_id: doctorId,
          patient_id: patId,
          event_id: eventId,
          place_id: placeId,
          company_id: companyId,
        };
        if (patientInsuranceId) {
          attendanceBody.insurance_id = Number(patientInsuranceId);
          console.log(`[Webhook] agendar - Including insurance_id=${patientInsuranceId} in attendance payload`);
        } else {
          console.log(`[Webhook] agendar - ⚠️ No insurance found — booking will default to particular`);
        }

        // === PRE-BOOK GUARD: block weekend / out-of-hours bookings (defense-in-depth) ===
        const _bookGuard = validateBookingDate(startDate, businessHoursOpts || undefined);
        if (!_bookGuard.allowed) {
          console.log(`[PreBookGuard] ${_bookGuard.reason} — startDate=${startDate}`);
          return {
            status: "needs_info",
            response: _bookGuard.patientMessage || "Por favor, escolha outra data.",
            error: `[PreBookGuard] ${_bookGuard.reason}`,
            verifiedSchedule: true,
          } as any;
        }

        // Gate de carência no POST do agendar — REMOVIDO (16/08).

        // Dia fechado cadastrado (feriado/emenda): não deixar marcar PARA essa data,
        // mesmo que a agenda do Amigo esteja aberta por engano.
        // BRADESCO EFETIVO IV (31/08): o plano amarra médico E região. Barra aqui,
        // no mesmo degrau do dia fechado, porque é o último ponto antes do POST —
        // e porque aqui dá para responder ao paciente sem criar a consulta.
        {
          const _efReg = String((entities as Record<string, unknown>).efetivo_iv || "");
          if (_efReg === "recusa" || _efReg === "indefinida") {
            const _efMsg = textoEfetivoIV({
              plano: true,
              regiao: _efReg as "recusa" | "indefinida",
              medico: EFETIVO_IV_MEDICO,
            });
            console.log(`[EfetivoIV] agendamento barrado (região ${_efReg})`);
            return { status: "needs_info", response: _efMsg, error: _efMsg, bypassAiRewrite: true } as any;
          }
        }

        {
          const _cdBook = await getClosedDayInfo(supabaseClient, clinicTokenId);
          if (_cdBook.closedSet.has(isoDate)) {
            console.log(`[PreBookGuard] data-alvo ${isoDate} é dia FECHADO da clínica — bloqueando booking`);
            const _cdBookMsg = `No dia ${formatDateLabel(isoDate)} a clínica estará fechada (feriado/recesso). 🙏 Pode escolher outra data que eu verifico os horários pra você!`;
            return { status: "needs_info", response: _cdBookMsg, error: _cdBookMsg, bypassAiRewrite: true } as any;
          }
        }

        console.log(`[Webhook] Creating attendance:`, JSON.stringify(attendanceBody));
        let createResult = await tryFetch(
          `attendances?company_id=${companyId}`,
          amigoToken,
          "POST",
          attendanceBody,
          true,
        );
        // Convênio recusado pela Amigo → reenvia como particular em vez de perder o
        // agendamento inteiro. É a mesma rede que o booking-widget já usa; agora que
        // o webhook manda convênio muito mais vezes, ela passa a fazer falta aqui.
        if (attendanceBody.insurance_id && isInsuranceRejection(createResult.status, createResult.data)) {
          console.log(
            `[Webhook] agendar - convênio ${attendanceBody.insurance_id} recusado pela API — reenviando como particular`,
          );
          const _semConv = { ...attendanceBody };
          delete _semConv.insurance_id;
          _insSource = `${_insSource}→recusado_pela_api`;
          patientInsuranceId = null;
          createResult = await tryFetch(
            `attendances?company_id=${companyId}`,
            amigoToken,
            "POST",
            _semConv,
            true,
          );
        }
        if (createResult.status >= 200 && createResult.status < 300) {
          // State transition: booking_created (after successful POST attendances)
          if (supabaseClient && clinicTokenId && senderPhone) {
            await transitionConversationState(supabaseClient, {
              clinicTokenId,
              conversationId: conversationIdParam || null,
              phone: senderPhone,
              toState: "booking_created",
              trigger: "agendar:attendance_created",
              contextPatch: {
                doctor_id: doctorId,
                doctor_name: doctorName,
                date: isoDate,
                time: isoTime,
                patient_id: String(patId),
                attendance_pending_verification: true,
              },
              expectedInputs: [],
              messageId: null,
              resetContext: true,
            });
            // Enqueue cache refresh for this patient so local_attendances picks
            // up the new booking immediately, without waiting for the cron sync.
            try {
              await supabaseClient.from("sync_jobs").insert({
                clinic_token_id: clinicTokenId,
                job_type: "refresh_attendances_for_patient",
                payload: {
                  amigo_patient_id: String(patId),
                  phone: senderPhone,
                  reason: "post_booking",
                },
              });
            } catch (_e) { /* non-blocking */ }
          }
          // Clean up slot lock after successful booking
          if (supabaseClient && clinicTokenId) {
            try {
              await supabaseClient
                .from("slot_locks")
                .delete()
                .eq("clinic_token_id", clinicTokenId)
                .eq("doctor_id", doctorId)
                .eq("slot_date", entities.date)
                .eq("slot_time", entities.time + ":00");
            } catch (e) {
              /* non-blocking */
            }
          }

          // === ASYNC POST-BOOKING VERIFICATION — insert for background cron check ===
          try {
            const adminUrl = Deno.env.get("SUPABASE_URL")!;
            const adminKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
            const adminClient = createClient(adminUrl, adminKey);
            await adminClient.from("pending_booking_verifications").insert({
              phone: senderPhone || "",
              patient_id: String(patId),
              doctor_id: String(doctorId),
              doctor_name: doctorName || null,
              // BUG-1 FIX: store canonical ISO/HH:mm so verify-booking comparison is unambiguous
              target_date: isoDate,
              target_time: isoTime,
              company_id: companyId,
              amigo_token: amigoToken,
              avanceai_base_url: avanceaiConfig?.baseUrl || null,
              avanceai_api_id: avanceaiConfig?.apiId || null,
              avanceai_bearer_token: avanceaiConfig?.bearerToken || null,
              channel_id: channelId || null,
              clinic_token_id: clinicTokenId || null,
              user_id: supabaseClient ? (await supabaseClient.auth.getUser())?.data?.user?.id : null,
              place_id: placeId || null,
              event_id: eventId || null,
              // BUG-1 FIX: delay first verification by 15s so the Amigo API has time to propagate
              // the freshly-created attendance to its read replicas before we go looking for it.
              next_attempt_at: new Date(Date.now() + 15 * 1000).toISOString(),
            });
            console.log(
              `[Webhook] Post-booking verification queued for ${senderPhone} (${entities.date} ${entities.time} dr:${doctorId})`,
            );
          } catch (e) {
            console.log(`[Webhook] Failed to queue post-booking verification (non-blocking): ${(e as Error).message}`);
          }

          return {
            status: "success",
            response: JSON.stringify({
              ...(normalizeApiResponse(createResult) as object),
              _doctor_name: doctorName,
              _date: entities.date,
              _time: entities.time,
            }),
            patientName,
            // Auditoria do booking (04/07): persistido em ai_entities pela pipeline —
            // consultavel por SQL, imune a busca de logs. Mostra exatamente o que o
            // POST enviou: tipo de consulta escolhido (e a lista toda) + convenio.
            entities: {
              ...entities,
              booked_event_id: eventId,
              booked_event_name: pickedEventName,
              booked_insurance_id: patientInsuranceId ? String(patientInsuranceId) : "particular",
              // De ONDE veio o convênio (cadastro da Amigo / cache / conversa) — é o
              // que separa "o paciente é particular mesmo" de "não conseguimos ler o
              // convênio dele". Consultar com:
              //   select ai_entities->>'booked_insurance_source', count(*)
              //   from webhook_messages where ai_entities ? 'booked_insurance_source'
              //   group by 1 order by 2 desc;
              booked_insurance_source: _insSource,
              // Só os NOMES dos campos que o Amigo devolveu (nunca valores): é o que
              // permite descobrir DE ONDE ler o convênio de paciente já cadastrado,
              // já que o sandbox não alcança a API. Consultar depois com:
              //   select ai_entities->>'insurance_debug' from webhook_messages
              //   where ai_entities ? 'insurance_debug' order by created_at desc;
              insurance_debug: _insDebug,
              events_disponiveis: allEventNames.slice(0, 300),
            },
          } as any;
        }

        // Check if it's a "Limite de atendimentos" error — inform patient clearly and transfer to human
        const errorStr = JSON.stringify(createResult.data).toLowerCase();
        if (errorStr.includes("limite") && errorStr.includes("atendimento")) {
          console.log("[Webhook] ⚠️ Limite de atendimento error detected — informing patient and transferring");
          
          // Try to transfer to human for manual resolution
          if (avanceaiConfig && senderPhone) {
            try {
              let formattedPhone = senderPhone.replace(/\D/g, "");
              if (!formattedPhone.startsWith("55")) formattedPhone = "55" + formattedPhone;
              await transferTicketToHuman({
                baseUrl: avanceaiConfig.baseUrl,
                apiId: avanceaiConfig.apiId,
                bearerToken: avanceaiConfig.bearerToken,
                phone: formattedPhone,
                channelId: avanceaiConfig.channelId,
              });
              console.log("[Webhook] Limite de atendimento — transfer to human attempted");
            } catch (transferErr) {
              console.log(`[Webhook] Limite transfer error (non-blocking): ${(transferErr as Error).message}`);
            }
          }
          
          return {
            status: "success",
            response: "",
            error: `O sistema indica que há um limite de atendimentos atingido para esse horário/profissional. Um atendente da recepção foi acionado para resolver essa questão. Aguarde, por favor! 🙏`,
          };
        }

        return {
          status: "failed",
          response: "",
          error: `Erro ao criar agendamento: ${JSON.stringify(createResult.data)}`,
        };
      }

      case "cancelar": {
        if (!entities.attendance_id && !entities.cpf) {
          return {
            status: "needs_info",
            response: "",
            error: "Para cancelar, preciso do seu CPF. Por favor, informe.",
          };
        }

        let attId = entities.attendance_id;
        // Validate attendance_id is numeric
        if (attId && !/^\d+$/.test(attId)) {
          console.log("[Webhook] Invalid attendance_id (not numeric), falling back to CPF lookup: " + attId);
          attId = "";
        }

        if (!attId && entities.cpf) {
          const cleanCpf = entities.cpf.replace(/\D/g, "");
          const patResult = await tryFetch(
            `patients/exists?cpf=${cleanCpf}&company_id=${companyId}`,
            amigoToken,
            "GET",
            undefined,
            true,
          );
          const patData = normalizeApiResponse(patResult) as Record<string, unknown>;
          // Tema 3: gate inverso (status<400) fazia 502 PULAR o lookup e cair em
          // "agendamento nao encontrado". Trata queda transitoria explicitamente.
          if (isAuthApiFailure(patResult.status)) {
            return { status: "transient_error", response: AMIGO_AUTH_MESSAGE, bypassAiRewrite: true, error: amigoAuthAlert(patResult.status, "cancelar/confirmar") };
          }
          if (isTransientApiFailure(patResult.status)) {
            return { status: "transient_error", response: TRANSIENT_API_MESSAGE, bypassAiRewrite: true, error: `Amigo transient ${patResult.status} (cancelar/confirmar) [${amigoFailReason(patResult.data)}]` };
          }
          if (patData && patResult.status < 400) {
            const patientId = patData.id || patData.patient_id;
            if (patientId) {
              const attResult = await tryFetch(`attendances/${patientId}?company_id=${companyId}`, amigoToken);
              const atts = normalizeApiResponse(attResult) as Array<Record<string, unknown>>;
              console.log("[Webhook] cancelar - Raw attendances count: " + (Array.isArray(atts) ? atts.length : 0));
              if (Array.isArray(atts) && atts.length > 0) {
                // Log ALL attendances for debug
                const allDates = atts.map((a) => ({
                  id: a.id,
                  start_date: a.start_date || a.date,
                  canceled: a.canceled,
                  doctor: (a.user as any)?.name || a.doctor_name || a.user_name,
                }));
                console.log("[Webhook] cancelar - All attendances: " + JSON.stringify(allDates).substring(0, 1000));

                const todayStr = getTodayISO_SP();
                const afterDateFilter = atts
                  .filter((a) => {
                    const status = String(a.status || "").toLowerCase();
                    const canceled = a.canceled;
                    if (status === "cancelled" || status === "cancelado" || canceled === true || canceled === "true")
                      return false;
                    const startDate = String(a.start_date || a.date || "");
                    const dateOnly = startDate.split(" ")[0].split("T")[0];
                    if (dateOnly && dateOnly < todayStr) return false;
                    return true;
                  })
                  .sort((a, b) => {
                    const da = new Date((a.start_date || a.date) as string).getTime();
                    const db = new Date((b.start_date || b.date) as string).getTime();
                    return da - db;
                  });
                console.log("[Webhook] cancelar - After date filter: " + afterDateFilter.length);

                let upcoming = afterDateFilter;
                if (entities.doctor_name && afterDateFilter.length > 0) {
                  const afterDoctorFilter = afterDateFilter.filter((a) => {
                    const userObj = a.user as Record<string, unknown> | undefined;
                    const docName = ((a.doctor_name || a.user_name || userObj?.name || "") as string).toLowerCase();
                    return docName.includes(entities.doctor_name.toLowerCase());
                  });
                  console.log("[Webhook] cancelar - After doctor filter: " + afterDoctorFilter.length);
                  upcoming = afterDoctorFilter.length > 0 ? afterDoctorFilter : afterDateFilter;
                }

                console.log("[Webhook] cancelar - Final upcoming: " + upcoming.length);
                if (upcoming.length === 1) {
                  attId = String(upcoming[0].id);
                  console.log("[Webhook] cancelar - Single match, selected attendance ID: " + attId);
                } else if (upcoming.length > 1) {
                  // Multiple candidates — list and ask which one. Auto-selecting [0]
                  // had the patient losing the wrong appointment.
                  const lines = upcoming.slice(0, 5).map((a, idx) => {
                    const userObj = a.user as Record<string, unknown> | undefined;
                    const docName = (a.doctor_name || a.user_name || userObj?.name || "médico") as string;
                    const rawDate = String(a.start_date || a.date || "");
                    const niceDate = rawDate ? formatDateLabel(rawDate.slice(0, 10)) : rawDate;
                    const niceTime = rawDate.includes("T") ? rawDate.slice(11, 16) : "";
                    return `${idx + 1}. ${niceDate}${niceTime ? ` às ${niceTime}` : ""} com ${docName} (id ${a.id})`;
                  });
                  const fullMsg = `Encontrei mais de um agendamento futuro. Qual você quer cancelar?\n\n${lines.join("\n")}\n\nResponda com o número ou o id.`;
                  return {
                    status: "needs_info",
                    response: fullMsg,
                    error: fullMsg,
                    verifiedSchedule: true,
                  } as any;
                }
              }
            }
          }
        }

        if (!attId) {
          return { status: "failed", response: "", error: "Agendamento não encontrado para cancelar" };
        }

        const cancelResult = await tryFetch(
          `attendances/cancel/${attId}?company_id=${companyId}`,
          amigoToken,
          "PUT",
          undefined,
          true,
        );
        // Fallback oficial (mesma familia do confirm — rota legada removida):
        let cancelFinal = cancelResult;
        if (cancelResult.status === 404 || cancelResult.status === 502) {
          const offCancel = await tryFetch(
            `api/attendance/cancel`,
            amigoToken,
            "PUT",
            { id: Number(attId), company_id: Number(companyId) },
            true,
          );
          console.error(
            `[Webhook] cancelar legacy FALHOU attId=${attId} — legacy=${cancelResult.status} body=${JSON.stringify(cancelResult.data).substring(0, 250)} | oficial=${offCancel.status} body=${JSON.stringify(offCancel.data).substring(0, 250)}`,
          );
          if (offCancel.status >= 200 && offCancel.status < 300) cancelFinal = offCancel;
        }
        if (cancelFinal.status >= 200 && cancelFinal.status < 300) {
          // Update local cache: mark this attendance as canceled and enqueue full refresh
          if (supabaseClient && clinicTokenId) {
            try {
              await supabaseClient
                .from("local_attendances")
                .update({ status: "canceled", last_synced_at: new Date().toISOString() })
                .eq("clinic_token_id", clinicTokenId)
                .eq("amigo_attendance_id", String(attId));
            } catch (_e) { /* non-blocking */ }
            try {
              await supabaseClient.from("sync_jobs").insert({
                clinic_token_id: clinicTokenId,
                job_type: "refresh_attendances_for_patient",
                payload: {
                  amigo_patient_id: entities.cpf || null,
                  phone: senderPhone || null,
                  reason: "post_cancel",
                },
              });
            } catch (_e) { /* non-blocking */ }
          }
          return { status: "success", response: `Agendamento ${attId} cancelado com sucesso` };
        }
        return {
          status: "failed",
          response: "",
          error: "Não consegui concluir o cancelamento automaticamente. Já avisei nossa equipe pra finalizar pra você.",
        };
      }

      case "confirmar": {
        if (!entities.attendance_id && !entities.cpf) {
          return {
            status: "needs_info",
            response: "",
            error: "Para confirmar, preciso do seu CPF. Por favor, informe.",
          };
        }

        let attId = entities.attendance_id;
        let selectedAtt: Record<string, unknown> | null = null;
        // Contrato do PUT /attendances/{status} (Swagger 04/07): body exige
        // patient_id + attendance_id. Icado do escopo do lookup por CPF.
        let confirmPatientId: string | null = null;
        // Diagnóstico durável (bug Juarez 07/07 — confirmar não achou consulta que
        // EXISTIA no Amigo): grava no ai_entities ONDE o lookup parou, já que os logs
        // do Lovable não são confiáveis. Permite root-cause por SQL na próxima vez.
        let _confPatientFound = false;
        let _confAttCount = -1;
        let _confAfterFilter = -1;
        // Validate attendance_id is numeric
        if (attId && !/^\d+$/.test(attId)) {
          console.log("[Webhook] Invalid attendance_id (not numeric), falling back to CPF lookup: " + attId);
          attId = "";
        }


        if (!attId && entities.cpf) {
          const cleanCpf = entities.cpf.replace(/\D/g, "");
          const patResult = await tryFetch(
            `patients/exists?cpf=${cleanCpf}&company_id=${companyId}`,
            amigoToken,
            "GET",
            undefined,
            true,
          );
          const patData = normalizeApiResponse(patResult) as Record<string, unknown>;
          // Tema 3: gate inverso (status<400) fazia 502 PULAR o lookup e cair em
          // "agendamento nao encontrado". Trata queda transitoria explicitamente.
          if (isAuthApiFailure(patResult.status)) {
            return { status: "transient_error", response: AMIGO_AUTH_MESSAGE, bypassAiRewrite: true, error: amigoAuthAlert(patResult.status, "cancelar/confirmar") };
          }
          if (isTransientApiFailure(patResult.status)) {
            return { status: "transient_error", response: TRANSIENT_API_MESSAGE, bypassAiRewrite: true, error: `Amigo transient ${patResult.status} (cancelar/confirmar) [${amigoFailReason(patResult.data)}]` };
          }
          if (patData && patResult.status < 400) {
            const patientId = patData.id || patData.patient_id;
            confirmPatientId = patientId ? String(patientId) : null;
            if (patientId) {
              _confPatientFound = true;
              const attResult = await tryFetch(`attendances/${patientId}?company_id=${companyId}`, amigoToken);
              const atts = normalizeApiResponse(attResult) as Array<Record<string, unknown>>;
              console.log("[Webhook] confirmar - Raw attendances count: " + (Array.isArray(atts) ? atts.length : 0));
              _confAttCount = Array.isArray(atts) ? atts.length : 0;
              if (Array.isArray(atts) && atts.length > 0) {
                const allDates = atts.map((a) => ({
                  id: a.id,
                  start_date: a.start_date || a.date,
                  canceled: a.canceled,
                  doctor: (a.user as any)?.name || a.doctor_name || a.user_name,
                }));
                console.log("[Webhook] confirmar - All attendances: " + JSON.stringify(allDates).substring(0, 1000));

                const todayStr = getTodayISO_SP();
                const afterDateFilter = atts
                  .filter((a) => {
                    const status = String(a.status || "").toLowerCase();
                    const canceled = a.canceled;
                    if (status === "cancelled" || status === "cancelado" || canceled === true || canceled === "true")
                      return false;
                    // NÃO descartamos confirmed/confirmado aqui — se já está confirmado,
                    // queremos pegar esse mesmo registro pra responder com dados reais
                    // (e pular o PUT). Antes a gente filtrava e perdia o "sim" do paciente.
                    const startDate = String(a.start_date || a.date || "");
                    const dateOnly = startDate.split(" ")[0].split("T")[0];
                    if (dateOnly && dateOnly < todayStr) return false;
                    return true;
                  })
                  .sort((a, b) => {
                    const da = new Date((a.start_date || a.date) as string).getTime();
                    const db = new Date((b.start_date || b.date) as string).getTime();
                    return da - db;
                  });
                console.log("[Webhook] confirmar - After date filter: " + afterDateFilter.length);

                let upcoming = afterDateFilter;
                if (entities.doctor_name && afterDateFilter.length > 0) {
                  const afterDoctorFilter = afterDateFilter.filter((a) => {
                    const userObj = a.user as Record<string, unknown> | undefined;
                    const docName = ((a.doctor_name || a.user_name || userObj?.name || "") as string).toLowerCase();
                    return docName.includes(entities.doctor_name.toLowerCase());
                  });
                  console.log("[Webhook] confirmar - After doctor filter: " + afterDoctorFilter.length);
                  upcoming = afterDoctorFilter.length > 0 ? afterDoctorFilter : afterDateFilter;
                }

                console.log("[Webhook] confirmar - Final upcoming: " + upcoming.length);
                _confAfterFilter = upcoming.length;
                if (upcoming.length > 0) {
                  attId = String(upcoming[0].id);
                  selectedAtt = upcoming[0];
                  if (!confirmPatientId) {
                    const pFromAtt = (upcoming[0] as Record<string, unknown>).patient_id || (upcoming[0] as Record<string, unknown>).patientId;
                    if (pFromAtt) confirmPatientId = String(pFromAtt);
                  }
                  console.log("[Webhook] confirmar - Selected attendance ID: " + attId);
                }
              }
            }
          }
        }

        if (!attId) {
          const _confDiag = {
            confirmar_patient_found: _confPatientFound,
            confirmar_att_count: _confAttCount,
            confirmar_after_filter: _confAfterFilter,
            confirmar_cpf: (entities.cpf || "").replace(/\D/g, ""),
          };
          // Paciente forneceu um CPF real mas o bot não localizou a consulta (bug Juarez
          // 07/07: a consulta existia no Amigo, mas o lookup/filtro falhou). NÃO dar o
          // beco sem saída "não encontrei" — transfere para uma atendente que enxerga a
          // agenda, pra nunca perder um paciente com consulta real. Cobre os DOIS modos
          // de falha: paciente achado sem consulta OU a própria busca do paciente falhou
          // (por isso aceita também um CPF válido). Diagnóstico gravado em ai_entities.
          if ((_confPatientFound || (entities.cpf && isValidCpf(entities.cpf))) && senderPhone && avanceaiConfig) {
            let _fp = senderPhone.replace(/\D/g, "");
            if (!_fp.startsWith("55")) _fp = "55" + _fp;
            try {
              await transferTicketToHuman({
                baseUrl: avanceaiConfig.baseUrl,
                apiId: avanceaiConfig.apiId,
                bearerToken: avanceaiConfig.bearerToken,
                phone: _fp,
                channelId,
              });
            } catch (_e) {
              console.error(`[Webhook] confirmar - transfer fallback failed: ${(_e as Error).message}`);
            }
            return {
              status: "success",
              response:
                "Encontrei seu cadastro aqui, mas não consegui puxar sua consulta pelo sistema automático. 🙏 Já pedi para uma colega da equipe confirmar isso pra você agora — ela vê sua agenda certinho. Só um instante!",
              bypassAiRewrite: true,
              entities: _confDiag,
            } as any;
          }
          return { status: "failed", response: "", error: "Agendamento não encontrado para confirmar", entities: _confDiag } as any;
        }

        // ── Helper: monta bloco VERIFIED_BOOKING a partir do attendance selecionado ──
        const buildVerifiedBookingResponse = (att: Record<string, unknown> | null, prefix: string): string => {
          if (!att) return prefix;
          const userObj = att.user as Record<string, unknown> | undefined;
          const docName = (att.doctor_name || att.user_name || userObj?.name || "") as string;
          const startRaw = String(att.start_date || att.date || "");
          const [datePart, timePartRaw] = startRaw.split(/[ T]/);
          const timePart = (timePartRaw || "").substring(0, 5);
          const tag = `<!-- VERIFIED_BOOKING: date=${datePart || "?"} time=${timePart || "?"} doctor=${docName || "?"} -->`;
          return `${tag}\n${prefix}`;
        };

        // ── Pré-checagem: se já está confirmado, NÃO chama PUT (evita 404 e ruído) ──
        if (selectedAtt) {
          const curStatus = String(selectedAtt.status || "").toLowerCase();
          if (curStatus === "confirmed" || curStatus === "confirmado") {
            console.log(`[Webhook] confirmar - attId=${attId} já está confirmado, pulando PUT`);
            return {
              status: "success",
              response: buildVerifiedBookingResponse(selectedAtt, `Agendamento ${attId} já estava confirmado.`),
              verifiedSchedule: true,
            } as any;
          }
        }

        console.log(`[Webhook] confirmar - Attempting confirm for attId=${attId}, companyId=${companyId}`);
        const confirmResult = await tryFetch(
          `attendances/confirm/${attId}?company_id=${companyId}`,
          amigoToken,
          "PUT",
          undefined,
          true,
        );

        // ── Fallback: a rota /attendances/confirm/{id} foi REMOVIDA da API. ──
        // Swagger atual (print 04/07): PUT /attendances/{status} — o STATUS vai
        // no path e o id no corpo. Tentamos as variantes do token de status e,
        // em ultimo caso, a familia oficial /api (que hoje responde 401 por
        // permissao — capturado 04/07 — mas pode ser liberada pelo suporte).
        let finalResult = confirmResult;
        if (confirmResult.status === 404 || confirmResult.status === 502) {
          console.error(
            `[Webhook] confirmar - legacy morto para attId=${attId} (${confirmResult.status}), tentando PUT /attendances/{status}. Response: ${JSON.stringify(confirmResult.data).substring(0, 200)}`,
          );
          for (const statusToken of ["confirmed", "confirm", "confirmado"]) {
            const r = await tryFetch(
              `attendances/${statusToken}?company_id=${companyId}`,
              amigoToken,
              "PUT",
              {
                attendance_id: Number(attId),
                ...(confirmPatientId ? { patient_id: Number(confirmPatientId) } : {}),
              },
              true,
            );
            console.log(
              `[Webhook] confirmar - PUT /attendances/${statusToken} -> ${r.status} body=${JSON.stringify(r.data).substring(0, 200)}`,
            );
            if (r.status >= 200 && r.status < 300) {
              finalResult = r;
              break;
            }
            // 4xx de validacao (nao-404) e' resposta conclusiva desta rota — para.
            if (r.status !== 404 && r.status !== 502) {
              finalResult = r;
              break;
            }
          }
          if (!(finalResult.status >= 200 && finalResult.status < 300) && (finalResult.status === 404 || finalResult.status === 502)) {
            const officialResult = await tryFetch(
              `api/attendance/confirm`,
              amigoToken,
              "PUT",
              { id: Number(attId), company_id: Number(companyId) },
              true,
            );
            console.log(`[Webhook] confirmar - official endpoint status=${officialResult.status}`);
            if (officialResult.status !== 404) finalResult = officialResult;
          }
        }

        if (finalResult.status >= 200 && finalResult.status < 300) {
          return {
            status: "success",
            response: buildVerifiedBookingResponse(selectedAtt, `Agendamento ${attId} confirmado com sucesso.`),
            verifiedSchedule: true,
          } as any;
        }
        // FIX (caso Adriana 03/07): a mensagem dizia "vou transferir pra equipe"
        // mas o ticket NUNCA era transferido — a paciente ficava esperando alguem
        // que nao foi avisado. Agora transfere de verdade. E loga o corpo da
        // resposta dos DOIS endpoints (docs/amigo-api-reference.md pede isso ha
        // semanas pra descobrir o formato correto do confirm oficial).
        console.error(
          `[Webhook] confirmar FALHOU attId=${attId} — legacy=${confirmResult.status} body=${JSON.stringify(confirmResult.data).substring(0, 300)} | final=${finalResult.status} body=${JSON.stringify(finalResult.data).substring(0, 300)}`,
        );
        if (avanceaiConfig && senderPhone) {
          try {
            await transferTicketToHuman({
              baseUrl: avanceaiConfig.baseUrl,
              apiId: avanceaiConfig.apiId,
              bearerToken: avanceaiConfig.bearerToken,
              phone: senderPhone,
              channelId: channelId || null,
            });
            console.log(`[Webhook] confirmar - ticket transferido pra humano apos falha do PUT`);
          } catch (e) {
            console.error(`[Webhook] confirmar - transfer pos-falha tambem falhou: ${(e as Error).message}`);
          }
        }
        // Mensagem limpa pro LLM — sem JSON cru, sem [object Object]
        return {
          status: "failed",
          response: "",
          error: "Não consegui registrar a confirmação automaticamente no sistema. Já acionei nossa equipe pra concluir a confirmação pra você.",
        };
      }


      case "reagendar": {
        // SANITIZAÇÃO (caso Felipe 19/07, aceite da lista de espera): o classificador
        // LLM marca reagendar_confirmed=true ao ver "pode confirmar" MESMO sem nenhum
        // attendance_id real ("preservar do histórico" que não existia) — o fluxo
        // pulava pro passo confirmado e morria em "ID do agendamento inválido", até
        // com CPF na mão. Confirmação sem ID verificável não vale nada (não confiar
        // no LLM p/ dado crítico): degrada pro passo de busca/confirmação (Step 2),
        // que localiza a consulta real pelo CPF e pergunta "é essa?".
        if (entities.attendance_id && !/^\d+$/.test(String(entities.attendance_id))) {
          console.log(`[Webhook] reagendar - attendance_id não-numérico ("${entities.attendance_id}") — limpando`);
          entities.attendance_id = "";
        }
        if (entities.reagendar_confirmed && !entities.attendance_id) {
          console.log("[Webhook] reagendar - reagendar_confirmed SEM attendance_id (alucinação do classificador) — degradando para busca+confirmação");
          entities.reagendar_confirmed = false;
        }
        // ── Step 1: Need CPF to identify patient ──
        if (!entities.cpf && !entities.attendance_id) {
          return {
            status: "needs_info",
            response: "",
            error: "Para reagendar, preciso do seu CPF. Por favor, informe.",
          };
        }

        // ── Step 2: Fetch future appointments ──
        // If reagendar_confirmed is NOT set, we need to list and confirm first
        if (!entities.reagendar_confirmed) {
          let attId = entities.attendance_id;
          if (attId && !/^\d+$/.test(attId)) {
            console.log(
              "[Webhook] reagendar - Invalid attendance_id (not numeric), falling back to CPF lookup: " + attId,
            );
            attId = "";
          }

          // If we already have a valid numeric attId from a previous turn, skip lookup
          if (!attId && entities.cpf) {
            const cleanCpf = entities.cpf.replace(/\D/g, "");
            const patResult = await tryFetch(
              `patients/exists?cpf=${cleanCpf}&company_id=${companyId}`,
              amigoToken,
              "GET",
              undefined,
              true,
            );
            const patData = normalizeApiResponse(patResult) as Record<string, unknown>;
            // Tema 3: queda do Amigo (502/5xx) != "CPF nao encontrado" no reagendamento.
            if (isAuthApiFailure(patResult.status)) {
              return { status: "transient_error", response: AMIGO_AUTH_MESSAGE, bypassAiRewrite: true, error: amigoAuthAlert(patResult.status, "reagendar") };
            }
            if (isTransientApiFailure(patResult.status)) {
              return { status: "transient_error", response: TRANSIENT_API_MESSAGE, bypassAiRewrite: true, error: `Amigo transient ${patResult.status} (reagendar) [${amigoFailReason(patResult.data)}]` };
            }
            if (!patData || patResult.status >= 400) {
              return { status: "failed", response: "", error: "Paciente não encontrado com este CPF." };
            }

            const patientId = patData.id || patData.patient_id;
            if (!patientId) {
              return { status: "failed", response: "", error: "Paciente não encontrado com este CPF." };
            }

            const attResult = await tryFetch(`attendances/${patientId}?company_id=${companyId}`, amigoToken);
            const atts = normalizeApiResponse(attResult) as Array<Record<string, unknown>>;
            console.log("[Webhook] reagendar - Raw attendances count: " + (Array.isArray(atts) ? atts.length : 0));

            if (!Array.isArray(atts) || atts.length === 0) {
              return { status: "failed", response: "", error: "Não encontrei agendamentos para este paciente." };
            }

            const todayStr = getTodayISO_SP();
            const upcoming = atts
              .filter((a) => {
                const status = String(a.status || "").toLowerCase();
                const canceled = a.canceled;
                if (status === "cancelled" || status === "cancelado" || canceled === true || canceled === "true")
                  return false;
                const startDate = String(a.start_date || a.date || "");
                const dateOnly = startDate.split(" ")[0].split("T")[0];
                if (dateOnly && dateOnly < todayStr) return false;
                return true;
              })
              .sort((a, b) => {
                const da = new Date((a.start_date || a.date) as string).getTime();
                const db = new Date((b.start_date || b.date) as string).getTime();
                return da - db;
              });

            // Apply doctor filter if provided
            if (entities.doctor_name && upcoming.length > 1) {
              const filtered = upcoming.filter((a) => {
                const userObj = a.user as Record<string, unknown> | undefined;
                const docName = ((a.doctor_name || a.user_name || userObj?.name || "") as string).toLowerCase();
                return docName.includes(entities.doctor_name.toLowerCase());
              });
              if (filtered.length > 0) {
                upcoming.splice(0, upcoming.length, ...filtered);
              }
            }

            console.log("[Webhook] reagendar - Future appointments found: " + upcoming.length);

            if (upcoming.length === 0) {
              return { status: "failed", response: "", error: "Não encontrei consultas futuras para reagendar." };
            }

            // ── 1 appointment: ask for confirmation ──
            if (upcoming.length === 1) {
              const att = upcoming[0];
              const userObj = att.user as Record<string, unknown> | undefined;
              const docName = (att.doctor_name || att.user_name || userObj?.name || "médico") as string;
              const startDate = String(att.start_date || att.date || "");
              const datePart = startDate.split(" ")[0].split("T")[0];
              const timePart = startDate.includes(" ") ? startDate.split(" ")[1]?.substring(0, 5) : "";
              const formattedDate = datePart.split("-").reverse().join("/");

              return {
                status: "needs_info",
                response: `Encontrei sua consulta com *${docName}* no dia *${formattedDate}*${timePart ? ` às *${timePart}*` : ""}. É essa que deseja reagendar?`,
                entities: { ...entities, attendance_id: String(att.id) },
              };
            }

            // ── Multiple appointments: list and ask to choose ──
            let listMsg = "Encontrei as seguintes consultas futuras:\n\n";
            upcoming.forEach((att, idx) => {
              const userObj = att.user as Record<string, unknown> | undefined;
              const docName = (att.doctor_name || att.user_name || userObj?.name || "médico") as string;
              const startDate = String(att.start_date || att.date || "");
              const datePart = startDate.split(" ")[0].split("T")[0];
              const timePart = startDate.includes(" ") ? startDate.split(" ")[1]?.substring(0, 5) : "";
              const formattedDate = datePart.split("-").reverse().join("/");
              listMsg += `*${idx + 1}.* ${docName} — ${formattedDate}${timePart ? ` às ${timePart}` : ""} (ID: ${att.id})\n`;
            });
            listMsg += "\nQual consulta deseja reagendar? Informe o número ou o nome do médico.";

            return {
              status: "needs_info",
              response: listMsg,
              entities: { ...entities },
            };
          }

          // If we have attId but no confirmation yet, ask for it
          if (attId) {
            return {
              status: "needs_info",
              response: "Confirma que deseja reagendar este agendamento?",
              entities: { ...entities, attendance_id: attId },
            };
          }

          return { status: "failed", response: "", error: "Agendamento não encontrado para reagendar." };
        }

        // ── Step 3 & 4: Confirmed — now ask for new date and execute ──
        let attId = entities.attendance_id;
        if (!attId || !/^\d+$/.test(attId || "")) {
          return {
            status: "failed",
            response: "",
            error: "ID do agendamento inválido. Tente novamente informando seu CPF.",
          };
        }

        // ── Real-slot search BEFORE PUT ──
        // If patient gave only weekday/period, only date (no time), or nothing:
        // fetch the original attendance to extract event/place/doctor, then list REAL
        // calendar slots filtered by date and/or weekday+period — never invent.
        const needsSlotSearch =
          !entities.date ||
          !entities.time ||
          !!entities.preferred_weekday ||
          !!entities.preferred_period;

        if (needsSlotSearch) {
          try {
            // 1) Fetch the original attendance to get doctor_id, event_id, place_id
            let origDoctorId = "";
            let origDoctorName = entities.doctor_name || "";
            let origEventId = "";
            let origPlaceId = "";

            if (entities.cpf) {
              const cleanCpf = entities.cpf.replace(/\D/g, "");
              const patRes = await tryFetch(
                `patients/exists?cpf=${cleanCpf}&company_id=${companyId}`,
                amigoToken,
                "GET",
                undefined,
                true,
              );
              const patObj = normalizeApiResponse(patRes) as Record<string, unknown>;
              const patientId = patObj?.id || patObj?.patient_id;
              if (patientId) {
                const attRes = await tryFetch(`attendances/${patientId}?company_id=${companyId}`, amigoToken);
                const attsArr = normalizeApiResponse(attRes) as Array<Record<string, unknown>>;
                if (Array.isArray(attsArr)) {
                  const matchAtt = attsArr.find((a) => String(a.id) === String(attId));
                  if (matchAtt) {
                    const userObj = matchAtt.user as Record<string, unknown> | undefined;
                    origDoctorId = String(matchAtt.user_id || userObj?.id || "");
                    origDoctorName = (matchAtt.doctor_name || matchAtt.user_name || userObj?.name || origDoctorName) as string;
                    origEventId = String(matchAtt.event_id || (matchAtt.agenda_event as any)?.id || "");
                    origPlaceId = String(matchAtt.place_id || (matchAtt.place as any)?.id || "");
                  }
                }
              }
            }

            console.log(
              `[Webhook] reagendar slot-search — doctor=${origDoctorId} event=${origEventId} place=${origPlaceId}`,
            );

            if (origDoctorId && origEventId && origPlaceId) {
              // 2) Fetch full calendar for doctor+event+place
              const calUrl = `calendar?place_id=${origPlaceId}&event_id=${origEventId}&user_id=${origDoctorId}&company_id=${companyId}`;
              const calRes = await tryFetch(calUrl, amigoToken);
              const calData = normalizeApiResponse(calRes) as Array<Record<string, unknown>>;

              // 3) Build slotsMap by date
              const slotsMap = new Map<string, string[]>();
              if (Array.isArray(calData)) {
                for (const dayObj of calData) {
                  const dayDate = String(dayObj.date || dayObj.day || dayObj.data || "");
                  if (!dayDate) continue;
                  const slotsByUser = (dayObj.slotsByUser ||
                    dayObj.slots_by_user ||
                    (dayObj as any).SlotsByUser) as Array<Record<string, unknown>> | undefined;
                  const times: string[] = [];
                  if (slotsByUser && Array.isArray(slotsByUser)) {
                    for (const userSlots of slotsByUser) {
                      const u = (userSlots.user || (userSlots as any).User) as Record<string, unknown> | undefined;
                      const uid = u?.id || (userSlots as any).user_id;
                      if (origDoctorId && uid && String(uid) !== String(origDoctorId)) continue;
                      // Fail-closed (30/06 conv 76): bloco sem userId em resposta multi-usuario.
                      if (origDoctorId && !uid && slotsByUser.length > 1) continue;
                      const slots = (userSlots.slots || (userSlots as any).Slots) as Array<Record<string, unknown>> | undefined;
                      if (slots && Array.isArray(slots)) {
                        for (const s of slots) {
                          const raw = String(s.start_time || s.startTime || s.start || s.time || "");
                          const m = raw.match(/(\d{2}:\d{2})/);
                          if (m) times.push(m[1]);
                        }
                      }
                    }
                  }
                  if (times.length > 0) slotsMap.set(dayDate, [...new Set(times)].sort());
                }
              }
              console.log(`[Webhook] reagendar slot-search — slotsMap size=${slotsMap.size}`);

              // 4) Determine candidate dates
              const todayStr = getTodayISO_SP();
              const _todasAsDatas = [...slotsMap.keys()].filter((d) => d >= todayStr).sort();

              // QUEM MANDA É O TURNO ATUAL, NÃO A ENTIDADE HERDADA (01/09).
              // `entities.date` vem preenchido com a data da consulta ENCONTRADA — o
              // classificador copia "sua consulta é 31/08" para lá. Usar isso como
              // filtro fazia "tem quarta?" virar "quartas dentro de 31/08" (uma
              // segunda-feira) e devolver negativa numa agenda cheia. Cada negativa
              // dessas alimenta a Regra 7, que transfere para humano.
              //
              // Ordem de precedência, da mais específica para a mais genérica:
              //   1. dia da semana dito AGORA  -> varre o calendário inteiro nesse dia
              //   2. dia dito AGORA ("hoje", "dia 12") -> respeita a data, mesmo que
              //      ela coincida com a da consulta velha (remarcar para hoje mais
              //      tarde é pedido legítimo — caso Alvaro, 31/08 14:47)
              //   3. nada dito sobre dia -> calendário inteiro, sem estreitar
              const _weekdayMap: Record<string, number> = {
                domingo: 0, segunda: 1, terca: 2, terça: 2,
                quarta: 3, quinta: 4, sexta: 5, sabado: 6, sábado: 6,
              };
              const _diaPedido =
                diaDaSemanaPedido(currentMessageText) ??
                (entities.preferred_weekday ? _weekdayMap[entities.preferred_weekday.toLowerCase()] : undefined) ??
                null;
              const _falouDeDia = mensagemFalaDeDia(currentMessageText);

              let candidateDates: string[] = [];
              if (_diaPedido !== null && _diaPedido !== undefined) {
                candidateDates = _todasAsDatas.filter((d) => getWeekday(d) === _diaPedido);
                console.log(`[Webhook] reagendar - dia da semana pedido AGORA (${_diaPedido}) vence data herdada — ${candidateDates.length} data(s)`);
              } else if (entities.date && _falouDeDia) {
                const iso = normalizeDateToISO(entities.date) || entities.date;
                if (iso) candidateDates = [iso];
              } else {
                if (entities.date) {
                  console.log(`[Webhook] reagendar - entities.date="${entities.date}" veio do contexto (o paciente não falou de dia agora) — varrendo o calendário inteiro`);
                }
                candidateDates = _todasAsDatas;
              }

              // 5) Apply period filter and weekend block
              const periodFilter = entities.preferred_period || undefined;
              const datesWithSlots: Array<{ date: string; label: string; slots: string[] }> = [];
              const MAX_DATES = 4;
              const MAX_SLOTS_PER_DATE = 4;
              for (const d of candidateDates) {
                if (datesWithSlots.length >= MAX_DATES) break;
                const dow = getWeekday(d);
                if (dow === 0 || dow === 6) continue; // skip weekends
                let slots = slotsMap.get(d) || [];
                if (periodFilter === "manha") slots = slots.filter((t) => t < "12:00");
                if (periodFilter === "tarde") slots = slots.filter((t) => t >= "12:00");
                if (slots.length === 0) continue;
                datesWithSlots.push({
                  date: d,
                  label: formatDateLabel(d),
                  slots: slots.slice(0, MAX_SLOTS_PER_DATE),
                });
              }

              if (datesWithSlots.length > 0) {
                // If patient gave EXACT date+time AND it's in the verified slots → proceed to PUT
                if (entities.date && entities.time) {
                  const wantedDate = normalizeDateToISO(entities.date) || entities.date;
                  const wantedTime = normalizeTimeToHHMM(entities.time) || entities.time;
                  const dayHit = datesWithSlots.find((p) => p.date === wantedDate);
                  if (dayHit && dayHit.slots.includes(wantedTime)) {
                    console.log(`[Webhook] reagendar — exact slot ${wantedDate} ${wantedTime} verified, proceeding to PUT`);
                    // fall through to PUT below
                  } else {
                    // Asked time not available — list real options
                    const periodLabel =
                      periodFilter === "manha" ? " (manhã)" : periodFilter === "tarde" ? " (tarde)" : "";
                    const header = `O horário ${wantedTime} não está livre. Estes são os horários reais disponíveis com ${origDoctorName || "o médico"}${periodLabel}:\n\n`;
                    const body = datesWithSlots.map((p) => `${p.label}: ${p.slots.join(", ")}`).join("\n");
                    const footer = "\n\nQual data e horário prefere?";
                    const fullMsg = header + body + footer;
                    if (supabaseClient && clinicTokenId && origDoctorId) {
                      await lockPresentedSlots(supabaseClient, clinicTokenId, origDoctorId, datesWithSlots, senderPhone || "");
                    }
                    return {
                      status: "needs_info",
                      response: fullMsg,
                      error: fullMsg,
                      verifiedSchedule: true,
                      entities: { ...entities, attendance_id: attId, doctor_name: origDoctorName },
                    } as any;
                  }
                } else {
                  // No exact time — present real slots
                  const periodLabel =
                    periodFilter === "manha" ? " (manhã)" : periodFilter === "tarde" ? " (tarde)" : "";
                  const header = `Confirmei aqui na agenda do ${origDoctorName || "médico"}${periodLabel}. Estes são os horários reais para reagendar:\n\n`;
                  const body = datesWithSlots.map((p) => `${p.label}: ${p.slots.join(", ")}`).join("\n");
                  const footer = "\n\nQual data e horário prefere?";
                  const fullMsg = header + body + footer;
                  if (supabaseClient && clinicTokenId && origDoctorId) {
                    await lockPresentedSlots(supabaseClient, clinicTokenId, origDoctorId, datesWithSlots, senderPhone || "");
                  }
                  return {
                    status: "needs_info",
                    response: fullMsg,
                    error: fullMsg,
                    verifiedSchedule: true,
                    entities: { ...entities, attendance_id: attId, doctor_name: origDoctorName },
                  } as any;
                }
              } else {
                // No real slots — be honest
                const fbMsg = `Confirmei aqui e não encontrei horários disponíveis com ${origDoctorName || "o médico"}${entities.preferred_weekday ? ` em ${entities.preferred_weekday}s` : ""}${periodFilter === "manha" ? " pela manhã" : periodFilter === "tarde" ? " à tarde" : ""}${entities.date ? ` em ${entities.date}` : " nas próximas datas"}. Quer que eu tente outra data ou outro período?`;
                return {
                  status: "needs_info",
                  response: fbMsg,
                  error: fbMsg,
                  verifiedSchedule: true,
                  entities: { ...entities, attendance_id: attId, doctor_name: origDoctorName },
                } as any;
              }
            } else if (!entities.date || !entities.time) {
              // Couldn't resolve doctor/event/place AND missing date/time — ask for full info
              return {
                status: "needs_info",
                response: "Para qual data e horário deseja reagendar? Pode me passar uma data útil (segunda a sexta).",
                entities: { ...entities, attendance_id: attId },
              };
            }
          } catch (slotErr) {
            console.log(`[Webhook] reagendar slot-search error (non-blocking): ${(slotErr as Error).message}`);
            if (!entities.date || !entities.time) {
              return {
                status: "needs_info",
                response: "Para qual data e horário deseja reagendar? Pode me passar uma data útil.",
                entities: { ...entities, attendance_id: attId },
              };
            }
            // else: fall through to PUT with provided date/time
          }
        }

        // BUG-1 FIX: canonicalize date/time before sending to Amigo's reschedule endpoint
        const reschedIsoDate = normalizeDateToISO(entities.date) || entities.date;
        const reschedIsoTime = entities.time ? normalizeTimeToHHMM(entities.time) || entities.time : "08:00";
        const newDateTime = `${reschedIsoDate} ${reschedIsoTime}`;

        // === PRE-BOOK GUARD: block weekend / out-of-hours reschedules ===
        const _reschedGuard = validateBookingDate(newDateTime, businessHoursOpts || undefined);
        if (!_reschedGuard.allowed) {
          console.log(`[PreBookGuard] reschedule ${_reschedGuard.reason} — newDateTime=${newDateTime}`);
          return {
            status: "needs_info",
            response: _reschedGuard.patientMessage || "Por favor, escolha outra data para o reagendamento.",
            error: `[PreBookGuard] reschedule ${_reschedGuard.reason}`,
            verifiedSchedule: true,
          } as any;
        }
        // Dia fechado cadastrado (feriado/emenda): não reagendar PARA essa data.
        {
          const _cdResched = await getClosedDayInfo(supabaseClient, clinicTokenId);
          if (_cdResched.closedSet.has(reschedIsoDate)) {
            console.log(`[PreBookGuard] reschedule para dia FECHADO ${reschedIsoDate} — bloqueando`);
            const _cdReschedMsg = `No dia ${formatDateLabel(reschedIsoDate)} a clínica estará fechada (feriado/recesso). 🙏 Pode escolher outra data que eu verifico os horários pra você!`;
            return { status: "needs_info", response: _cdReschedMsg, error: _cdReschedMsg, bypassAiRewrite: true } as any;
          }
        }

        // Gate de carência no reagendar — REMOVIDO (16/08).

        // FIX (Swagger 04/07): a rota e' /attendances/{id}/reschedule — o codigo
        // chamava com a ordem INVERTIDA (reschedule/{id}) e sempre 404ava.
        const rescheduleResult = await tryFetch(
          `attendances/${attId}/reschedule?company_id=${companyId}`,
          amigoToken,
          "PUT",
          { date: newDateTime },
          true,
        );
        // Fallback oficial (mesma familia do confirm — rota legada removida):
        let reschedFinal = rescheduleResult;
        if (rescheduleResult.status === 404 || rescheduleResult.status === 502) {
          const offResched = await tryFetch(
            `api/attendance/${attId}/reschedule`,
            amigoToken,
            "PUT",
            { company_id: Number(companyId), date: newDateTime },
            true,
          );
          let offSecond: { data: unknown; status: number } | null = null;
          if (!(offResched.status >= 200 && offResched.status < 300)) {
            offSecond = await tryFetch(
              `api/attendance/${attId}/update-date-time`,
              amigoToken,
              "PUT",
              { company_id: Number(companyId), date: newDateTime },
              true,
            );
          }
          console.error(
            `[Webhook] reagendar legacy FALHOU attId=${attId} — legacy=${rescheduleResult.status} body=${JSON.stringify(rescheduleResult.data).substring(0, 250)} | reschedule=${offResched.status} body=${JSON.stringify(offResched.data).substring(0, 250)}${offSecond ? ` | update-date-time=${offSecond.status} body=${JSON.stringify(offSecond.data).substring(0, 250)}` : ""}`,
          );
          if (offResched.status >= 200 && offResched.status < 300) reschedFinal = offResched;
          else if (offSecond && offSecond.status >= 200 && offSecond.status < 300) reschedFinal = offSecond;
        }
        if (reschedFinal.status >= 200 && reschedFinal.status < 300) {
          // ── DUAS PESSOAS, UM "PRONTINHO" (caso Gabriella e Eduardo, 31/08) ──────
          // 12:53 "teria como reagendar as consultas do Eduardo e minha pra semana
          //        que vem?"
          // 13:13 "293.687.918-30 Gabriella Ferretti / 281.299.598-01 Eduardo Xavier"
          // 13:20 "14:20, 14:40"                          <- DOIS horários
          // 13:21 "Prontinho! A consulta foi reagendada com sucesso para o dia
          //        08/09 às 14:20"                        <- SINGULAR
          //
          // `entities.cpf` e `entities.attendance_id` são strings ÚNICAS: o segundo
          // CPF entrou na conversa e sumiu. Só a consulta da Gabriella andou. Medido
          // ao vivo em 31/08 às 22h, com a família achando que as duas tinham
          // mudado: Gabriella 08/09 14:20, Eduardo AINDA em 02/09 08:40.
          //
          // Remarcar as duas de uma vez é mudança grande e arriscada. Parar de
          // MENTIR é pequeno e resolve o dano: quando a conversa mostra mais de um
          // CPF e só um atendimento andou, a Julia diz quem foi e quem não foi, e
          // chama gente. Falhar alto em vez de falhar baixo.
          const _cpfsNaConversa = new Set<string>();
          for (const _t of [String(currentMessageText || ""), ...(recentMessages || []).map((m: any) => String(m?.content || ""))]) {
            for (const _m of _t.matchAll(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g)) {
              const _d = _m[0].replace(/\D/g, "");
              if (isValidCpf(_d)) _cpfsNaConversa.add(_d);
            }
          }
          if (_cpfsNaConversa.size > 1) {
            const _quemAndou = String(entities.patient_full_name || "").trim();
            const _aviso =
              `Remarquei${_quemAndou ? ` a consulta de *${_quemAndou}*` : ""} para ` +
              `${entities.date}${entities.time ? " às " + entities.time : ""}. ✅\n\n` +
              `Como você pediu para mais de uma pessoa, a outra consulta ainda está na data original — ` +
              `não quero deixar você achando que mudou. 🙏 Já estou chamando uma atendente pra concluir essa aqui.`;
            console.log(`[Webhook] reagendar - ${_cpfsNaConversa.size} CPFs na conversa e só 1 atendimento remarcado — NÃO vou dizer "prontinho"`);
            return { status: "needs_info", response: _aviso, error: _aviso, bypassAiRewrite: true } as any;
          }
          return {
            status: "success",
            response: `Agendamento ${attId} reagendado para ${entities.date}${entities.time ? " às " + entities.time : ""} ✅`,
          };
        }
        return {
          status: "failed",
          response: "",
          error: "Não consegui concluir o reagendamento automaticamente. Já avisei nossa equipe pra finalizar pra você.",
        };
      }

      case "cadastrar": {
        // Registration flow - patient is responding with name and/or insurance
        console.log("[Webhook] cadastrar - entities:", JSON.stringify(entities));

        // Recover CPF from conversation history if not in current message
        // CASO CAIO MUNIZ (11/08): o CPF certo já estava no histórico (ele mandou
        // <cpf-removido> no atendimento anterior), mas a mensagem de cadastro trazia
        // "rua durvalino de souza 114 - cep 04814-360" e o extrator devolveu um CPF
        // de mentira feito desses dígitos. Como `entities.cpf` estava PREENCHIDO, a
        // recuperação nem rodava: o lixo ganhava do dado bom e o paciente levava a
        // culpa ("seu CPF parece incompleto"). Agora lixo também dispara a busca, e
        // do histórico só entra CPF que passa nos dígitos verificadores.
        let cpf = entities.cpf;
        if ((!cpf || !isValidCpf(cpf)) && senderPhone && supabaseClient) {
          const conversationForPhone = await supabaseClient
            .from("chat_conversations")
            .select("id")
            .eq("phone", senderPhone.replace(/\D/g, ""))
            .limit(1)
            .maybeSingle();

          if (conversationForPhone?.data?.id) {
            const cutoff48h2 = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            const { data: histMsgs } = await supabaseClient
              .from("webhook_messages")
              .select("ai_entities")
              .eq("conversation_id", conversationForPhone.data.id)
              .eq("direction", "incoming")
              .not("ai_entities", "is", null)
              .gte("created_at", cutoff48h2)
              .order("created_at", { ascending: false })
              .limit(15);

            for (const msg of histMsgs || []) {
              const ent = msg.ai_entities as Record<string, unknown>;
              if (ent?.cpf && isValidCpf(String(ent.cpf))) {
                console.log(
                  `[Webhook] cadastrar - Recovered CPF from history: ${String(ent.cpf).slice(0, 3)}***` +
                    (cpf ? ` (substituindo "${String(cpf).slice(0, 14)}", que não é CPF válido)` : ""),
                );
                cpf = String(ent.cpf);
                break;
              }
            }
          }
        }

        // Recover all entities from conversation history (accumulative merge)
        if (senderPhone && supabaseClient) {
          const convForHistory = await supabaseClient
            .from("chat_conversations")
            .select("id")
            .eq("phone", senderPhone.replace(/\D/g, ""))
            .limit(1)
            .maybeSingle();

          if (convForHistory?.data?.id) {
            const cutoff48hReg = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            const { data: histMsgsReg } = await supabaseClient
              .from("webhook_messages")
              .select("ai_entities")
              .eq("conversation_id", convForHistory.data.id)
              .eq("direction", "incoming")
              .not("ai_entities", "is", null)
              .gte("created_at", cutoff48hReg)
              .order("created_at", { ascending: false })
              .limit(15);

            const entityKeys = [
              "patient_full_name",
              "insurance_choice",
              "patient_address",
              "patient_birth_date",
              "doctor_name",
              "date",
              "time",
              "subspecialty",
            ] as const;
            for (const msg of histMsgsReg || []) {
              const ent = msg.ai_entities as Record<string, unknown>;
              for (const key of entityKeys) {
                if (!entities[key] && ent?.[key]) {
                  (entities as any)[key] = String(ent[key]);
                  console.log(`[Webhook] cadastrar - Recovered ${key} from history: ${ent[key]}`);
                }
              }
            }
          }
        }

        // Build schedulingContext to preserve across needs_info round-trips
        const _schedCtx: Record<string, unknown> = {};
        if (entities.doctor_name) _schedCtx.doctor_name = entities.doctor_name;
        if (entities.date) _schedCtx.date = entities.date;
        if (entities.time) _schedCtx.time = entities.time;
        if (entities.subspecialty) _schedCtx.subspecialty = entities.subspecialty;
        const _hasSchedCtx = Object.keys(_schedCtx).length > 0;

        if (!cpf) {
          return {
            status: "needs_info",
            response: "",
            error: "Para realizar o cadastro, preciso do seu CPF. Por favor, informe.",
            ...(_hasSchedCtx ? { schedulingContext: _schedCtx } : {}),
          };
        }
        // Relatorio 08/07 (caso Dayane): cadastro era disparado com CPF incompleto/
        // inválido e a API devolvia VALIDATION_ERROR 400. Valida os dígitos
        // verificadores ANTES do POST — se inválido, pede correção ao paciente.
        if (!isValidCpf(cpf)) {
          // CASO CAIO MUNIZ (11/08): NÃO ACUSE O PACIENTE DE UM CPF QUE ELE NÃO MANDOU.
          // Ele respondeu ao pedido de cadastro com nome, nascimento, convênio e
          // "rua durvalino de souza 114 - cep 04814-360". CPF, nenhum. O extrator
          // pegou dígitos do endereço/CEP e a Julia respondeu "só tive um pequeno
          // problema com o CPF que apareceu aqui: ele parece estar incompleto" —
          // reclamando de um erro que o paciente não cometeu, sobre um dado que ele
          // nunca enviou. Só trata como "CPF errado" o que o paciente ESCREVEU.
          const _cpfDigitos = String(cpf).replace(/\D/g, "");
          const _veioDoPaciente =
            _cpfDigitos.length >= 8 &&
            String(currentMessageText || "").replace(/\D/g, "").includes(_cpfDigitos);
          console.log(
            `[Webhook] cadastrar - CPF inválido ("${String(cpf).slice(0, 14)}", veioDoPaciente=${_veioDoPaciente}) — pedindo antes do POST`,
          );
          return {
            status: "needs_info",
            response: "",
            error: _veioDoPaciente
              ? "O CPF informado parece incompleto ou inválido. Pode me confirmar o número, por favor? (São 11 dígitos — pode mandar só os números.)"
              : "Para finalizar o cadastro, ainda preciso do seu CPF. Pode me enviar os 11 dígitos, por favor?",
            ...(_hasSchedCtx ? { schedulingContext: _schedCtx } : {}),
          };
        }
        if (!entities.patient_full_name) {
          return {
            status: "needs_info",
            response: "",
            error: "Por favor, informe seu nome completo para o cadastro.",
            ...(_hasSchedCtx ? { schedulingContext: _schedCtx } : {}),
          };
        }
        if (!entities.patient_birth_date) {
          return {
            status: "needs_info",
            response: "",
            error: "Por favor, informe sua *data de nascimento* para completar o cadastro.",
            ...(_hasSchedCtx ? { schedulingContext: _schedCtx } : {}),
          };
        }
        // Convert birth date
        let born = "1900-01-01";
        const birthRaw = entities.patient_birth_date.replace(/\s/g, "");
        const slashParts = birthRaw.split("/");
        if (slashParts.length === 3) {
          born = `${slashParts[2]}-${slashParts[1].padStart(2, "0")}-${slashParts[0].padStart(2, "0")}`;
        } else {
          const isoMatch = birthRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (isoMatch) {
            born = birthRaw;
          } else {
            const dashParts = birthRaw.split("-");
            if (dashParts.length === 3 && dashParts[0].length <= 2) {
              born = `${dashParts[2]}-${dashParts[1].padStart(2, "0")}-${dashParts[0].padStart(2, "0")}`;
            }
          }
        }
        console.log(`[Webhook] cadastrar - Birth date raw: "${entities.patient_birth_date}" -> born: "${born}"`);

        const cleanCpf = cpf.replace(/\D/g, "");
        const phone = senderPhone?.replace(/\D/g, "") || "";

        // Normalize function for accent-insensitive comparison
        const normalize = (s: string) =>
          s
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();

        // Lookup insurance if patient specified one
        let insuranceId: string | null = null;
        let insuranceName = "";
        if (entities.insurance_choice && normalize(entities.insurance_choice) !== "particular") {
          try {
            const insResult = await tryFetch(`insurances?company_id=${companyId}`, amigoToken);
            const insurances = normalizeApiResponse(insResult) as Array<Record<string, unknown>>;
            console.log(
              `[Webhook] cadastrar - Insurances fetched: ${Array.isArray(insurances) ? insurances.length : 0} items`,
            );
            if (Array.isArray(insurances)) {
              console.log(`[Webhook] cadastrar - Insurance names: ${insurances.map((i) => i.name).join(", ")}`);
              // Try exact number match first (e.g. "1" -> first insurance)
              const choiceNum = parseInt(entities.insurance_choice);
              let groupMatch: Record<string, unknown> | undefined;
              if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= insurances.length) {
                groupMatch = insurances[choiceNum - 1];
              } else {
                // Try accent-insensitive name match (with compact/space-stripped comparison)
                const normalizedChoice = normalize(entities.insurance_choice);
                const compactChoice = normalizedChoice.replace(/\s+/g, "");
                groupMatch = insurances.find((ins) => {
                  const normalizedName = normalize(String(ins.name || ""));
                  const compactName = normalizedName.replace(/\s+/g, "");
                  return (
                    normalizedName.includes(normalizedChoice) ||
                    normalizedChoice.includes(normalizedName) ||
                    compactName.includes(compactChoice) ||
                    compactChoice.includes(compactName)
                  );
                });
              }

              if (!groupMatch && entities.insurance_choice) {
                // No match found — ask patient to pick from list
                const insuranceNames = insurances.map((ins, idx) => `${idx + 1}. ${ins.name}`).join("\n");
                console.log(
                  `[Webhook] cadastrar - No insurance match for "${entities.insurance_choice}", asking patient to choose`,
                );
                // CASO MARISA 27/07: este era o ÚNICO return do arquivo na forma
                // `reply`/`intent`/`action_status`. O funil lê `status`/`response`/
                // `error`; sem `status` a rede de segurança normalizava para um
                // "me confirme o médico, a data e o horário" genérico e a LISTA DE
                // CONVÊNIOS — a informação que a paciente precisava — era descartada.
                // Ela respondeu médico e horário 4 vezes sem nunca saber que o
                // problema era o convênio ("NotreDame Intermedica 900" não casou).
                // Agora usa a MESMA forma dos ramos vizinhos deste case.
                return {
                  status: "needs_info",
                  response: "",
                  error: `Não encontrei o convênio *"${entities.insurance_choice}"* no sistema. Por favor, escolha um da lista abaixo (digite o número):\n\n${insuranceNames}\n\nOu digite *particular* se não tiver convênio.`,
                  entities: entities,
                  ...(_hasSchedCtx ? { schedulingContext: _schedCtx } : {}),
                };
              }

              if (groupMatch) {
                console.log(
                  `[Webhook] cadastrar - Insurance group match: id=${groupMatch.id}, name=${groupMatch.name}`,
                );
                // Fetch plans for this group to get the correct plan ID
                try {
                  const plansResult = await tryFetch(
                    `insurances/plans/${groupMatch.id}?company_id=${companyId}`,
                    amigoToken,
                  );
                  const plans = normalizeApiResponse(plansResult) as Array<Record<string, unknown>>;
                  if (Array.isArray(plans) && plans.length > 0) {
                    insuranceId = String(plans[0].id);
                    insuranceName = String(plans[0].name || "");
                    console.log(
                      `[Webhook] cadastrar - Using plan: id=${insuranceId}, name=${insuranceName} (from ${plans.length} plans)`,
                    );
                  } else {
                    // Fallback to group ID if no plans found
                    insuranceId = String(groupMatch.id);
                    insuranceName = String(groupMatch.name || "");
                    console.log(
                      `[Webhook] cadastrar - No plans found, using group: id=${insuranceId}, name=${insuranceName}`,
                    );
                  }
                } catch (planErr) {
                  console.log(`[Webhook] cadastrar - Plans fetch error, using group ID: ${planErr.message}`);
                  insuranceId = String(groupMatch.id);
                  insuranceName = String(groupMatch.name || "");
                }
              }
              console.log(`[Webhook] cadastrar - Final insurance: id=${insuranceId}, name=${insuranceName}`);
            }
          } catch (e) {
            console.log("[Webhook] cadastrar - Insurance lookup error: " + e.message);
          }
        }

        // UPSERT: Check if patient already exists by CPF before attempting to create
        let existingPatientId: string | null = null;
        let existingPatientData: Record<string, unknown> | null = null;
        try {
          const checkResult = await tryFetch(`patients/exists?cpf=${cleanCpf}&company_id=${companyId}`, amigoToken);
          if (checkResult.status >= 200 && checkResult.status < 300) {
            const checkData = normalizeApiResponse(checkResult) as Record<string, unknown>;
            if (checkData?.id || checkData?.patient_id) {
              existingPatientId = String(checkData.id || checkData.patient_id);
              existingPatientData = checkData;
              console.log(
                `[Webhook] cadastrar - CPF ${cleanCpf} already exists (patient ${existingPatientId}), will use existing`,
              );
            }
          }
        } catch (checkErr) {
          console.log("[Webhook] cadastrar - CPF check error (will try create): " + (checkErr as Error).message);
        }

        // Create patient in Amigo API (only if not already exists)
        const patientPayload: Record<string, unknown> = {
          name: entities.patient_full_name,
          born: born,
          cpf: cleanCpf,
          contact_cellphone: phone,
          company_id: Number(companyId),
        };
        if (insuranceId) {
          patientPayload.insurance_id = Number(insuranceId);
        }
        if (entities.patient_address) {
          patientPayload.address = entities.patient_address;
          console.log(`[Webhook] cadastrar - Including address: ${entities.patient_address}`);
        }

        let createResult: { data: unknown; status: number };
        if (existingPatientId) {
          // Patient exists — try to update, or just use existing
          console.log("[Webhook] cadastrar - Patient exists, attempting PUT update:", JSON.stringify(patientPayload));
          createResult = await tryFetch(
            `patients/${existingPatientId}?company_id=${companyId}`,
            amigoToken,
            "PUT",
            patientPayload,
          );
          if (createResult.status >= 200 && createResult.status < 300) {
            console.log("[Webhook] cadastrar - Patient updated successfully");
          } else {
            console.log(
              "[Webhook] cadastrar - PUT failed (non-critical), using existing patient data. Status:",
              createResult.status,
            );
            // Fake a success result with existing data so the flow continues
            createResult = { data: existingPatientData, status: 200 };
          }
        } else {
          console.log("[Webhook] cadastrar - Creating patient:", JSON.stringify(patientPayload));
          createResult = await tryFetch(`patients?company_id=${companyId}`, amigoToken, "POST", patientPayload);
        }
        console.log("[Webhook] cadastrar - Result:", JSON.stringify(createResult.data).substring(0, 500));

        if (createResult.status >= 200 && createResult.status < 300) {
          const newPatient = normalizeApiResponse(createResult) as Record<string, unknown>;
          const newPatientId = String(newPatient?.id || newPatient?.patient_id || "");

          // Save to local_patients cache
          if (supabaseClient && clinicTokenId) {
            try {
              const { data: whForCache } = await supabaseClient
                .from("user_webhooks")
                .select("user_id")
                .eq("clinic_token_id", clinicTokenId)
                .limit(1)
                .maybeSingle();
              if (whForCache?.user_id) {
                await supabaseClient.from("local_patients").upsert(
                  {
                    user_id: whForCache.user_id,
                    phone: phone,
                    cpf: cleanCpf,
                    name: entities.patient_full_name,
                    amigo_patient_id: newPatientId,
                    insurance_id: insuranceId,
                    insurance_name: insuranceName || null,
                    birth_date: born || null,
                  },
                  { onConflict: "user_id,cpf" },
                );
                console.log("[Webhook] cadastrar - Patient saved to local_patients");
              }
            } catch (cacheErr) {
              console.log("[Webhook] cadastrar - Cache save error: " + cacheErr.message);
            }
          }

          // Auto-schedule if doctor_name, date, and time are already collected
          if (entities.doctor_name && entities.date && entities.time) {
            console.log("[Webhook] cadastrar - Auto-scheduling after registration...");
            try {
              // Find doctor by name
              const docsRes = await tryFetch(`doctors?company_id=${companyId}`, amigoToken);
              const allDocs = normalizeApiResponse(docsRes) as Array<Record<string, unknown>>;
              const normSearch = (entities.doctor_name || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase();
              const docMatch =
                Array.isArray(allDocs) &&
                allDocs.find((d) =>
                  ((d.name as string) || "")
                    .normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .toLowerCase()
                    .includes(normSearch),
                );
              if (docMatch) {
                const autoDocId = String(docMatch.id);
                const autoDocName = String(docMatch.name || entities.doctor_name);
                // Fetch events and places
                const [evRes, plRes] = await Promise.all([
                  tryFetch(`events?company_id=${companyId}`, amigoToken),
                  tryFetch(`places?company_id=${companyId}`, amigoToken),
                ]);
                const evts = normalizeApiResponse(evRes) as Array<Record<string, unknown>>;
                const plcs = normalizeApiResponse(plRes) as Array<Record<string, unknown>>;
                if (Array.isArray(evts) && evts.length > 0 && Array.isArray(plcs) && plcs.length > 0) {
                  // cadastro recem-feito = paciente NOVO -> primeira consulta
                  const autoEventId = String(pickEventForBooking(evts, { newPatient: true }).id);
                  const autoPlaceId = String(plcs[0].id);
                  // BUG-1 FIX: cadastrar auto-schedule path also needs canonical date/time.
                  // Without this, entities.date may carry dd/mm/yyyy from the LLM and the
                  // Amigo API stores it in the wrong format, breaking downstream comparisons.
                  const autoIsoDate = normalizeDateToISO(entities.date) || entities.date;
                  const autoIsoTime = normalizeTimeToHHMM(entities.time) || entities.time;
                  const startDate = `${autoIsoDate} ${autoIsoTime}`;
                  const attBody: Record<string, unknown> = {
                    start_date: startDate,
                    user_id: autoDocId,
                    patient_id: newPatientId,
                    event_id: autoEventId,
                    place_id: autoPlaceId,
                    company_id: companyId,
                  };
                  if (insuranceId) {
                    attBody.insurance_id = Number(insuranceId);
                    console.log(`[Webhook] cadastrar - Including insurance_id=${insuranceId} in auto-schedule payload`);
                  }
                  // === BUG-FIX #2: validar que o slot existe na agenda antes do POST ===
                  // Sem isto, um time hallucinated pelo LLM (ex: "14:30" quando só há "14:00")
                  // seria enviado direto pra Amigo API, criando agendamento fora da grade.
                  try {
                    const calUrl = `calendar?place_id=${autoPlaceId}&event_id=${autoEventId}&user_id=${autoDocId}&company_id=${companyId}`;
                    const calRes = await tryFetch(calUrl, amigoToken);
                    const calData = normalizeApiResponse(calRes) as Array<Record<string, unknown>>;
                    const realSlots: string[] = [];
                    if (Array.isArray(calData)) {
                      for (const dayObj of calData) {
                        const dayDate = String(dayObj.date || dayObj.day || dayObj.data || "");
                        if (dayDate && dayDate !== autoIsoDate) continue;
                        const slotsByUser = (dayObj.slotsByUser || dayObj.slots_by_user) as
                          | Array<Record<string, unknown>>
                          | undefined;
                        if (slotsByUser && Array.isArray(slotsByUser)) {
                          for (const userSlots of slotsByUser) {
                            const user = userSlots.user as Record<string, unknown> | undefined;
                            const userId = user?.id || userSlots.user_id;
                            if (userId && String(userId) !== String(autoDocId)) continue;
                            const slots = (userSlots.slots || userSlots.available_slots) as
                              | Array<Record<string, unknown>>
                              | undefined;
                            if (slots && Array.isArray(slots)) {
                              for (const slot of slots) {
                                const raw = String(slot.start_time || slot.startTime || slot.time || "");
                                const m = raw.match(/(\d{2}:\d{2})/);
                                if (m) realSlots.push(m[1]);
                              }
                            }
                          }
                        }
                      }
                    }
                    const uniqueSlots = [...new Set(realSlots)].sort();
                    if (uniqueSlots.length > 0 && !uniqueSlots.includes(autoIsoTime)) {
                      console.log(
                        `[Webhook] cadastrar - ⛔ Auto-schedule abortado: ${autoIsoTime} não existe na agenda. Slots reais: [${uniqueSlots.join(",")}]`,
                      );
                      return {
                        status: "success",
                        response: JSON.stringify({
                          registered: true,
                          scheduled: false,
                          scheduling_failed: true,
                          invalid_slot: true,
                          patient_name: entities.patient_full_name,
                          insurance: insuranceName || "particular",
                          pending_doctor: autoDocName,
                          pending_date: entities.date,
                          attempted_time: entities.time,
                          available_slots: uniqueSlots,
                        }),
                        patientName: entities.patient_full_name,
                      };
                    }
                    if (uniqueSlots.length === 0) {
                      // FIX (<paciente> <telefone-removido>): o /calendar sem date param às vezes
                      // só devolve a semana corrente. Antes de dar "no_slots_in_date",
                      // refazer fetch passando start_date/end_date explícitos para o dia alvo.
                      try {
                        const retryUrl = `calendar?place_id=${autoPlaceId}&event_id=${autoEventId}&user_id=${autoDocId}&company_id=${companyId}&start_date=${autoIsoDate}&end_date=${autoIsoDate}`;
                        const retryRes = await tryFetch(retryUrl, amigoToken);
                        const retryData = normalizeApiResponse(retryRes) as Array<Record<string, unknown>>;
                        const retrySlots: string[] = [];
                        if (Array.isArray(retryData)) {
                          for (const dayObj of retryData) {
                            const dayDate = String(dayObj.date || dayObj.day || dayObj.data || "");
                            if (dayDate && dayDate !== autoIsoDate) continue;
                            const sbu = (dayObj.slotsByUser || dayObj.slots_by_user) as Array<Record<string, unknown>> | undefined;
                            if (Array.isArray(sbu)) {
                              for (const us of sbu) {
                                const u = us.user as Record<string, unknown> | undefined;
                                const uid = u?.id || us.user_id;
                                if (uid && String(uid) !== String(autoDocId)) continue;
                                const sl = (us.slots || us.available_slots) as Array<Record<string, unknown>> | undefined;
                                if (Array.isArray(sl)) {
                                  for (const s of sl) {
                                    const r = String(s.start_time || s.startTime || s.time || "");
                                    const m = r.match(/(\d{2}:\d{2})/);
                                    if (m) retrySlots.push(m[1]);
                                  }
                                }
                              }
                            }
                          }
                        }
                        const retryUnique = [...new Set(retrySlots)].sort();
                        if (retryUnique.length > 0) {
                          console.log(
                            `[Webhook] cadastrar - Retry calendar com start/end_date achou ${retryUnique.length} slots em ${autoIsoDate}: [${retryUnique.join(",")}]`,
                          );
                          if (retryUnique.includes(autoIsoTime)) {
                            console.log(`[Webhook] cadastrar - Slot ${autoIsoTime} confirmado no retry — prosseguindo com POST`);
                            // continue para o POST normalmente (fall-through)
                          } else {
                            return {
                              status: "success",
                              response: JSON.stringify({
                                registered: true,
                                scheduled: false,
                                scheduling_failed: true,
                                invalid_slot: true,
                                patient_name: entities.patient_full_name,
                                insurance: insuranceName || "particular",
                                pending_doctor: autoDocName,
                                pending_date: entities.date,
                                attempted_time: entities.time,
                                available_slots: retryUnique,
                              }),
                              patientName: entities.patient_full_name,
                            };
                          }
                        } else {
                          console.log(
                            `[Webhook] cadastrar - ⛔ Auto-schedule abortado: nenhum horário disponível em ${autoIsoDate} para doctorId=${autoDocId} (retry também vazio)`,
                          );
                          return {
                            status: "success",
                            response: JSON.stringify({
                              registered: true,
                              scheduled: false,
                              scheduling_failed: true,
                              no_slots_in_date: true,
                              patient_name: entities.patient_full_name,
                              insurance: insuranceName || "particular",
                              pending_doctor: autoDocName,
                              pending_date: entities.date,
                            }),
                            patientName: entities.patient_full_name,
                          };
                        }
                      } catch (retryErr) {
                        console.log(`[Webhook] cadastrar - Retry calendar falhou: ${(retryErr as Error).message}`);
                        return {
                          status: "success",
                          response: JSON.stringify({
                            registered: true,
                            scheduled: false,
                            scheduling_failed: true,
                            no_slots_in_date: true,
                            patient_name: entities.patient_full_name,
                            insurance: insuranceName || "particular",
                            pending_doctor: autoDocName,
                            pending_date: entities.date,
                          }),
                          patientName: entities.patient_full_name,
                        };
                      }
                    }
                    console.log(`[Webhook] cadastrar - Auto-schedule slot validation OK: ${autoIsoTime} existe`);
                  } catch (validateErr) {
                    console.log(
                      `[Webhook] cadastrar - Slot validation error (non-blocking, prosseguindo): ${(validateErr as Error).message}`,
                    );
                  }
                  // === PRE-BOOK GUARD ===
                  const _autoBookGuard = validateBookingDate(startDate, businessHoursOpts || undefined);
                  if (!_autoBookGuard.allowed) {
                    console.log(`[PreBookGuard] cadastrar auto-schedule ${_autoBookGuard.reason} — startDate=${startDate}`);
                    return {
                      status: "needs_info",
                      response: _autoBookGuard.patientMessage || "Por favor, escolha outra data.",
                      error: `[PreBookGuard] ${_autoBookGuard.reason}`,
                      verifiedSchedule: true,
                    } as any;
                  }
                  console.log("[Webhook] cadastrar - Auto-creating attendance:", JSON.stringify(attBody));
                  const attResult = await tryFetch(`attendances?company_id=${companyId}`, amigoToken, "POST", attBody);
                  if (attResult.status >= 200 && attResult.status < 300) {
                    console.log("[Webhook] cadastrar - Auto-schedule SUCCESS");
                    return {
                      status: "success",
                      response: JSON.stringify({
                        registered: true,
                        scheduled: true,
                        patient_name: entities.patient_full_name,
                        insurance: insuranceName || "particular",
                        _doctor_name: autoDocName,
                        _date: entities.date,
                        _time: entities.time,
                      }),
                      patientName: entities.patient_full_name,
                    };
                  } else {
                    console.log(
                      "[Webhook] cadastrar - Auto-schedule FAILED:",
                      JSON.stringify(attResult.data).substring(0, 300),
                    );
                  }
                }
              } else {
                console.log(
                  `[Webhook] cadastrar - No doctor match found for "${entities.doctor_name}" (normalized: "${normSearch}"). Available: ${Array.isArray(allDocs) ? allDocs.map((d: any) => d.name).join(", ") : "none"}`,
                );
              }
            } catch (autoErr) {
              console.log("[Webhook] cadastrar - Auto-schedule error: " + autoErr.message);
            }
          }

          // Registration succeeded — if doctor is known but date/time missing,
          // fetch REAL availability so the AI doesn't invent times.
          if (entities.doctor_name && !(entities.doctor_name && entities.date && entities.time)) {
            console.log(`[Webhook] cadastrar - Registered OK, doctor known (${entities.doctor_name}). Fetching real availability...`);
            try {
              const docsRes2 = await tryFetch(`doctors?company_id=${companyId}`, amigoToken);
              const allDocs2 = normalizeApiResponse(docsRes2) as Array<Record<string, unknown>>;
              const normSearch2 = (entities.doctor_name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
              const docMatch2 = Array.isArray(allDocs2) && allDocs2.find(
                (d) => ((d.name as string) || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(normSearch2)
              );
              if (docMatch2) {
                const regDocId = String(docMatch2.id);
                const regDocName = String(docMatch2.name || entities.doctor_name);
                const [evRes2, plRes2] = await Promise.all([
                  tryFetch(`events?company_id=${companyId}`, amigoToken),
                  tryFetch(`places?company_id=${companyId}`, amigoToken),
                ]);
                const evts2 = normalizeApiResponse(evRes2) as Array<Record<string, unknown>>;
                const plcs2 = normalizeApiResponse(plRes2) as Array<Record<string, unknown>>;
                if (Array.isArray(evts2) && evts2.length > 0 && Array.isArray(plcs2) && plcs2.length > 0) {
                  // cadastro recem-feito = paciente NOVO -> primeira consulta
                  const regEventId = String(pickEventForBooking(evts2, { newPatient: true }).id);
                  const regPlaceId = String(plcs2[0].id);
                  const availRes = await tryFetch(
                    `doctors/${regDocId}/available-dates?event_id=${regEventId}&place_id=${regPlaceId}&company_id=${companyId}`,
                    amigoToken
                  );
                  const availDates = normalizeApiResponse(availRes);
                  if (Array.isArray(availDates) && availDates.length > 0) {
                    const calRes = await tryFetch(
                      `calendar?place_id=${regPlaceId}&event_id=${regEventId}&user_id=${regDocId}&company_id=${companyId}`,
                      amigoToken
                    );
                    const calData = normalizeApiResponse(calRes) as Array<Record<string, unknown>>;
                    const slotsMap2 = new Map<string, string[]>();
                    if (Array.isArray(calData)) {
                      for (const dayObj of calData) {
                        const dateKey = String(dayObj.date || dayObj.day || dayObj.data || "");
                        if (!dateKey) continue;
                        const times: string[] = [];
                        const slotsByUser = (dayObj.slotsByUser || dayObj.slots_by_user || dayObj.slotsbyuser || dayObj.SlotsByUser) as Array<Record<string, unknown>> | undefined;
                        if (slotsByUser && Array.isArray(slotsByUser)) {
                          for (const userSlots of slotsByUser) {
                            const user = (userSlots.user || userSlots.User) as Record<string, unknown> | undefined;
                            const userId2 = user?.id || userSlots.user_id || userSlots.userId;
                            if (userId2 && String(userId2) !== regDocId) continue;
                            const slots = (userSlots.slots || userSlots.Slots || userSlots.available_slots) as Array<Record<string, unknown>> | undefined;
                            if (slots && Array.isArray(slots)) {
                              for (const slot of slots) {
                                const raw = String(slot.start_time || slot.startTime || slot.start || slot.time || slot.hour || slot.hora || "");
                                const m = raw.match(/(\d{2}:\d{2})/);
                                if (m) times.push(m[1]);
                              }
                            }
                          }
                        } else {
                          const directSlots = (dayObj.slots || dayObj.Slots || dayObj.available_slots) as Array<Record<string, unknown>> | undefined;
                          if (directSlots && Array.isArray(directSlots)) {
                            for (const slot of directSlots) {
                              const raw = String(slot.start_time || slot.startTime || slot.start || slot.time || slot.hour || slot.hora || "");
                              const m = raw.match(/(\d{2}:\d{2})/);
                              if (m) times.push(m[1]);
                            }
                          }
                        }
                        if (times.length > 0) slotsMap2.set(dateKey, [...new Set(times)].sort());
                      }
                    }
                    const toIso2 = (ds: string) => ds.includes("/") ? (() => { const [d, m, y] = ds.split("/"); return `${y}-${m}-${d}`; })() : ds;
                    const weekDays2 = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
                    const MAX_SLOTS2 = 10;
                    let totalSlots2 = 0;
                    const datesWithSlots2: Array<{ date: string; label: string; slots: string[] }> = [];
                    for (const dateStr of (availDates as string[])) {
                      if (totalSlots2 >= MAX_SLOTS2) break;
                      const isoD = toIso2(dateStr);
                      const ss = slotsMap2.get(isoD);
                      if (!ss || ss.length === 0) continue;
                      const taken = ss.slice(0, MAX_SLOTS2 - totalSlots2);
                      totalSlots2 += taken.length;
                      const pts = isoD.split("-").map(Number);
                      const dt = new Date(pts[0], pts[1] - 1, pts[2]);
                      datesWithSlots2.push({ date: isoD, label: `${String(pts[2]).padStart(2, "0")}/${String(pts[1]).padStart(2, "0")} (${weekDays2[dt.getDay()]})`, slots: taken });
                    }
                    if (datesWithSlots2.length > 0) {
                      const slotsMsg = datesWithSlots2.map(p => `${p.label}: ${p.slots.join(", ")}`).join("\n");
                      const regMsg = `Cadastro realizado com sucesso, ${entities.patient_full_name ? firstName(entities.patient_full_name) : ""}! Horários disponíveis com ${regDocName}:\n\n${slotsMsg}\n\nQual data e horário prefere?`;
                      console.log(`[Webhook] cadastrar - Returning real availability for ${regDocName}: ${datesWithSlots2.length} dates`);
                      return {
                        status: "needs_info",
                        response: regMsg,
                        error: regMsg,
                        patientName: entities.patient_full_name,
                      };
                    }
                  }
                }
              }
            } catch (availErr) {
              console.log("[Webhook] cadastrar - Post-registration availability fetch error (non-blocking): " + (availErr as Error).message);
            }
          }

          // Registration succeeded but scheduling may have failed
          const hasSchedulingData = !!(entities.doctor_name && entities.date && entities.time);
          return {
            status: "success",
            response: JSON.stringify({
              registered: true,
              scheduled: false,
              scheduling_failed: hasSchedulingData,
              patient_name: entities.patient_full_name,
              insurance: insuranceName || "particular",
              ...(hasSchedulingData
                ? {
                    pending_doctor: entities.doctor_name,
                    pending_date: entities.date,
                    pending_time: entities.time,
                  }
                : {}),
            }),
            patientName: entities.patient_full_name,
          };
        }

        // Check if failure is "CPF already exists" — save to local_patients anyway
        const createErrorStr = JSON.stringify(createResult.data || "").toLowerCase();
        const isCpfDuplicate =
          createErrorStr.includes("cpf") &&
          (createErrorStr.includes("existe") ||
            createErrorStr.includes("utilizado") ||
            createErrorStr.includes("already") ||
            createErrorStr.includes("duplicate"));

        if (isCpfDuplicate && amigoToken) {
          console.log(
            "[Webhook] cadastrar - CPF already exists in Amigo, attempting to fetch existing patient and save locally",
          );
          try {
            const existingResult = await tryFetch(
              `patients/exists?cpf=${cleanCpf}&company_id=${companyId}`,
              amigoToken,
            );
            const existingPatient = normalizeApiResponse(existingResult) as Record<string, unknown>;
            const existingId = String(existingPatient?.id || existingPatient?.patient_id || "");

            // Save to local_patients so future flows find this patient
            if (supabaseClient && clinicTokenId && existingId) {
              try {
                const { data: whForCache } = await supabaseClient
                  .from("user_webhooks")
                  .select("user_id")
                  .eq("clinic_token_id", clinicTokenId)
                  .limit(1)
                  .maybeSingle();
                if (whForCache?.user_id) {
                  const phone = senderPhone ? senderPhone.replace(/\D/g, "") : "";
                  await supabaseClient.from("local_patients").upsert(
                    {
                      user_id: whForCache.user_id,
                      phone: phone,
                      cpf: cleanCpf,
                      name: entities.patient_full_name || String(existingPatient?.name || ""),
                      amigo_patient_id: existingId,
                      insurance_id: insuranceId || null,
                      insurance_name: insuranceName || null,
                      birth_date: born || null,
                    },
                    { onConflict: "user_id,cpf" },
                  );
                  console.log("[Webhook] cadastrar - CPF-duplicate patient saved to local_patients");
                }
              } catch (cacheErr) {
                console.log("[Webhook] cadastrar - CPF-duplicate cache save error: " + cacheErr.message);
              }
            }

            // Check if the conversation context was infiltração — if so, return as registered
            // FIX (ReferenceError 30/06-01/07): usava `conversationHistory` fora de
            // escopo (o parametro e' recentMessages) — crash no cadastro CPF-duplicado.
            // O intent vem embutido no comentario <!-- intent=X --> do content.
            const prevIntents = (recentMessages || [])
              .map((m: any) => m.ai_intent || (typeof m.content === "string" ? m.content.match(/<!--\s*intent=(\w+)/)?.[1] : null))
              .filter(Boolean);
            const hadInfiltracao = prevIntents.includes("solicitar_infiltracao");

            if (hadInfiltracao) {
              console.log(
                "[Webhook] cadastrar - CPF-duplicate + infiltração context → returning as registered for transfer",
              );
              // Auto-schedule if scheduling context exists
              // NUNCA auto-agenda em contexto de infiltração (regra do dono, 28/07).
              // Este ramo é alcançado JUSTAMENTE quando hadInfiltracao é true, e ele
              // chegava a fazer o POST da attendance ("CPF duplicado = paciente já
              // existente -> consulta normal"). Marcar uma consulta para quem veio
              // fazer infiltração é exatamente o que não pode acontecer: a documentação
              // e o dia da infiltração são responsabilidade de uma atendente.
              const AUTO_AGENDAR_EM_INFILTRACAO = false;
              if (AUTO_AGENDAR_EM_INFILTRACAO && entities.doctor_name && entities.date && entities.time && existingId) {
                console.log("[Webhook] cadastrar - CPF-duplicate, attempting auto-schedule...");
                try {
                  const docsRes = await tryFetch(`doctors?company_id=${companyId}`, amigoToken);
                  const allDocs = normalizeApiResponse(docsRes) as Array<Record<string, unknown>>;
                  const normSearch = (entities.doctor_name || "")
                    .normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .toLowerCase();
                  const docMatch =
                    Array.isArray(allDocs) &&
                    allDocs.find((d) =>
                      ((d.name as string) || "")
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, "")
                        .toLowerCase()
                        .includes(normSearch),
                    );
                  if (docMatch) {
                    const [evRes, plRes] = await Promise.all([
                      tryFetch(`events?company_id=${companyId}`, amigoToken),
                      tryFetch(`places?company_id=${companyId}`, amigoToken),
                    ]);
                    const evts = normalizeApiResponse(evRes) as Array<Record<string, unknown>>;
                    const plcs = normalizeApiResponse(plRes) as Array<Record<string, unknown>>;
                    if (Array.isArray(evts) && evts.length > 0 && Array.isArray(plcs) && plcs.length > 0) {
                      // BUG-1 FIX: same canonical normalization as the new-patient auto-schedule path
                      const dupIsoDate = normalizeDateToISO(entities.date) || entities.date;
                      const dupIsoTime = normalizeTimeToHHMM(entities.time) || entities.time;
                      const attBody: Record<string, unknown> = {
                        start_date: `${dupIsoDate} ${dupIsoTime}`,
                        user_id: String(docMatch.id),
                        patient_id: existingId,
                        // CPF duplicado = paciente ja existente -> consulta normal
                        event_id: String(pickEventForBooking(evts).id),
                        place_id: String(plcs[0].id),
                        company_id: companyId,
                      };
                      if (insuranceId) {
                        attBody.insurance_id = Number(insuranceId);
                        console.log(
                          `[Webhook] cadastrar - CPF-dup: Including insurance_id=${insuranceId} in auto-schedule payload`,
                        );
                      }
                      // === BUG-FIX #2 (CPF-dup path): validar slot antes do POST ===
                      try {
                        const dupDocId = String(docMatch.id);
                        const dupEventId = String(pickEventForBooking(evts).id);
                        const dupPlaceId = String(plcs[0].id);
                        const calUrl = `calendar?place_id=${dupPlaceId}&event_id=${dupEventId}&user_id=${dupDocId}&company_id=${companyId}`;
                        const calRes = await tryFetch(calUrl, amigoToken);
                        const calData = normalizeApiResponse(calRes) as Array<Record<string, unknown>>;
                        const realSlots: string[] = [];
                        if (Array.isArray(calData)) {
                          for (const dayObj of calData) {
                            const dayDate = String(dayObj.date || dayObj.day || dayObj.data || "");
                            if (dayDate && dayDate !== dupIsoDate) continue;
                            const slotsByUser = (dayObj.slotsByUser || dayObj.slots_by_user) as
                              | Array<Record<string, unknown>>
                              | undefined;
                            if (slotsByUser && Array.isArray(slotsByUser)) {
                              for (const userSlots of slotsByUser) {
                                const user = userSlots.user as Record<string, unknown> | undefined;
                                const userId = user?.id || userSlots.user_id;
                                if (userId && String(userId) !== dupDocId) continue;
                                const slots = (userSlots.slots || userSlots.available_slots) as
                                  | Array<Record<string, unknown>>
                                  | undefined;
                                if (slots && Array.isArray(slots)) {
                                  for (const slot of slots) {
                                    const raw = String(slot.start_time || slot.startTime || slot.time || "");
                                    const m = raw.match(/(\d{2}:\d{2})/);
                                    if (m) realSlots.push(m[1]);
                                  }
                                }
                              }
                            }
                          }
                        }
                        const uniqueSlots = [...new Set(realSlots)].sort();
                        if (uniqueSlots.length > 0 && !uniqueSlots.includes(dupIsoTime)) {
                          console.log(
                            `[Webhook] cadastrar - ⛔ CPF-dup auto-schedule abortado: ${dupIsoTime} não existe na agenda. Slots reais: [${uniqueSlots.join(",")}]`,
                          );
                          return {
                            status: "success",
                            response: JSON.stringify({
                              registered: true,
                              already_existed: true,
                              scheduled: false,
                              scheduling_failed: true,
                              invalid_slot: true,
                              patient_name: entities.patient_full_name || String(existingPatient?.name || ""),
                              insurance: insuranceName || "particular",
                              pending_doctor: String(docMatch.name || entities.doctor_name),
                              pending_date: entities.date,
                              attempted_time: entities.time,
                              available_slots: uniqueSlots,
                            }),
                            patientName: entities.patient_full_name || String(existingPatient?.name || ""),
                          };
                        }
                        if (uniqueSlots.length === 0) {
                          console.log(
                            `[Webhook] cadastrar - ⛔ CPF-dup auto-schedule abortado: nenhum horário em ${dupIsoDate}`,
                          );
                          return {
                            status: "success",
                            response: JSON.stringify({
                              registered: true,
                              already_existed: true,
                              scheduled: false,
                              scheduling_failed: true,
                              no_slots_in_date: true,
                              patient_name: entities.patient_full_name || String(existingPatient?.name || ""),
                              insurance: insuranceName || "particular",
                              pending_doctor: String(docMatch.name || entities.doctor_name),
                              pending_date: entities.date,
                            }),
                            patientName: entities.patient_full_name || String(existingPatient?.name || ""),
                          };
                        }
                        console.log(
                          `[Webhook] cadastrar - CPF-dup slot validation OK: ${dupIsoTime} existe`,
                        );
                      } catch (validateErr) {
                        console.log(
                          `[Webhook] cadastrar - CPF-dup slot validation error (non-blocking): ${(validateErr as Error).message}`,
                        );
                      }
                      // === PRE-BOOK GUARD (CPF-dup path) ===
                      const _dupBookGuard = validateBookingDate(`${dupIsoDate} ${dupIsoTime}`, businessHoursOpts || undefined);
                      if (!_dupBookGuard.allowed) {
                        console.log(`[PreBookGuard] cadastrar CPF-dup ${_dupBookGuard.reason} — startDate=${dupIsoDate} ${dupIsoTime}`);
                        return {
                          status: "needs_info",
                          response: _dupBookGuard.patientMessage || "Por favor, escolha outra data.",
                          error: `[PreBookGuard] ${_dupBookGuard.reason}`,
                          verifiedSchedule: true,
                        } as any;
                      }
                      const attResult = await tryFetch(
                        `attendances?company_id=${companyId}`,
                        amigoToken,
                        "POST",
                        attBody,
                      );
                      if (attResult.status >= 200 && attResult.status < 300) {
                        console.log("[Webhook] cadastrar - CPF-duplicate auto-schedule SUCCESS");
                        return {
                          status: "success",
                          response: JSON.stringify({
                            registered: true,
                            already_existed: true,
                            scheduled: true,
                            patient_name: entities.patient_full_name || String(existingPatient?.name || ""),
                            insurance: insuranceName || "particular",
                            _doctor_name: String(docMatch.name || entities.doctor_name),
                            _date: entities.date,
                            _time: entities.time,
                          }),
                          patientName: entities.patient_full_name || String(existingPatient?.name || ""),
                        };
                      }
                      console.log(
                        "[Webhook] cadastrar - CPF-duplicate auto-schedule FAILED:",
                        JSON.stringify(attResult.data).substring(0, 300),
                      );
                    }
                  }
                } catch (autoErr) {
                  console.log("[Webhook] cadastrar - CPF-duplicate auto-schedule error: " + autoErr.message);
                }
              }

              return {
                status: "success",
                response: JSON.stringify({
                  registered: true,
                  already_existed: true,
                  patient_name: entities.patient_full_name || String(existingPatient?.name || ""),
                  insurance: insuranceName || "particular",
                }),
                patientName: entities.patient_full_name || String(existingPatient?.name || ""),
              };
            }

            return {
              status: "success",
              response: JSON.stringify({
                registered: true,
                already_existed: true,
                patient_name: entities.patient_full_name || String(existingPatient?.name || ""),
                insurance: insuranceName || "particular",
              }),
              patientName: entities.patient_full_name || String(existingPatient?.name || ""),
            };
          } catch (fetchErr) {
            console.log("[Webhook] cadastrar - CPF-duplicate fetch error: " + fetchErr.message);
          }
        }

        return {
          status: "failed",
          response: "",
          error: `Erro ao cadastrar paciente: ${JSON.stringify(createResult.data)}`,
          ...(_hasSchedCtx ? { schedulingContext: _schedCtx } : {}),
        };
      }

      case "consultar_convenios": {
        const insResult = await tryFetch(`insurances?company_id=${companyId}`, amigoToken);
        const insurances = normalizeApiResponse(insResult) as Array<Record<string, unknown>>;
        if (Array.isArray(insurances) && insurances.length > 0) {
          const list = insurances.map((ins, i) => `${i + 1}. ${ins.name}`).join("\n");
          return { status: "success", response: list };
        }
        return { status: "failed", response: "", error: "Não foi possível consultar os convênios no momento." };
      }

      case "consultar_endereco": {
        // Fetch clinic_info for address + google maps link
        if (!supabaseClient || !clinicTokenId) {
          return { status: "failed", response: "", error: "Informações da clínica não disponíveis." };
        }

        const { data: clinicInfo } = await supabaseClient
          .from("clinic_info")
          .select("address, google_maps_link, clinic_description")
          .eq("clinic_token_id", clinicTokenId)
          .maybeSingle();

        if (!clinicInfo || !clinicInfo.address) {
          return {
            status: "failed",
            response: "",
            error: "O endereço da clínica ainda não foi cadastrado nas configurações.",
          };
        }

        let addressResponse = `📍 Nosso endereço: ${clinicInfo.address}`;
        if (clinicInfo.google_maps_link) {
          addressResponse += `\n\n📌 Veja no mapa: ${clinicInfo.google_maps_link}`;
        }

        return { status: "success", response: addressResponse };
      }

      case "listar_medicos": {
        // Fetch all doctors from Amigo API
        const docsResult = await tryFetch(`doctors?company_id=${companyId}`, amigoToken);
        const allDocs = normalizeApiResponse(docsResult) as Array<Record<string, unknown>>;

        if (!Array.isArray(allDocs) || allDocs.length === 0) {
          return { status: "failed", response: "", error: "Não foi possível obter a lista de médicos no momento." };
        }

        // Filter by doctor_settings (exclusion logic)
        let listDoctors = allDocs;
        const subMap = new Map<string, string>();
        // Médicos "específicos demais" para receber encaixe geral (regra do dono
        // 11/08). O dado mora em doctor_settings.general_fallback, editável.
        const semEncaixeGeral = new Set<string>();

        if (supabaseClient && clinicTokenId) {
          const { data: dsData } = await supabaseClient
            .from("doctor_settings")
            .select("doctor_id, doctor_name, is_schedulable, subspecialty, general_fallback")
            .eq("clinic_token_id", clinicTokenId);

          if (dsData && dsData.length > 0) {
            const disabledSet = new Set(
              dsData.filter((ds: any) => ds.is_schedulable === false).map((ds: any) => String(ds.doctor_id)),
            );
            listDoctors = listDoctors.filter((d) => !disabledSet.has(String(d.id)));

            for (const ds of dsData) {
              if (ds.subspecialty) {
                subMap.set(String(ds.doctor_id), ds.subspecialty as string);
              }
              if (ds.general_fallback === false) semEncaixeGeral.add(String(ds.doctor_id));
            }
          }
        }

        // === PERGUNTA SOBRE MÉDICO ESPECÍFICO (bug Vinicius 07/07) ===
        // "vocês têm o Dr. Vinicius?" / "atende com o Vinicius?" cai aqui em
        // listar_medicos, mas este handler só filtrava por subespecialidade — NUNCA por
        // nome. Resolve o nome e responde de forma honesta: atende / existe mas sem
        // agenda online / não localizado. Sem isso a Julia despejava a lista inteira,
        // pedia CPF ou ficava genérica.
        if (entities.doctor_name && String(entities.doctor_name).trim().length >= 2) {
          const _norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
          const _words = _norm(String(entities.doctor_name).replace(/\b(dr|dra|doutor|doutora|sr|sra)\.?\b/gi, " "))
            .split(/\s+/)
            .filter((w) => w.length >= 2);
          if (_words.length > 0) {
            const _match = (arr: Array<Record<string, unknown>>) =>
              arr.filter((d) => {
                const fn = _norm(String((d as any).name || ""));
                return _words.every((w) => fn.includes(w));
              });
            const _schedMatches = _match(listDoctors);
            if (_schedMatches.length === 1) {
              const d = _schedMatches[0] as any;
              const sub = subMap.get(String(d.id));
              return {
                status: "success",
                response: `Sim! O(A) *${d.name}*${sub ? ` (${sub})` : ""} atende aqui na clínica. 😊 Quer que eu veja os horários disponíveis para agendar?`,
              } as any;
            }
            if (_schedMatches.length > 1) {
              return {
                status: "success",
                response: `Temos mais de um profissional com esse nome: ${_schedMatches.map((d: any) => d.name).join(", ")}. Com qual deles você gostaria de agendar?`,
              } as any;
            }
            const _allMatches = _match(allDocs);
            if (_allMatches.length >= 1) {
              return {
                status: "success",
                response: `O(A) ${(_allMatches[0] as any).name} faz parte da nossa equipe, mas no momento não está com agenda aberta para marcação por aqui. Posso te ajudar com outro especialista? 🙏`,
              } as any;
            }
            // Médico não existe na clínica (ex: saiu — caso Vinicius 07/07). NÃO deixar
            // sem resposta: diz que não atende e REDIRECIONA para outro especialista,
            // pedindo a área (o fluxo de subespecialidade cuida do "coluna", etc).
            return {
              status: "success",
              response: `O(A) "${entities.doctor_name}" não faz parte da nossa equipe atual. 🙏 Mas temos outros ótimos especialistas que podem te atender! Me diga qual área você precisa (coluna, joelho, ombro, quadril, pé e tornozelo, mão...) que eu te indico o profissional certo. 😊`,
            } as any;
          }
        }

        // Filter by subspecialty if provided
        if (entities.subspecialty) {
          const subFilter = entities.subspecialty.toLowerCase();
          const filtered = listDoctors.filter((d) => {
            const sub = subMap.get(String(d.id));
            return sub && sub.toLowerCase().includes(subFilter);
          });
          if (filtered.length > 0) {
            listDoctors = filtered;
            console.log(
              `[Webhook] listar_medicos - Filtered by subspecialty "${entities.subspecialty}": ${filtered.length} doctors`,
            );

            // When exactly 1 doctor matches, auto-fetch available dates
            if (filtered.length === 1) {
              const singleDoc = filtered[0];
              const singleDocId = String(singleDoc.id);
              const singleDocName = (singleDoc.name as string) || "";
              const singleDocSub = subMap.get(singleDocId);
              console.log(
                `[Webhook] listar_medicos - Single match, fetching dates for ${singleDocName} (${singleDocId})`,
              );

              try {
                // Fetch events and places
                const [evResult, plResult] = await Promise.all([
                  tryFetch(`events?company_id=${companyId}`, amigoToken),
                  tryFetch(`places?company_id=${companyId}`, amigoToken),
                ]);
                const evts = normalizeApiResponse(evResult) as Array<Record<string, unknown>>;
                const pls = normalizeApiResponse(plResult) as Array<Record<string, unknown>>;

                if (Array.isArray(evts) && evts.length > 0 && Array.isArray(pls) && pls.length > 0) {
                  const evId = String(pickEventForBooking(evts).id);
                  const plId = String(pls[0].id);

                  // Fetch available dates
                  const availUrl = `doctors/${singleDocId}/available-dates?event_id=${evId}&place_id=${plId}&company_id=${companyId}`;
                  const availResult = await tryFetch(availUrl, amigoToken);
                  const availDates = normalizeApiResponse(availResult);

                  if (Array.isArray(availDates) && availDates.length > 0) {
                    // Fetch calendar for slots
                    const calUrl = `calendar?place_id=${plId}&event_id=${evId}&user_id=${singleDocId}&company_id=${companyId}`;
                    const calResult = await tryFetch(calUrl, amigoToken);
                    const calData = normalizeApiResponse(calResult) as Array<Record<string, unknown>>;

                    // Build slotsMap
                    const slotsMap = new Map<string, string[]>();
                    if (Array.isArray(calData)) {
                      for (const dayObj of calData) {
                        const dateKey = String(dayObj.date || dayObj.day || dayObj.data || "");
                        if (!dateKey) continue;
                        const times: string[] = [];
                        const slotsByUser = (dayObj.slotsByUser ||
                          dayObj.slots_by_user ||
                          dayObj.slotsbyuser ||
                          dayObj.SlotsByUser) as Array<Record<string, unknown>> | undefined;
                        if (slotsByUser && Array.isArray(slotsByUser)) {
                          for (const userSlots of slotsByUser) {
                            const user = (userSlots.user || userSlots.User) as Record<string, unknown> | undefined;
                            const userId =
                              user?.id || user?.user_id || user?.Id || userSlots.user_id || userSlots.userId;
                            if (userId && String(userId) !== String(singleDocId)) continue;
                            const slots = (userSlots.slots || userSlots.Slots || userSlots.available_slots) as
                              | Array<Record<string, unknown>>
                              | undefined;
                            if (slots && Array.isArray(slots)) {
                              for (const slot of slots) {
                                const raw = String(
                                  slot.start_time ||
                                    slot.startTime ||
                                    slot.start ||
                                    slot.time ||
                                    slot.hour ||
                                    slot.hora ||
                                    "",
                                );
                                const m = raw.match(/(\d{2}:\d{2})/);
                                if (m) times.push(m[1]);
                              }
                            }
                          }
                        }
                        if (times.length > 0) slotsMap.set(dateKey, [...new Set(times)].sort());
                      }
                    }

                    // Build response with first 2 dates
                    const weekDays = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
                    const fmtDate = (ds: string) => {
                      const p = ds.split("-").map(Number);
                      const dt = new Date(p[0], p[1] - 1, p[2]);
                      return `${String(p[2]).padStart(2, "0")}/${String(p[1]).padStart(2, "0")} (${weekDays[dt.getDay()]})`;
                    };
                    const toIso = (ds: string) =>
                      ds.includes("/")
                        ? (() => {
                            const [d2, m2, y2] = ds.split("/");
                            return `${y2}-${m2}-${d2}`;
                          })()
                        : ds;

                    const availIso = (availDates as string[]).map(toIso);
                    const MAX_SLOTS = 10;
                    let totalSlots = 0;
                    const datesWithSlots: Array<{ label: string; slots: string[] }> = [];
                    for (const d of availIso) {
                      if (!slotsMap.has(d) || totalSlots >= MAX_SLOTS) continue;
                      const sl = slotsMap.get(d)!;
                      if (sl.length === 0) continue;
                      const remaining = MAX_SLOTS - totalSlots;
                      const taken = sl.slice(0, remaining);
                      totalSlots += taken.length;
                      datesWithSlots.push({ label: fmtDate(d), slots: taken });
                    }

                    if (datesWithSlots.length > 0) {
                      const docLabel = `${singleDocName}${singleDocSub ? ` (${singleDocSub})` : ""}`;
                      const header = `Especialista encontrado: ${docLabel}\n\nPróximos horários disponíveis:\n\n`;
                      const body = datesWithSlots.map((p) => `${p.label}: ${p.slots.join(", ")}`).join("\n");
                      const footer = "\n\nGostaria de agendar? Se sim, qual data e horário prefere?";
                      console.log(
                        `[Webhook] listar_medicos - Returning single doctor with ${datesWithSlots.length} dates`,
                      );
                      return { status: "success", response: header + body + footer };
                    }
                  }
                }
              } catch (e) {
                console.log(`[Webhook] listar_medicos - Failed to fetch dates for single doctor: ${e.message}`);
              }
            }
          } else {
            // ENCAIXE GERAL (regra do dono 11/08): "da coluna ou qualquer área que
            // não tiver vaga, a busca seria para algum médico que esteja livre mais
            // cedo, então somente médico geral — todos menos Luiz Gustavo e Hugo,
            // que são mais específicos". Antes este ramo devolvia a lista INTEIRA,
            // e foi assim que uma dor no trapézio virou oferta de outro médico
            // qualquer (caso 10/08).
            const _geral = listDoctors.filter((d) => !semEncaixeGeral.has(String(d.id)));
            console.log(
              `[Webhook] listar_medicos - Nenhum médico casou "${entities.subspecialty}" — encaixe geral com ${_geral.length} de ${listDoctors.length}`,
            );
            if (_geral.length > 0) listDoctors = _geral;
          }
        }

        if (listDoctors.length === 0) {
          return { status: "failed", response: "", error: "Não há médicos disponíveis para agendamento no momento." };
        }

        // Format list with subspecialties
        const formatted = listDoctors
          .map((d, i) => {
            const sub = subMap.get(String(d.id));
            return `${i + 1}. ${d.name}${sub ? ` (${sub})` : ""}`;
          })
          .join("\n");

        console.log(`[Webhook] listar_medicos - ${listDoctors.length} schedulable doctors returned`);
        return { status: "success", response: formatted };
      }

      case "identificar_por_nome": {
        // Name is now used only for conversational context — no system search.
        // Formal identification is done via CPF only.
        const patientName = entities.patient_full_name || "";
        console.log(`[Webhook] identificar_por_nome - Name received for context only (no search): "${patientName}"`);
        return {
          status: "success",
          response: "",
          error: "",
          patientName: patientName,
        };
      }

      case "falar_com_atendente": {
        // === DIA FECHADO (feriado/emenda — 10/07) ===
        // A equipe não está na clínica: avisa 1x (com a data de volta) e oferece a IA.
        // Se o paciente insistir (2ª vez, marcador "equipe volta em" na outgoing
        // recente), transfere normalmente — o ticket fica na fila para o retorno.
        {
          const _cdHandoff = await getClosedDayInfo(supabaseClient, clinicTokenId);
          if (_cdHandoff.closedToday && _cdHandoff.reopenISO && supabaseClient && conversationIdParam) {
            let _cdWarned = false;
            try {
              const _since10cd = new Date(Date.now() - 10 * 60 * 1000).toISOString();
              const { data: _cdOut } = await supabaseClient
                .from("webhook_messages")
                .select("message_text")
                .eq("conversation_id", conversationIdParam)
                .eq("direction", "outgoing")
                .gte("created_at", _since10cd)
                .order("created_at", { ascending: false })
                .limit(3);
              _cdWarned = (_cdOut || []).some((m: any) => String(m.message_text || "").includes("equipe volta em"));
            } catch { /* non-blocking */ }
            if (!_cdWarned) {
              console.log("[ClosedDays] falar_com_atendente em dia fechado — avisando antes de transferir");
              const _cdMsg = buildClosedDayHandoffMessage(_cdHandoff.reason, _cdHandoff.reopenISO);
              return { status: "needs_info", response: _cdMsg, error: _cdMsg, bypassAiRewrite: true } as any;
            }
            // Insistiu/aceitou registrar: transferência DIRETA para a fila geral —
            // em dia fechado TODOS estão offline, então a seleção de atendente online
            // adiante falharia com "nenhum atendente disponível" SEM transferir nada
            // (gap visto no teste do usuário 10/07). O ticket fica na fila do retorno.
            console.log("[ClosedDays] paciente confirmou registro em dia fechado — abrindo ticket na fila do retorno");
            let _cdQueued = false;
            if (avanceaiConfig && senderPhone && !isTestMode) {
              let _cdFp = senderPhone.replace(/\D/g, "");
              if (!_cdFp.startsWith("55")) _cdFp = "55" + _cdFp;
              try {
                const _cdTr = await transferTicketToHuman({
                  baseUrl: avanceaiConfig.baseUrl,
                  apiId: avanceaiConfig.apiId,
                  bearerToken: avanceaiConfig.bearerToken,
                  phone: _cdFp,
                  channelId,
                });
                _cdQueued = _cdTr.ok;
              } catch (e) {
                console.error(`[ClosedDays] transfer-to-queue failed: ${(e as Error).message}`);
              }
            }
            const _cdDone = _cdQueued
              ? `Prontinho! ✅ Deixei sua solicitação registrada para a equipe. Como hoje estamos fechados${_cdHandoff.reason ? ` (${_cdHandoff.reason})` : ""}, te respondem assim que voltarmos, em ${formatDateLabel(_cdHandoff.reopenISO)}. Se precisar de algo enquanto isso, estou por aqui! 😊`
              : `Anotei sua solicitação, mas tive um problema para registrá-la na fila agora. 🙏 Nossa equipe volta em ${formatDateLabel(_cdHandoff.reopenISO)} — se preferir, me diga o que você precisa que eu tento resolver por aqui!`;
            return {
              status: _cdQueued ? "transferred_closed_day" : "failed",
              response: _cdDone,
              error: _cdDone,
              bypassAiRewrite: true,
            } as any;
          }
        }

        // === GUARDA DE FIM DE DIA (07/07 — caso <telefone-removido>) ===
        // Perto/depois do encerramento do atendimento humano (~18h), NÃO transfere direto
        // para um balcão vazio: avisa que pode não dar tempo hoje e oferece continuar com
        // a IA. Se o paciente insistir no humano (2ª vez, já avisado), transfere normal.
        {
          const _sp = getNowSPParts();
          const _closeH = businessHoursOpts?.businessCloseHour ?? 18;
          const _lateMsg = buildLateHandoffMessage(_sp.hour, _sp.minute, _closeH);
          if (_lateMsg && supabaseClient && conversationIdParam) {
            let _alreadyWarned = false;
            try {
              const _since10 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
              const { data: _lastOut } = await supabaseClient
                .from("webhook_messages")
                .select("message_text")
                .eq("conversation_id", conversationIdParam)
                .eq("direction", "outgoing")
                .gte("created_at", _since10)
                .order("created_at", { ascending: false })
                .limit(3);
              // marcador: a própria mensagem de aviso contém "encerra às"
              _alreadyWarned = (_lastOut || []).some((m: any) =>
                String(m.message_text || "").includes("encerra às"),
              );
            } catch { /* non-blocking */ }
            if (!_alreadyWarned) {
              console.log("[Webhook] falar_com_atendente - fim de dia: avisando antes de transferir");
              return { status: "needs_info", response: _lateMsg, error: _lateMsg, bypassAiRewrite: true } as any;
            }
            console.log("[Webhook] falar_com_atendente - fim de dia: paciente confirmou humano — transferindo");
          }
        }

        // Transfer chat to a human attendant via AvanceAI
        if (!avanceaiConfig) {
          return {
            status: "failed",
            response: "",
            error: "Configuração do AvanceAI não disponível para transferência.",
          };
        }

        const { baseUrl, apiId, bearerToken } = avanceaiConfig;

        // Step 1: List available attendants
        try {
          const listUsersUrl = `${baseUrl}/v2/api/external/${apiId}/listUsers`;
          console.log(`[Webhook] falar_com_atendente - Fetching users from: ${listUsersUrl}`);
          const usersRes = await fetch(listUsersUrl, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${bearerToken}`,
              "Content-Type": "application/json",
            },
          });

          if (!usersRes.ok) {
            const errText = await usersRes.text();
            console.error(`[Webhook] falar_com_atendente - listUsers failed: ${usersRes.status} - ${errText}`);
            return {
              status: "failed",
              response: "",
              error: "Não foi possível buscar os atendentes disponíveis no momento.",
            };
          }

          const usersData = await usersRes.json();
          // Extract user list (handle various response formats)
          let users: Array<{ id: number; name: string; email?: string }> = [];
          if (Array.isArray(usersData)) {
            users = usersData;
          } else if (usersData?.users && Array.isArray(usersData.users)) {
            users = usersData.users;
          } else if (usersData?.data && Array.isArray(usersData.data)) {
            users = usersData.data;
          }

          console.log(`[Webhook] falar_com_atendente - Raw users from API: ${users.length}`);

          // Filter out admin profiles - they should not receive patient chats
          users = users.filter((u: any) => {
            const profile = (u.profile || u.role || "").toLowerCase();
            return profile !== "admin";
          });

          // Filter out users disabled/inactive in AvanceAI (Mardila desabilitada no Z-PRO etc.)
          users = users.filter((u: any) => {
            if (u.active === false) return false;
            if (u.enabled === false) return false;
            if (u.disabled === true) return false;
            if (u.deletedAt) return false;
            const st = String(u.status || "").toLowerCase();
            if (st === "disabled" || st === "inactive" || st === "blocked") return false;
            return true;
          });

          // Filter out attendants marked as on vacation in custom_notes
          const vacationNames = await nomesForaDoRodizio(supabaseClient, clinicTokenId, customNotes);
          if (vacationNames.length > 0) {
            const before = users.length;
            users = users.filter((u: any) => {
              const n = stripAccents(String(u.name || "").toLowerCase().trim());
              return !vacationNames.some((v) => n === v || n.includes(v) || v.includes(n));
            });
            console.log(`[Webhook] falar_com_atendente - Vacation filter removed ${before - users.length} (list=${vacationNames.join(",")})`);
          }
          console.log(`[Webhook] falar_com_atendente - After admin/disabled/vacation filter: ${users.length} users`);

          // Save full list before offline filter (for offline detection)
          const allUsersBeforeOfflineFilter = [...users];

          // Filter out offline users
          users = users.filter((u: any) => {
            if (u.online === false) return false;
            if (typeof u.status === "string" && u.status.toLowerCase() === "offline") return false;
            return true;
          });
          console.log(`[Webhook] falar_com_atendente - After offline filter: ${users.length} users`);


          if (users.length === 0) {
            // Gap do teste 10/07: desistir aqui deixava o paciente com uma promessa
            // falsa ("vou chamar alguém") e NENHUM ticket na fila. Agora: abre o
            // ticket na fila GERAL (sem dono) — a equipe vê assim que alguém logar —
            // e responde a verdade ao paciente.
            console.log("[Webhook] falar_com_atendente - 0 atendentes ONLINE — registrando ticket na fila geral");
            let _qOk = false;
            if (!isTestMode && senderPhone) {
              let _qFp = senderPhone.replace(/\D/g, "");
              if (!_qFp.startsWith("55")) _qFp = "55" + _qFp;
              try {
                const _qTr = await transferTicketToHuman({ baseUrl, apiId, bearerToken, phone: _qFp, channelId });
                _qOk = _qTr.ok;
              } catch (e) {
                console.error(`[Webhook] falar_com_atendente - queue transfer failed: ${(e as Error).message}`);
              }
            }
            const _qMsg = _qOk
              ? "Nossa equipe não está online neste momento, mas deixei sua solicitação registrada na fila de atendimento. ✅ Assim que alguém entrar, te respondem por aqui. Enquanto isso, se eu puder ajudar com agendamento ou dúvidas, é só me falar! 😊"
              : "Nossa equipe não está online neste momento e não consegui registrar sua solicitação na fila. 🙏 Pode tentar de novo em instantes — ou me dizer o que você precisa, que eu tento resolver por aqui!";
            return {
              status: _qOk ? "transferred_queue" : "failed",
              response: _qMsg,
              error: _qMsg,
              bypassAiRewrite: true,
            } as any;
          }

          // Step 2: Check routing rules first, then patient preference
          let requestedName = entities.attendant_name
            ? stripAccents(entities.attendant_name.trim().toLowerCase())
            : undefined;
          let selectedUser: { id: number; name: string } | null = null;
          let routingRuleMatched = false;

          // Check routing rules against conversation - prioritize current message
          if (!requestedName && routingRules && routingRules.length > 0) {
            const complaintText = (entities.complaint || "").toLowerCase();
            // Step 1: Try matching on current message (last user message) + complaint only
            const currentMsg =
              recentMessages && recentMessages.length > 0
                ? recentMessages
                    .filter((m) => m.role === "user")
                    .slice(-1)
                    .map((m) => m.content)
                    .join(" ")
                    .toLowerCase()
                : "";
            const currentSearchText = stripAccents(`${currentMessageText || ""} ${currentMsg} ${complaintText}`);

            for (const rule of routingRules) {
              const keyword = stripAccents((rule.keyword || "").toLowerCase().trim());
              if (keyword && flexKeywordMatch(currentSearchText, keyword)) {
                console.log(
                  `[Webhook] falar_com_atendente - Routing rule matched (current msg): keyword="${rule.keyword}" → target="${rule.target_user}"`,
                );
                requestedName = rule.target_user.trim().toLowerCase();
                routingRuleMatched = true;
                break;
              }
            }

            // Step 2: If no match on current message, expand to last 5 messages
            if (!requestedName && recentMessages && recentMessages.length > 0) {
              const recentText = recentMessages
                .slice(-5)
                .map((m) => m.content)
                .join(" ")
                .toLowerCase();
              const fullSearchText = stripAccents(`${recentText} ${complaintText}`);

              for (const rule of routingRules) {
                const keyword = stripAccents((rule.keyword || "").toLowerCase().trim());
                if (keyword && flexKeywordMatch(fullSearchText, keyword)) {
                  console.log(
                    `[Webhook] falar_com_atendente - Routing rule matched (history): keyword="${rule.keyword}" → target="${rule.target_user}"`,
                  );
                  requestedName = rule.target_user.trim().toLowerCase();
                  routingRuleMatched = true;
                  break;
                }
              }
            }
          }

          if (requestedName) {
            // Try exact match first, then fuzzy match
            selectedUser = users.find((u) => stripAccents(u.name.toLowerCase()).includes(requestedName!)) || null;
            if (!selectedUser) {
              // Fuzzy match among online users
              selectedUser = fuzzyFindUser(users, requestedName!);
            }
            if (!selectedUser) {
              if (routingRuleMatched) {
                // Routing rule target not found among ONLINE users — NEVER transfer to offline
                const offlineTarget =
                  allUsersBeforeOfflineFilter.find((u) =>
                    stripAccents(u.name.toLowerCase()).includes(requestedName!),
                  ) || fuzzyFindUser(allUsersBeforeOfflineFilter, requestedName!);
                if (offlineTarget) {
                  console.log(
                    `[Webhook] falar_com_atendente - ⚠️ Routing rule target "${requestedName}" is OFFLINE (user: ${offlineTarget.name}, id=${offlineTarget.id}) — NOT transferring to offline`,
                  );
                  // Fall through to pick first online user instead
                  if (users.length > 0) {
                    const preferredOrder = parseTransferOrder(customNotes);
                    selectedUser =
                      preferredOrder.length > 0 ? selectAttendantByPriority(users, preferredOrder) : users[0];
                    console.log(`[Webhook] falar_com_atendente - Fallback to online attendant: ${selectedUser.name} (vai para a FILA: alvo da regra offline)`);
                  } else {
                    return {
                      status: "failed",
                      response: "",
                      error: `A ${offlineTarget.name} não está disponível no momento e não há outras atendentes online. Tente novamente mais tarde.`,
                    };
                  }
                } else {
                  // Target truly doesn't exist — pick first available online
                  console.log(
                    `[Webhook] falar_com_atendente - Routing rule target "${requestedName}" not found at all, auto-selecting first available online (vai para a FILA)`,
                  );
                  selectedUser = users[0] || null;
                }
              } else {
                // Check if the person exists but is offline (exact + fuzzy)
                const offlineMatch =
                  allUsersBeforeOfflineFilter.find((u) =>
                    stripAccents(u.name.toLowerCase()).includes(requestedName!),
                  ) || fuzzyFindUser(allUsersBeforeOfflineFilter, requestedName!);
                if (offlineMatch) {
                  // Person exists but is offline - inform and suggest alternatives
                  const onlineNames = users.map((u) => `• ${u.name}`).join("\n");
                  if (users.length > 0) {
                    return {
                      status: "needs_info",
                      response: "",
                      error: `A ${offlineMatch.name} não está disponível no momento. Posso sugerir outra atendente?\n\nAs atendentes disponíveis são:\n${onlineNames}\n\nCom qual delas você gostaria de falar?`,
                    };
                  } else {
                    return {
                      status: "failed",
                      response: "",
                      error: `A ${offlineMatch.name} não está disponível no momento e não há outras atendentes online. Tente novamente mais tarde.`,
                    };
                  }
                } else {
                  // Name truly not found even with fuzzy matching
                  const nameList = users.map((u) => `• ${u.name}`).join("\n");
                  return {
                    status: "needs_info",
                    response: "",
                    error: `Não encontrei uma atendente com o nome "${entities.attendant_name}". As atendentes disponíveis são:\n\n${nameList}\n\nCom qual delas você gostaria de falar? Ou posso transferir para qualquer uma disponível.`,
                  };
                }
              }
            }
          }

          // ATENDENTE DONA (política 21/07): sem nome pedido e sem regra clínica,
          // quem já atende ESTE paciente (últimos 30d) e está online tem prioridade
          // sobre ordem preferida/balanceamento — paciente tem dono, não sorteio.
          let _stickyPicked = false;
          if (!selectedUser && !requestedName) {
            const _ownerName = await findOwnerAttendant(supabaseClient, clinicTokenId, senderPhone);
            if (_ownerName) {
              const _ownerNorm = stripAccents(_ownerName.toLowerCase());
              selectedUser =
                users.find((u) => stripAccents(u.name.toLowerCase()).includes(_ownerNorm)) ||
                fuzzyFindUser(users, _ownerName) ||
                null;
              if (selectedUser) {
                _stickyPicked = true;
                console.log(`[Webhook] falar_com_atendente - DONA do paciente online: ${selectedUser.name} (sticky_owner)`);
              } else {
                console.log(`[Webhook] falar_com_atendente - dona "${_ownerName}" offline — segue a escada normal`);
              }
            }
          }

          // If no name specified and no routing rule matched, use round-robin from custom_notes order
          if (!selectedUser && !requestedName) {
            if (users.length > 0) {
              const preferredOrder = parseTransferOrder(customNotes);
              if (preferredOrder.length > 0) {
                selectedUser = selectAttendantByPriority(users, preferredOrder);
              } else {
                selectedUser = users[0];
              }
              console.log(`[Webhook] falar_com_atendente - No name specified, selected: ${selectedUser.name}`);
            } else {
              return {
                status: "failed",
                response: "",
                error: "Não há atendentes disponíveis no momento. Tente novamente mais tarde.",
              };
            }
          }

          // If patient said "qualquer uma" / no preference, pick using round-robin
          if (!selectedUser) {
            const preferredOrder = parseTransferOrder(customNotes);
            if (preferredOrder.length > 0) {
              selectedUser = selectAttendantByPriority(users, preferredOrder);
            } else {
              selectedUser = users[0];
            }
          }

          console.log(
            `[Webhook] falar_com_atendente - Selected attendant: ${selectedUser.name} (id=${selectedUser.id})`,
          );

          // Step 3: In test mode, simulate transfer success
          if (isTestMode) {
            console.log(`[Webhook] falar_com_atendente - Test mode: simulating transfer to ${selectedUser.name}`);
            return {
              status: "success",
              response: "Encaminhado para a fila de pendentes",
            };
          }

          // Step 4: Transfer ticket using unified helper (with showticket fallback)
          if (!senderPhone) {
            return {
              status: "failed",
              response: "",
              error: "Não foi possível identificar seu número para transferência.",
            };
          }

          let formattedPhone = senderPhone.replace(/\D/g, "");
          if (!formattedPhone.startsWith("55")) formattedPhone = "55" + formattedPhone;

          let transferResult = await transferTicketToHuman({
            baseUrl,
            apiId,
            bearerToken,
            phone: formattedPhone,
            userId: selectedUser.id,
            channelId,
            // Alvo explicito (regra/pedido): re-atribui mesmo se o ticket estiver
            // com outra dona stale (caso : preso na Lais, regra=Vania)
            forceReassign: true,
            // Dirigida só quando o paciente pediu o nome ou uma regra de palavra-chave
          });

          if (!transferResult.ok) {
            console.error(
              `[Webhook] falar_com_atendente - Transfer FAILED (1st try): attempt=${transferResult.attempt}, status=${transferResult.httpStatus}, detail=${transferResult.errorDetail}`,
            );
            // === RETRY: wait 3s and try the entire transfer flow again ===
            console.log(`[Webhook] falar_com_atendente - Retrying full transfer after 3s...`);
            await new Promise((r) => setTimeout(r, 3000));
            transferResult = await transferTicketToHuman({
              baseUrl,
              apiId,
              bearerToken,
              phone: formattedPhone,
              userId: selectedUser.id,
              channelId,
              forceReassign: true,
            });
            if (!transferResult.ok) {
              console.error(
                `[Webhook] falar_com_atendente - Transfer FAILED (2nd try): attempt=${transferResult.attempt}, status=${transferResult.httpStatus}, detail=${transferResult.errorDetail}`,
              );
              // Graceful degradation: instead of returning "failed" (which causes apology loops),
              // return success with a fallback message so the patient gets a proper response
              console.log(`[Webhook] falar_com_atendente - ⚠️ Graceful degradation: returning success with fallback message after 2 failed transfer attempts`);
              return {
                status: "success",
                response: `Não consegui transferir em tempo real, mas a equipe de atendimento foi notificada e entrará em contato em breve. Aguarde, por favor! 🙏`,
              };
            }
          }

          console.log(
            `[Webhook] falar_com_atendente - ✅ Transfer successful to ${selectedUser.name} (attempt=${transferResult.attempt})`,
          );
          // VIGILÂNCIA DA ESPERA (11/08). Este é o caminho de transferência MAIS
          // usado — 22 das 30 conversas transferidas em 10/08 — e era o único
          // grande que não entrava na fila do `human-transfer-timeout`. Sem isso
          // ninguém era avisado de que havia paciente esperando: a espera média
          // até a primeira resposta humana foi de 130 minutos, a maior de 364, e
          // 5 pacientes não tiveram resposta nenhuma. Agora o aviso de 15 min
          // cobre também este caminho.
          if (clinicTokenId) {
            await recordPendingHumanTransfer(supabaseClient, {
              clinicTokenId,
              conversationId: ((globalThis as any).__currentConversationId as string | undefined) || null,
              phone: formattedPhone,
              intent: "falar_com_atendente",
              ...avisoSemDona(),
              timeoutMinutes: (await getRoutingConfig(supabaseClient, clinicTokenId)).human_response_timeout_minutes,
            });
          }
          await logRoutingDecision(supabaseClient, {
            clinicTokenId: clinicTokenId as string,
            conversationId: ((globalThis as any).__currentConversationId as string | undefined) || null,
            phone: formattedPhone,
            intent: "falar_com_atendente",
            chosenAttendantName: selectedUser.name,
            chosenAttendantId: String(selectedUser.id),
            reason: routingRuleMatched ? "routing_rule" : requestedName ? "pedido_do_paciente" : "rodizio",
            onlineCount: users.length,
            totalCount: allUsersBeforeOfflineFilter.length,
          });
          // AUDITORIA (21/07): registra quem/por quê — aba Transferências
          await auditTransfer(supabaseClient, {
            clinicTokenId,
            conversationId: conversationIdParam,
            phone: senderPhone,
            // Sem alvo dirigido o ticket foi para a FILA — a aba Transferências
            // não pode dizer que foi para uma pessoa que não o recebeu.
            // SEMPRE null (31/08). Este era o ultimo ponto que ainda creditava uma
            // pessoa. Desde 30/08 nenhuma transferencia atribui — tudo vai para a
            // fila pendente e quem estiver livre puxa. Medido no dia seguinte a
            // mudanca: a aba Transferencias dizia que a Vania tinha recebido 7
            // tickets e a Lidiane 3, e nenhuma das duas recebeu nada. O nome que
            // saia daqui era o da atendente que a escada ESCOLHEU, nao a que
            // recebeu — e nao existe mais "a que recebeu".
            // `selectedUser` continua vivo de proposito: ele alimenta o
            // logRoutingDecision acima, que registra a ESCOLHA (outra coisa, e
            // ainda verdadeira).
            toAttendant: null,
            initiatedBy: "julia",
            trigger: "pedido_paciente",
            reason: _stickyPicked
              ? `sticky_owner:${selectedUser.name}`
              : requestedName
                ? `requested_by_name:${requestedName}`
                : `preferred_order:${selectedUser.name}`,
            detail: (currentMessageText || "").slice(0, 120),
          });
          return {
            status: "success",
            response: "Encaminhado para a fila de pendentes",
          };
        } catch (e) {
          console.error(`[Webhook] falar_com_atendente - Error:`, e);
          return { status: "failed", response: "", error: "Erro ao processar transferência para atendente." };
        }
      }

      case "entrar_lista_espera": {
        // Lista de espera (06/07): keyword "lista de espera" após o convite. O
        // médico vem do waitlist_invite gravado no outgoing da oferta de slots
        // (últimas 24h) — zero parsing de texto, zero dependência do recovery.
        const _wlConvId = ((globalThis as any).__currentConversationId as string | undefined) || null;
        if (!supabaseClient || !senderPhone || !clinicTokenId) {
          const m = "Claro! Me diga qual médico você quer aguardar que eu te coloco na lista de espera. 😊";
          return { status: "needs_info", response: m, error: m, bypassAiRewrite: true } as any;
        }
        let _wlInvite: { doctor_id?: string; doctor_name?: string; booked_date?: string } | null = null;
        try {
          const _since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          // Busca 1: pela conversa (qualquer direção — o convite do WIDGET é gravado
          // numa linha incoming; o do chat, no outgoing). Auditoria 10/07.
          if (_wlConvId) {
            const { data: _wlRows } = await supabaseClient
              .from("webhook_messages")
              .select("ai_entities")
              .eq("conversation_id", _wlConvId)
              .gte("created_at", _since24h)
              .not("ai_entities", "is", null)
              .order("created_at", { ascending: false })
              .limit(15);
            for (const r of _wlRows || []) {
              const wi = (r as any)?.ai_entities?.waitlist_invite;
              if (wi?.doctor_id && wi?.doctor_name) { _wlInvite = wi; break; }
            }
          }
          // Busca 2 (fallback): pelo telefone — o log do widget pode não ter
          // resolvido conversation_id (paciente nunca tinha falado no WhatsApp).
          if (!_wlInvite) {
            const { data: _wlRows2 } = await supabaseClient
              .from("webhook_messages")
              .select("ai_entities")
              .eq("clinic_token_id", clinicTokenId)
              .in("sender_phone", getPhoneVariants(senderPhone))
              .gte("created_at", _since24h)
              .not("ai_entities", "is", null)
              .order("created_at", { ascending: false })
              .limit(15);
            for (const r of _wlRows2 || []) {
              const wi = (r as any)?.ai_entities?.waitlist_invite;
              if (wi?.doctor_id && wi?.doctor_name) { _wlInvite = wi; break; }
            }
          }
        } catch (e) {
          console.log(`[Waitlist] busca de convite falhou (non-blocking): ${(e as Error).message}`);
        }
        if (!_wlInvite) {
          const m =
            "Para entrar na lista de espera, primeiro precisamos garantir um horário marcado com o médico — " +
            "assim, se abrir uma vaga mais próxima, eu só antecipo a sua consulta. 😊 " +
            "Me diga qual médico você procura que eu verifico a agenda!";
          return { status: "needs_info", response: m, error: m, bypassAiRewrite: true } as any;
        }
        const _wlVariants = getPhoneVariants(senderPhone);
        const { data: _wlExisting } = await supabaseClient
          .from("waitlist_entries")
          .select("id")
          .eq("clinic_token_id", clinicTokenId)
          .eq("doctor_id", String(_wlInvite.doctor_id))
          .in("phone", _wlVariants)
          .in("status", ["waiting", "notified"])
          .limit(1);
        if (_wlExisting && _wlExisting.length > 0) {
          const m = `Você já está na lista de espera do(a) ${_wlInvite.doctor_name}! ✅ Assim que abrir uma vaga, te aviso por aqui.`;
          return { status: "success", response: m, error: m, bypassAiRewrite: true } as any;
        }
        let _wlContactName: string | null = null;
        try {
          const { data: _wlConv } = await supabaseClient
            .from("chat_conversations")
            .select("contact_name")
            .in("phone", _wlVariants)
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle();
          _wlContactName = (_wlConv as any)?.contact_name || null;
        } catch { /* non-blocking */ }
        const { data: _wlInsRow, error: _wlInsErr } = await supabaseClient.from("waitlist_entries").insert({
          clinic_token_id: clinicTokenId,
          conversation_id: _wlConvId,
          phone: senderPhone.replace(/\D/g, ""),
          patient_name: _wlContactName,
          doctor_id: String(_wlInvite.doctor_id),
          doctor_name: String(_wlInvite.doctor_name),
          // Data da consulta-base que o paciente quer antecipar (aparece no painel
          // como "Data solicitada"). Vem do convite; normaliza p/ YYYY-MM-DD (o cron
          // compara com hoje p/ tirar da fila quem já passou). Ausente → null.
          requested_date: _wlInvite.booked_date ? String(_wlInvite.booked_date).slice(0, 10) : null,
          status: "waiting",
        }).select("id").maybeSingle();
        if (_wlInsErr) {
          console.error(`[Waitlist] insert falhou: ${_wlInsErr.message}`);
          const m = "Tive um problema para te colocar na lista de espera agora. 🙏 Pode tentar de novo em instantes?";
          return { status: "failed", response: m, error: m, bypassAiRewrite: true } as any;
        }
        console.log(`[Waitlist] ✅ entrada na fila: ${senderPhone} -> ${_wlInvite.doctor_name} (${_wlInvite.doctor_id})`);
        await logWaitlistEventWH(supabaseClient, {
          clinic_token_id: clinicTokenId, entry_id: (_wlInsRow as any)?.id || null, conversation_id: _wlConvId,
          phone: senderPhone.replace(/\D/g, ""), patient_name: _wlContactName, doctor_name: String(_wlInvite.doctor_name),
          event_type: "entrou_fila",
          detail: `${_wlContactName || "Paciente"} entrou na lista de espera do(a) ${_wlInvite.doctor_name}${_wlInvite.booked_date ? ` (consulta-base ${ddmmWH(String(_wlInvite.booked_date).slice(0, 10))})` : ""}.`,
        });
        const _wlOk =
          `Prontinho! ✅ Te coloquei na *lista de espera* do(a) ${_wlInvite.doctor_name}.\n\n` +
          `Sua consulta marcada continua garantida. Se abrir uma vaga mais próxima, te aviso por aqui — ` +
          `você terá *3 horas* para confirmar e eu antecipo sua consulta para o novo horário.\n\n` +
          `Pra eu tentar te encaixar melhor: qual período você prefere para antecipar — *manhã*, *tarde* ou *qualquer horário*? 😊`;
        return { status: "success", response: _wlOk, error: _wlOk, bypassAiRewrite: true } as any;
      }

      case "confirmar_periodo_espera": {
        // Confirmação determinística do período anotado (pedido 10/07).
        const _cpPeriod = String((entities as any)._waitlist_period_set || "qualquer");
        const _cpLabel = _cpPeriod === "manha" ? "pela *manhã*" : _cpPeriod === "tarde" ? "à *tarde*" : "em *qualquer horário*";
        const _cpMsg =
          `Anotado! ✅ Vou priorizar vagas ${_cpLabel} para tentar antecipar sua consulta. ` +
          `Assim que abrir um horário nesse período, te aviso por aqui. 😊`;
        return { status: "success", response: _cpMsg, error: _cpMsg, bypassAiRewrite: true } as any;
      }

      case "sair_lista_espera": {
        if (supabaseClient && senderPhone && clinicTokenId) {
          try {
            const { data: _wlLeft } = await supabaseClient
              .from("waitlist_entries")
              .update({ status: "cancelled", cancelled_reason: "patient_left", updated_at: new Date().toISOString() })
              .eq("clinic_token_id", clinicTokenId)
              .in("phone", getPhoneVariants(senderPhone))
              .in("status", ["waiting", "notified"])
              .select("id, doctor_name, conversation_id, patient_name, phone");
            for (const r of (_wlLeft || []) as any[]) {
              await logWaitlistEventWH(supabaseClient, {
                clinic_token_id: clinicTokenId, entry_id: r.id, conversation_id: r.conversation_id,
                phone: r.phone, patient_name: r.patient_name, doctor_name: r.doctor_name,
                event_type: "saiu_fila",
                detail: `${r.patient_name || "Paciente"} pediu para sair da lista de espera do(a) ${r.doctor_name}.`,
              });
            }
          } catch (e) {
            console.log(`[Waitlist] saída falhou (non-blocking): ${(e as Error).message}`);
          }
        }
        const _wlBye = "Prontinho! Você saiu da lista de espera. Se precisar de qualquer coisa, é só chamar. 😊";
        return { status: "success", response: _wlBye, error: _wlBye, bypassAiRewrite: true } as any;
      }

      case "recusar_vaga_espera": {
        // Paciente recusou a vaga ofertada: volta pro FIM da fila e o cron
        // oferece ao próximo no ciclo seguinte (a vaga é re-verificada fresca).
        let _wlDocName = "o médico";
        if (supabaseClient && senderPhone && clinicTokenId) {
          try {
            const _nowIso = new Date().toISOString();
            const { data: _wlNotified } = await supabaseClient
              .from("waitlist_entries")
              .select("id, doctor_name, patient_name, conversation_id")
              .eq("clinic_token_id", clinicTokenId)
              .in("phone", getPhoneVariants(senderPhone))
              .eq("status", "notified")
              .order("notified_at", { ascending: false })
              .limit(1);
            const _wlEntry = _wlNotified?.[0] as any;
            if (_wlEntry) {
              _wlDocName = _wlEntry.doctor_name || _wlDocName;
              await supabaseClient
                .from("waitlist_entries")
                .update({
                  status: "waiting", requeued_at: _nowIso, offered_slot: null,
                  notified_at: null, expires_at: null, miss_count: 0, updated_at: _nowIso,
                })
                .eq("id", _wlEntry.id);
              console.log(`[Waitlist] recusa: entry ${_wlEntry.id} volta pro fim da fila`);
              await logWaitlistEventWH(supabaseClient, {
                clinic_token_id: clinicTokenId, entry_id: _wlEntry.id, conversation_id: _wlEntry.conversation_id,
                phone: senderPhone.replace(/\D/g, ""), patient_name: _wlEntry.patient_name, doctor_name: _wlEntry.doctor_name,
                event_type: "oferta_recusada",
                detail: `${_wlEntry.patient_name || "Paciente"} recusou a vaga com ${_wlEntry.doctor_name} — voltou pro fim da fila, a vaga vai pro próximo.`,
              });
            }
          } catch (e) {
            console.log(`[Waitlist] recusa falhou (non-blocking): ${(e as Error).message}`);
          }
        }
        const _wlDecl =
          `Tudo bem! Passei essa vaga para o próximo da lista. Você continua na *lista de espera* do(a) ${_wlDocName} — ` +
          `se abrir outro horário, te aviso. 😉\n\n(Para sair da lista, é só dizer "sair da lista de espera".)`;
        return { status: "success", response: _wlDecl, error: _wlDecl, bypassAiRewrite: true } as any;
      }

      case "solicitar_infiltracao": {
        // Infiltração flow: check registration, request documents, transfer to Lidia/attendant
        console.log("[Webhook] solicitar_infiltracao - Starting infiltração flow");

        // ANTI-SPAM (relatorio 29/06 conv 74 Eliana): apos o handoff, CADA mensagem
        // nova da paciente (inclusive fotos de documentos) re-disparava a mesma
        // instrucao — 4x seguidas. O dedup de 5min nao pega porque o LLM parafraseia.
        // Se ja houve handoff de infiltracao/exame nesta conversa em 60min, SILENCIO:
        // a atendente esta assumindo e os documentos estao chegando.
        {
          const _convIdInf = ((globalThis as any).__currentConversationId as string | undefined) || null;
          if (_convIdInf && supabaseClient) {
            try {
              const _since60 = new Date(Date.now() - 60 * 60 * 1000).toISOString();
              const { count: _handoffCount } = await supabaseClient
                .from("webhook_messages")
                .select("id", { count: "exact", head: true })
                .eq("conversation_id", _convIdInf)
                .in("action_status", ["transferred_infiltracao", "needs_documents_infiltracao", "transferred_exame"])
                .gte("created_at", _since60);
              if ((_handoffCount || 0) > 0) {
                console.log(
                  `[Webhook] solicitar_infiltracao - handoff ja feito ha <60min (${_handoffCount} msg) — silencio, sem re-instruir`,
                );
                return { status: "human_handoff_active", response: "", error: "" } as any;
              }
            } catch (_e) { /* non-blocking */ }
          }
        }

        // Step 1: Check if patient is registered by phone
        let patientRegistered = false;
        if (senderPhone && supabaseClient) {
          const cleanPhone = senderPhone.replace(/\D/g, "");
          const { data: localPat } = await supabaseClient
            .from("local_patients")
            .select("id, name, cpf")
            .eq("phone", cleanPhone)
            .limit(1)
            .maybeSingle();

          if (localPat) {
            patientRegistered = true;
            console.log(`[Webhook] solicitar_infiltracao - Patient found in local_patients: ${localPat.name}`);
          } else {
            // Try with phone variants (with/without country code)
            const phoneVariants: string[] = [];
            // Try without country code FIRST (Amigo stores phones without 55)
            if (cleanPhone.startsWith("55") && cleanPhone.length > 10) {
              phoneVariants.push(cleanPhone.substring(2));
              phoneVariants.push(cleanPhone);
            } else {
              phoneVariants.push(cleanPhone);
              phoneVariants.push("55" + cleanPhone);
            }

            for (const variant of phoneVariants) {
              if (variant === cleanPhone) continue;
              const { data: localPat2 } = await supabaseClient
                .from("local_patients")
                .select("id, name, cpf")
                .eq("phone", variant)
                .limit(1)
                .maybeSingle();
              if (localPat2) {
                patientRegistered = true;
                console.log(
                  `[Webhook] solicitar_infiltracao - Patient found with variant phone ${variant}: ${localPat2.name}`,
                );
                break;
              }
            }
          }
        }

        // Fallback: check Amigo API directly if not found in local_patients
        if (!patientRegistered && amigoToken && senderPhone) {
          try {
            const cleanPhone = senderPhone.replace(/\D/g, "");
            const phoneForAmigo =
              cleanPhone.startsWith("55") && cleanPhone.length > 10 ? cleanPhone.substring(2) : cleanPhone;
            console.log(
              `[Webhook] solicitar_infiltracao - Not in local_patients, checking Amigo API with phone: ${phoneForAmigo}`,
            );
            const amigoResult = await tryFetch(`patients?phone=${phoneForAmigo}&company_id=${companyId}`, amigoToken);
            const amigoPatients = normalizeApiResponse(amigoResult);
            const foundPatient =
              Array.isArray(amigoPatients) && amigoPatients.length > 0
                ? amigoPatients[0]
                : amigoPatients &&
                    typeof amigoPatients === "object" &&
                    !Array.isArray(amigoPatients) &&
                    (amigoPatients as any).id
                  ? amigoPatients
                  : null;
            if (foundPatient) {
              patientRegistered = true;
              console.log(
                `[Webhook] solicitar_infiltracao - Patient found in Amigo API: ${(foundPatient as any).name || "unknown"}`,
              );
              // Save to local_patients for future lookups
              if (supabaseClient && clinicTokenId) {
                try {
                  const { data: whForCache } = await supabaseClient
                    .from("user_webhooks")
                    .select("user_id")
                    .eq("clinic_token_id", clinicTokenId)
                    .limit(1)
                    .maybeSingle();
                  if (whForCache?.user_id && (foundPatient as any).cpf) {
                    await supabaseClient.from("local_patients").upsert(
                      {
                        user_id: whForCache.user_id,
                        phone: cleanPhone,
                        cpf: String((foundPatient as any).cpf || ""),
                        name: String((foundPatient as any).name || ""),
                        amigo_patient_id: String((foundPatient as any).id || (foundPatient as any).patient_id || ""),
                      },
                      { onConflict: "user_id,cpf", ignoreDuplicates: true },
                    );
                    console.log("[Webhook] solicitar_infiltracao - Saved Amigo patient to local_patients cache");
                  }
                } catch (saveErr) {
                  console.log(`[Webhook] solicitar_infiltracao - Cache save error: ${saveErr.message}`);
                }
              }
            } else {
              console.log("[Webhook] solicitar_infiltracao - Patient NOT found in Amigo API either");
            }
          } catch (apiErr) {
            console.log(`[Webhook] solicitar_infiltracao - Amigo API check error: ${apiErr.message}`);
          }
        }

        // Step 2: If not registered, request registration first
        if (!patientRegistered) {
          console.log("[Webhook] solicitar_infiltracao - Patient not registered, requesting registration");
          return {
            status: "needs_registration",
            response: "",
            error:
              "O paciente solicitou infiltração mas não está cadastrado. Primeiro peça o CPF para confirmar. Se não tiver cadastro, peça os dados (nome completo, CPF, convênio/plano, endereço, data de nascimento). Informe também que precisará enviar: 1) foto da carteirinha do convênio, 2) documento pessoal (RG ou CNH), 3) laudo da ressonância magnética. NÃO tente agendar consulta.",
          };
        }

        // Step 3: Patient is registered - request documents and transfer
        console.log("[Webhook] solicitar_infiltracao - Patient registered, requesting documents and transferring");

        // Step 4: Transfer using specialty routing (config), routing rules, or first online
        if (avanceaiConfig) {
          const { baseUrl, apiId, bearerToken } = avanceaiConfig;
          try {
            const fetchRes = await fetchOnlineAttendants(baseUrl, apiId, bearerToken, { excludeNames: await nomesForaDoRodizio(supabaseClient, clinicTokenId, customNotes) });

            if (fetchRes.ok) {
              const users = fetchRes.online;

              // Look up specialty_routing for "infiltracao" category (if configured)
              let specialtyMatch: { attendantName: string; categoryName: string } | null = null;
              if (supabaseClient && clinicTokenId) {
                try {
                  const { data: sr } = await supabaseClient
                    .from("specialty_routing")
                    .select("category_name, attendant_name, keywords, keep_offline, is_active")
                    .eq("clinic_token_id", clinicTokenId)
                    .eq("is_active", true);
                  const row = (sr || []).find((r: any) => {
                    const cat = String(r.category_name || "").toLowerCase();
                    if (cat.includes("infiltra")) return true;
                    const kws: string[] = Array.isArray(r.keywords) ? r.keywords : [];
                    return kws.some((kw) => String(kw).toLowerCase().includes("infiltra"));
                  });
                  if (row && row.attendant_name) {
                    specialtyMatch = { attendantName: row.attendant_name, categoryName: row.category_name, keepOffline: row.keep_offline === true };
                  }
                } catch (_e) { /* table may not exist yet — fall through */ }
              }

              if (users.length > 0) {
                const preferredOrder = parseTransferOrder(customNotes);
                const routingConfig = await getRoutingConfig(supabaseClient, clinicTokenId);
                const ticketCounts = routingConfig.load_balance_enabled
                  ? await fetchTicketCountsByAttendant(baseUrl, apiId, bearerToken)
                  : {};
                const choice = selectAttendant(users, fetchRes.all, {
                  routingRules: routingRules || null,
                  preferredOrder,
                  specialtyMatch,
                  currentMessageText: currentMessageText || null,
                  ticketCounts,
                  loadBalanceEnabled: routingConfig.load_balance_enabled,
                });
                let selectedUser = choice.user as any;
                if (!selectedUser && choice.offlineTargetName) {
                  selectedUser = users[0];
                }
                if (!selectedUser) selectedUser = users[0];
                console.log(`[Webhook] solicitar_infiltracao - Selected attendant: ${selectedUser.name} (reason=${choice.reason})`);
                await logRoutingDecision(supabaseClient, {
                  clinicTokenId,
                  conversationId: ((globalThis as any).__currentConversationId as string | undefined) || null,
                  phone: senderPhone || "",
                  intent: "solicitar_infiltracao",
                  chosenAttendantName: selectedUser.name,
                  chosenAttendantId: String(selectedUser.id),
                  reason: choice.reason,
                  offlineTargetName: choice.offlineTargetName || null,
                  onlineCount: users.length,
                  totalCount: fetchRes.all.length,
                  ticketCounts: Object.keys(ticketCounts).length ? ticketCounts : null,
                });

                if (isTestMode) {
                  return {
                    status: "success",
                    response: "Infiltração solicitada. Documentos necessários informados. Encaminhado para a fila de pendentes.",
                  };
                }

                // Transfer ticket using unified helper
                if (senderPhone) {
                  let formattedPhone = senderPhone.replace(/\D/g, "");
                  if (!formattedPhone.startsWith("55")) formattedPhone = "55" + formattedPhone;

                  const transferResult = await transferTicketToHuman({
                    baseUrl,
                    apiId,
                    bearerToken,
                    phone: formattedPhone,
                    userId: selectedUser.id,
                    channelId,
                    // Alvo por regra (exame->Vania / infiltracao->Lidiane): re-atribui
                    // dona stale (caso preso na Lais)
                    forceReassign: true,
                  });

                  if (transferResult.ok) {
                    console.log(
                      `[Webhook] solicitar_infiltracao - ✅ Transfer successful to ${selectedUser.name} (attempt=${transferResult.attempt})`,
                    );
                    if (clinicTokenId) { // política 21/07: registrar SEMPRE (o executor agora só AVISA, nunca troca de mão)
                      await recordPendingHumanTransfer(supabaseClient, {
                        clinicTokenId,
                        conversationId: ((globalThis as any).__currentConversationId as string | undefined) || null,
                        phone: formattedPhone,
                        intent: "solicitar_infiltracao",
                        ...avisoSemDona(),
                        timeoutMinutes: routingConfig.human_response_timeout_minutes,
                      });
                    }
                  } else {
                    console.error(
                      `[Webhook] solicitar_infiltracao - Transfer FAILED: attempt=${transferResult.attempt}, status=${transferResult.httpStatus}, detail=${transferResult.errorDetail}`,
                    );
                    return {
                      status: "failed",
                      response: "",
                      error:
                        "Não foi possível transferir o atendimento para a atendente no momento. Tente novamente em alguns instantes.",
                    };
                  }
                }

                return {
                  status: "transferred_infiltracao",
                  response: "Encaminhado para a fila de pendentes",
                  error:
                    "O paciente solicitou infiltração e já está cadastrado. Informe que pode enviar as ressonâncias/documentos por aqui mesmo, que estamos encaminhando para a Lidiane (ou atendente) que dará continuidade. NÃO peça dados cadastrais. NÃO tente agendar consulta.",
                };
              }
            }
          } catch (e) {
            console.error(`[Webhook] solicitar_infiltracao - Transfer error:`, e);
          }
        }

        // Fallback: no AvanceAI or no attendants available
        return {
          status: "transferred_infiltracao",
          response: "",
          error:
            "O paciente solicitou infiltração e já está cadastrado. Informe que pode enviar as ressonâncias/documentos por aqui mesmo, que estamos encaminhando para uma atendente que dará continuidade. NÃO peça dados cadastrais. NÃO tente agendar consulta.",
        };
      }

      case "solicitar_fisioterapia": {
        // Roteamento próprio da fisioterapia (relatorio 08/07, caso Italo): informar
        // valores + avaliação gratuita (script ditado pelo usuário) e transferir para
        // a equipe. Determinístico — nunca cai no fluxo de "buscar especialista".
        console.log("[Webhook] solicitar_fisioterapia - roteamento próprio da fisio");

        // ANTI-SPAM (mesmo padrão infiltração/exame): handoff <60min = silêncio
        {
          const _convIdFis = conversationIdParam || ((globalThis as any).__currentConversationId as string | undefined) || null;
          if (_convIdFis && supabaseClient) {
            try {
              const _since60f = new Date(Date.now() - 60 * 60 * 1000).toISOString();
              const { count: _fisCount } = await supabaseClient
                .from("webhook_messages")
                .select("id", { count: "exact", head: true })
                .eq("conversation_id", _convIdFis)
                .eq("action_status", "transferred_fisioterapia")
                .gte("created_at", _since60f);
              if ((_fisCount || 0) > 0) {
                console.log(`[Webhook] solicitar_fisioterapia - handoff <60min — silêncio`);
                return { status: "human_handoff_active", response: "", error: "" } as any;
              }
            } catch (_e) { /* non-blocking */ }
          }
        }

        // A PALAVRA "fisio" NÃO É A INTENÇÃO (26/08). Os três disparos do dia
        // foram todos errados: dois queriam GUIA do ortopedista para fazer fisio
        // em OUTRO lugar, e um queria tirar dúvida de exercício com a
        // fisioterapeuta. Mandar tabela de preço para quem pede receita é vender
        // o que ninguém pediu — e some com o pedido real no meio do texto.
        const _intFisio = classificarPedidoDeFisioterapia(currentMessageText || "");
        console.log(`[Webhook] solicitar_fisioterapia - intenção=${_intFisio}`);
        const fisioScript =
          _intFisio === "pedido_medico"
            ? "Pedido, guia ou renovação de sessões quem emite é o médico. 🙏 Vou te passar para nossa equipe verificar isso com o doutor."
            : _intFisio === "falar_com_fisio"
              ? "Vou te passar para nossa equipe, que fala direto com a fisioterapeuta e te retorna por aqui. 🙏"
            : _intFisio === "sessao_em_curso"
              // Quem JÁ faz fisio aqui não pode receber tabela de preço: ele não
              // está comprando nada, está falando da sessão dele.
              ? "Já passei para nossa equipe, que cuida da agenda da fisioterapia e te responde por aqui. 🙏"
              : "Nossa fisioterapia funciona pelo sistema de reembolso: sessão avulsa por R$ 180 ou pacote de 10 sessões por R$ 1.500 (em até 3x), com *avaliação gratuita*. 😊 " +
                "Emitimos nota fiscal e relatório certinhos para você solicitar o reembolso ao seu plano. Vou te passar para nossa equipe agendar sua avaliação!";

        if (avanceaiConfig && senderPhone && !isTestMode) {
          let _fisPhone = senderPhone.replace(/\D/g, "");
          if (!_fisPhone.startsWith("55")) _fisPhone = "55" + _fisPhone;
          // Alvo: routing rule com keyword "fisio" (se configurada e online); senão fila geral
          let _fisTarget: number | string | undefined = undefined;
          try {
            const _fisRule = Array.isArray(routingRules)
              ? routingRules.find((r) => stripAccents(String(r.keyword || "").toLowerCase()).includes("fisio"))
              : null;
            if (_fisRule?.target_user) {
              const _fisFetch = await fetchOnlineAttendants(
                avanceaiConfig.baseUrl, avanceaiConfig.apiId, avanceaiConfig.bearerToken,
                { excludeNames: await nomesForaDoRodizio(supabaseClient, clinicTokenId, customNotes) },
              );
              const _tNorm = stripAccents(String(_fisRule.target_user).toLowerCase());
              const _m = (_fisFetch.ok ? _fisFetch.online : []).find((u: any) =>
                stripAccents(String(u.name || "").toLowerCase()).includes(_tNorm),
              );
              if (_m) _fisTarget = _m.id;
            }
          } catch (e) {
            console.log(`[Fisio] resolução de alvo falhou (non-blocking): ${(e as Error).message}`);
          }
          try {
            await transferTicketToHuman({
              baseUrl: avanceaiConfig.baseUrl,
              apiId: avanceaiConfig.apiId,
              bearerToken: avanceaiConfig.bearerToken,
              phone: _fisPhone,
              userId: _fisTarget,
              channelId,
              forceReassign: !!_fisTarget,
            });
          } catch (e) {
            console.error(`[Fisio] transferência falhou: ${(e as Error).message}`);
          }
        }
        return { status: "transferred_fisioterapia", response: fisioScript, error: fisioScript, bypassAiRewrite: true } as any;
      }

      case "solicitar_exame": {
        // Exam request flow: transfer using specialty routing or first online
        console.log("[Webhook] solicitar_exame - Starting exam request flow");

        // ANTI-SPAM: mesmo guard da infiltracao — handoff <60min = silencio.
        {
          const _convIdEx = ((globalThis as any).__currentConversationId as string | undefined) || null;
          if (_convIdEx && supabaseClient) {
            try {
              const _since60 = new Date(Date.now() - 60 * 60 * 1000).toISOString();
              const { count: _handoffCount } = await supabaseClient
                .from("webhook_messages")
                .select("id", { count: "exact", head: true })
                .eq("conversation_id", _convIdEx)
                .in("action_status", ["transferred_infiltracao", "needs_documents_infiltracao", "transferred_exame"])
                .gte("created_at", _since60);
              if ((_handoffCount || 0) > 0) {
                console.log(
                  `[Webhook] solicitar_exame - handoff ja feito ha <60min (${_handoffCount} msg) — silencio, sem re-instruir`,
                );
                return { status: "human_handoff_active", response: "", error: "" } as any;
              }
            } catch (_e) { /* non-blocking */ }
          }
        }

        if (avanceaiConfig) {
          const { baseUrl, apiId, bearerToken } = avanceaiConfig;
          try {
            const fetchRes = await fetchOnlineAttendants(baseUrl, apiId, bearerToken, { excludeNames: await nomesForaDoRodizio(supabaseClient, clinicTokenId, customNotes) });
            if (fetchRes.ok) {
              const users = fetchRes.online;

              // Look up specialty_routing for "exame" category (if configured)
              let specialtyMatch: { attendantName: string; categoryName: string } | null = null;
              if (supabaseClient && clinicTokenId) {
                try {
                  const { data: sr } = await supabaseClient
                    .from("specialty_routing")
                    .select("category_name, attendant_name, keywords, is_active")
                    .eq("clinic_token_id", clinicTokenId)
                    .eq("is_active", true);
                  const row = (sr || []).find((r: any) => {
                    const cat = String(r.category_name || "").toLowerCase();
                    if (cat.includes("exame")) return true;
                    const kws: string[] = Array.isArray(r.keywords) ? r.keywords : [];
                    return kws.some((kw) => String(kw).toLowerCase().includes("exame"));
                  });
                  if (row && row.attendant_name) {
                    specialtyMatch = { attendantName: row.attendant_name, categoryName: row.category_name, keepOffline: row.keep_offline === true };
                  }
                } catch (_e) { /* non-blocking */ }
              }

              if (users.length > 0) {
                const preferredOrder = parseTransferOrder(customNotes);
                const routingConfig = await getRoutingConfig(supabaseClient, clinicTokenId);
                const ticketCounts = routingConfig.load_balance_enabled
                  ? await fetchTicketCountsByAttendant(baseUrl, apiId, bearerToken)
                  : {};
                const choice = selectAttendant(users, fetchRes.all, {
                  routingRules: routingRules || null,
                  preferredOrder,
                  specialtyMatch,
                  currentMessageText: currentMessageText || null,
                  ticketCounts,
                  loadBalanceEnabled: routingConfig.load_balance_enabled,
                });
                const selectedUser = (choice.user || users[0]) as any;
                console.log(`[Webhook] solicitar_exame - Selected attendant: ${selectedUser.name} (reason=${choice.reason})`);
                await logRoutingDecision(supabaseClient, {
                  clinicTokenId,
                  conversationId: ((globalThis as any).__currentConversationId as string | undefined) || null,
                  phone: senderPhone || "",
                  intent: "solicitar_exame",
                  chosenAttendantName: selectedUser.name,
                  chosenAttendantId: String(selectedUser.id),
                  reason: choice.reason,
                  offlineTargetName: choice.offlineTargetName || null,
                  onlineCount: users.length,
                  totalCount: fetchRes.all.length,
                  ticketCounts: Object.keys(ticketCounts).length ? ticketCounts : null,
                });

                if (isTestMode) {
                  return {
                    status: "transferred_exame",
                    response: "Exame solicitado. Encaminhado para a fila de pendentes.",
                  };
                }

                // Transfer ticket using unified helper
                if (senderPhone) {
                  let formattedPhone = senderPhone.replace(/\D/g, "");
                  if (!formattedPhone.startsWith("55")) formattedPhone = "55" + formattedPhone;

                  const transferResult = await transferTicketToHuman({
                    baseUrl,
                    apiId,
                    bearerToken,
                    phone: formattedPhone,
                    userId: selectedUser.id,
                    channelId,
                    // Alvo por regra (exame->Vania / infiltracao->Lidiane): re-atribui
                    // dona stale (caso preso na Lais)
                    forceReassign: true,
                  });

                  if (transferResult.ok) {
                    console.log(
                      `[Webhook] solicitar_exame - ✅ Transfer successful to ${selectedUser.name} (attempt=${transferResult.attempt})`,
                    );
                    if (clinicTokenId) { // política 21/07: registrar SEMPRE (o executor agora só AVISA, nunca troca de mão)
                      await recordPendingHumanTransfer(supabaseClient, {
                        clinicTokenId,
                        conversationId: ((globalThis as any).__currentConversationId as string | undefined) || null,
                        phone: formattedPhone,
                        intent: "solicitar_exame",
                        ...avisoSemDona(),
                        timeoutMinutes: routingConfig.human_response_timeout_minutes,
                      });
                    }
                  } else {
                    console.error(
                      `[Webhook] solicitar_exame - Transfer FAILED: attempt=${transferResult.attempt}, status=${transferResult.httpStatus}, detail=${transferResult.errorDetail}`,
                    );
                    return {
                      status: "failed",
                      response: "",
                      error:
                        "Não foi possível transferir o atendimento para a atendente no momento. Tente novamente em alguns instantes.",
                    };
                  }
                }

                return {
                  status: "transferred_exame",
                  response: "Encaminhado para a fila de pendentes",
                  error:
                    "O paciente solicitou um exame. Informe que estamos encaminhando para uma atendente que dará continuidade ao pedido de exame. NÃO tente agendar consulta.",
                };
              }
            }
          } catch (e) {
            console.error(`[Webhook] solicitar_exame - Transfer error:`, e);
          }
        }

        // Fallback: no AvanceAI or no attendants available
        return {
          status: "transferred_exame",
          response: "",
          error:
            "O paciente solicitou um exame. Informe que estamos encaminhando para uma atendente que dará continuidade ao pedido de exame. NÃO tente agendar consulta.",
        };
      }

      case "unknown":
      default:
        return {
          status: "unknown_intent",
          response: "Não foi possível identificar a intenção da mensagem",
        };
    }
  } catch (e) {
    console.error(`[Action] Error executing ${intent}:`, e);
    return { status: "failed", response: "", error: e.message || "Erro interno ao executar ação" };
  }
}

// Helper: create or update conversation
async function upsertConversation(
  supabaseClient: any,
  userId: string,
  clinicTokenId: string | null,
  phone: string,
  contactName: string,
  lastMessage: string,
  direction: string,
  ticketInfo?: { agentName?: string | null; ticketStatus?: string | null },
): Promise<string | null> {
  try {
    // Normalize phone: always store with Brazil prefix 55 (matches existing data)
    const digits = (phone || "").replace(/\D/g, "");
    if (!digits) {
      console.error("[Webhook] upsertConversation: empty phone");
      return null;
    }
    const phoneToStore = digits.startsWith("55") ? digits : `55${digits}`;
    // COLISÃO DE DDD (11/08). O fallback casava pelos ÚLTIMOS 10 DÍGITOS, e num
    // celular de 11 dígitos isso descarta o PRIMEIRO dígito do DDD:
    // 11987654321 e 21987654321 viram os mesmos "1987654321". São Paulo e Rio
    // colidiam — a conversa de um paciente podia receber a mensagem de outro, e
    // com ela o nome dele. getPhoneVariants cobre as variações legítimas do MESMO
    // número (com/sem 55, com/sem o 9º dígito) e é comparação EXATA.
    const variantesTelefone = Array.from(
      new Set(getPhoneVariants(phoneToStore).map((p) => p.replace(/\D/g, "")).filter(Boolean)),
    );

    // 1) Exact match on normalized phone
    let lookup = supabaseClient
      .from("chat_conversations")
      .select("id, unread_count")
      .eq("user_id", userId)
      .eq("phone", phoneToStore);
    if (clinicTokenId) lookup = lookup.eq("clinic_token_id", clinicTokenId);
    else lookup = lookup.is("clinic_token_id", null);

    let { data: existing, error: lookupErr } = await lookup.maybeSingle();
    if (lookupErr) console.error("[Webhook] upsertConversation lookup error:", lookupErr);

    // 2) Fallback: variantes EXATAS do mesmo número (linhas antigas com/sem 55)
    if (!existing) {
      let fb = supabaseClient
        .from("chat_conversations")
        .select("id, unread_count")
        .eq("user_id", userId)
        .in("phone", variantesTelefone)
        .order("last_message_at", { ascending: false })
        .limit(1);
      if (clinicTokenId) fb = fb.eq("clinic_token_id", clinicTokenId);
      else fb = fb.is("clinic_token_id", null);
      const { data: fbRows, error: fbErr } = await fb;
      if (fbErr) console.error("[Webhook] upsertConversation fallback error:", fbErr);
      if (fbRows && fbRows.length > 0) existing = fbRows[0];
    }

    if (existing) {
      const updates: Record<string, unknown> = {
        last_message: lastMessage.substring(0, 200),
        last_message_at: new Date().toISOString(),
        contact_name: contactName || undefined,
      };
      if (direction === "incoming") {
        updates.unread_count = (existing.unread_count || 0) + 1;
      }
      if (ticketInfo) {
        if (ticketInfo.ticketStatus === "open" && ticketInfo.agentName) {
          updates.assigned_agent_name = ticketInfo.agentName;
          updates.ticket_status = "open";
        } else if (
          ticketInfo.ticketStatus === "pending" ||
          ticketInfo.ticketStatus === "closed" ||
          ticketInfo.ticketStatus === "resolved"
        ) {
          updates.assigned_agent_name = null;
          updates.ticket_status = ticketInfo.ticketStatus;
        } else if (ticketInfo.ticketStatus) {
          updates.ticket_status = ticketInfo.ticketStatus;
        }
      }
      const { error: updErr } = await supabaseClient
        .from("chat_conversations")
        .update(updates)
        .eq("id", existing.id);
      if (updErr) console.error("[Webhook] upsertConversation update error:", updErr);
      return existing.id;
    }

    const insertData: Record<string, unknown> = {
      user_id: userId,
      clinic_token_id: clinicTokenId,
      phone: phoneToStore,
      contact_name: contactName || phoneToStore,
      last_message: lastMessage.substring(0, 200),
      last_message_at: new Date().toISOString(),
      unread_count: direction === "incoming" ? 1 : 0,
    };
    if (ticketInfo?.ticketStatus === "open" && ticketInfo?.agentName) {
      insertData.assigned_agent_name = ticketInfo.agentName;
      insertData.ticket_status = "open";
    } else if (ticketInfo?.ticketStatus) {
      insertData.ticket_status = ticketInfo.ticketStatus;
    }

    const { data: newConv, error: insErr } = await supabaseClient
      .from("chat_conversations")
      .insert(insertData)
      .select("id")
      .single();
    if (insErr) console.error("[Webhook] upsertConversation insert error:", insErr, { phoneToStore, userId, clinicTokenId });

    return newConv?.id || null;
  } catch (e) {
    console.error("[Webhook] Error upserting conversation:", e);
    return null;
  }
}

// --- TYPING INDICATOR ---
// FIX (roadmap UX 04/07): a versao anterior POSTava no endpoint de MENSAGEM com
// payload errado ({number,type}) e sem externalKey — nao mostrava "digitando" e
// arriscava comportamento indefinido de ticket. O endpoint documentado e'
// POST /v2/api/external/{ApiID}/sendPresence com {ticketId, state}
// (docs/avanceai-api-reference.md linha 107). Sem ticketId, NAO chama nada.

// Helper: send reply via AvanceAI
// Normalize text for similarity comparison (lowercase, strip accents, collapse whitespace).

// Cheap similarity: 1.0 if equal; if either is contained in the other and the shorter
// is >= 80% of the longer, treat as near-duplicate. We don't ship Levenshtein on Deno.

// Returns true if `text` is near-duplicate of any outgoing AI message in the
// same conversation within the last `windowSec` seconds.


// ── Centralized helper: check if ticket is currently owned by a human agent ──
// Returns { isHumanOwned, status, userId, userName } — always includes channelId for multicanal
// Up to 3 attempts (800ms / 1.6s / 3.2s) on 5xx/timeout before failing safe.
// FAIL-SAFE on persistent error: treat as UNKNOWN and BLOCK AI (never allow through on doubt)

// ── Unified human-agent guard (BUG-2 FIX) ──
// Combines five signals — any positive blocks the AI:
//   1. raw payload from AvanceAI: status="open" + userId>0
//   2. recent manual_reply (≤2h) on the same conversation_id
//   3. recent skip with reason "Ticket com atendente humano%" (≤30min)
//   4. live showticket API via checkTicketIsHumanOwned (fail-safe = block on error)
//   5. handoff recente em transfer_audit (≤24h) — pega o ticket que voltou para a
//      FILA (pending, sem dono), que nenhum dos outros quatro enxerga
// This MUST run on every webhook regardless of test mode — that was the original bug.
async function isHumanActive(
  supabaseClient: any,
  rawTicket: Record<string, unknown> | undefined,
  conversationId: string | null,
  avanceaiBaseUrl: string | null,
  avanceaiApiId: string | null,
  avanceaiBearerToken: string | null,
  phone: string,
  resolvedChannelId: string | null,
): Promise<{ blocked: boolean; reason: string }> {
  // Signal 1: raw payload check
  const rawStatus = String((rawTicket?.status as string) || "");
  const rawUserId = Number(rawTicket?.userId || 0);
  if (rawStatus === "open" && rawUserId > 0) {
    return { blocked: true, reason: `raw_payload(status=open,userId=${rawUserId})` };
  }

  // Signal 2: recent manual_reply (≤2h) — a human already typed something in this card
  if (conversationId && supabaseClient) {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: manual } = await supabaseClient
        .from("webhook_messages")
        .select("created_at")
        .eq("conversation_id", conversationId)
        .eq("direction", "outgoing")
        .eq("ai_intent", "manual_reply")
        .gte("created_at", twoHoursAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (manual) {
        return { blocked: true, reason: "recent_manual_reply(<2h)" };
      }
    } catch (_) {
      /* non-blocking */
    }
  }

  // Signal 3: recent human-skipped message (≤30min) — equivalent to the old DB history check
  if (conversationId && supabaseClient) {
    try {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { count } = await supabaseClient
        .from("webhook_messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("action_status", "skipped")
        .like("action_error", "Ticket com atendente humano%")
        .gte("created_at", thirtyMinAgo);
      if ((count || 0) > 0) {
        return { blocked: true, reason: `recent_human_skip(${count})` };
      }
    } catch (_) {
      /* non-blocking */
    }
  }

  // Signal 5: a conversa JA FOI ENTREGUE a gente (pedido do dono, 26/08)
  // ─────────────────────────────────────────────────────────────────────────
  // Os sinais 1 e 4 perguntam "o ticket tem dono?". Com a transferencia indo
  // para a FILA (status=pending, sem userId), a resposta e NAO — e a IA voltaria
  // a responder por cima de um paciente que ja esta esperando atendente.
  //
  // Pior no caso da devolucao por inatividade: a atendente pegou, o paciente
  // perguntou, ela nao respondeu, o ticket voltou para a fila. Nao existe
  // manual_reply (ela nunca digitou), entao o sinal 2 tambem nao pega. Sem este
  // sinal, a Julia entraria exatamente no paciente que ja esta mal atendido.
  //
  // transfer_audit registra TODO handoff — transferencia da Julia e devolucao a
  // fila. Enquanto houver registro recente, a conversa e de gente.
  //
  // 24h e o padrao: cobre o expediente inteiro e o dia seguinte cedo, sem prender
  // o paciente para sempre. HANDOFF_BLOQUEIA_IA_HORAS ajusta sem deploy.
  if (conversationId && supabaseClient) {
    try {
      const horas = Number(Deno.env.get("HANDOFF_BLOQUEIA_IA_HORAS") || "24") || 24;
      const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();
      const { data: handoff } = await supabaseClient
        .from("transfer_audit")
        .select("created_at, reason")
        .eq("conversation_id", conversationId)
        .gte("created_at", desde)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (handoff) {
        return {
          blocked: true,
          reason: `handoff_ativo(${String(handoff.reason || "transferido")},<${horas}h)`,
        };
      }
    } catch (_) {
      /* non-blocking: os outros sinais continuam valendo */
    }
  }


  // Signal 4: live showticket API (fail-safe = block on any error)
  if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
    try {
      const check = await checkTicketIsHumanOwned(
        avanceaiBaseUrl,
        avanceaiApiId,
        avanceaiBearerToken,
        phone,
        resolvedChannelId,
      );
      if (check.isHumanOwned) {
        // Tema 4 / bonus (Amostra 1 — abandono noturno): um ticket "open" com agente
        // atribuido bloqueava a IA INDEFINIDAMENTE, mesmo sem NENHUMA atividade humana
        // ha horas. Adiciona staleness: se o status e' um "open" genuino (nao erro de
        // auth/api) e nao houve manual_reply algum nesta conversa na janela de
        // staleness, o ticket esta abandonado -> libera a IA. Conservador: um humano
        // ativo na janela (Signals 2/3 + esta checagem) continua bloqueando.
        const staleHours = Number(Deno.env.get("HUMAN_TICKET_STALE_HOURS") || "8") || 8;
        if (check.status === "open" && conversationId && supabaseClient) {
          try {
            const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
            const { data: recentHuman } = await supabaseClient
              .from("webhook_messages")
              .select("created_at")
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .eq("ai_intent", "manual_reply")
              .gte("created_at", staleCutoff)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (!recentHuman) {
              console.log(
                `[isHumanActive] Ticket "open" (agent=${check.userName || check.userId}) mas SEM manual_reply em ${staleHours}h — STALE, liberando IA`,
              );
              // nao bloqueia: ticket aberto e' considerado abandonado
            } else {
              return { blocked: true, reason: `showticket(agent=${check.userName || check.userId})` };
            }
          } catch (_) {
            // Em duvida, mantem o fail-safe (bloqueia)
            return { blocked: true, reason: `showticket(agent=${check.userName || check.userId})` };
          }
        } else {
          // Sem conversationId/cliente ou status nao-"open" genuino: fail-safe (bloqueia)
          return { blocked: true, reason: `showticket(agent=${check.userName || check.userId})` };
        }
      }
      if (check.status === "api_error_blocked") {
        return { blocked: true, reason: "showticket_api_error_failsafe" };
      }
    } catch (e: any) {
      return { blocked: true, reason: `showticket_exception:${e?.message || e}` };
    }
  }

  return { blocked: false, reason: "" };
}

// Helper: resolve AvanceAI credentials and dispatch transcription to card/ticket
// Self-contained — can be called from any point in the pipeline (batched messages or main flow)
// Self-contained — can be called from any point in the pipeline (batched messages or main flow)
async function dispatchTranscriptionToCard(
  supabase: any,
  userId: string,
  clinicTokenId: string,
  webhookId: string,
  phone: string,
  name: string,
  conversationId: string | null,
  messageId: string,
  transcriptionText: string,
  transcriptionFailed: boolean,
  resolvedChannelId: string | null,
  chBaseUrl: string | null,
  chApiId: string | null,
  chBearerToken: string | null,
  isTestMode: boolean,
): Promise<void> {
  try {
    // Resolve AvanceAI credentials (same priority logic as main pipeline)
    let baseUrl: string | null = null;
    let apiId: string | null = null;
    let bearerToken: string | null = null;

    // Priority 1: Gateway-provided per-channel creds
    if (chBaseUrl && chApiId && chBearerToken) {
      baseUrl = chBaseUrl;
      apiId = chApiId;
      bearerToken = chBearerToken;
    } else {
      // Need to fetch clinic config
      const { data: tokenData } = await supabase
        .from("clinic_tokens")
        .select("avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel")
        .eq("id", clinicTokenId)
        .maybeSingle();

      if (tokenData) {
        const hasChannelConfig = !!tokenData.avanceai_active_channel;
        let channelConfigs: any[] = [];
        if (hasChannelConfig) {
          try {
            const parsed = JSON.parse(tokenData.avanceai_active_channel);
            if (Array.isArray(parsed)) channelConfigs = parsed.filter((ch: any) => ch && ch.enabled !== false);
          } catch {
            /* ignore */
          }
        }

        if (resolvedChannelId && channelConfigs.length > 0) {
          for (let i = channelConfigs.length - 1; i >= 0; i--) {
            const ch = channelConfigs[i];
            if (ch && String(ch.id) === String(resolvedChannelId) && ch.apiId && ch.baseUrl) {
              baseUrl = ch.baseUrl;
              apiId = ch.apiId;
              bearerToken = ch.bearerToken;
              break;
            }
          }
        } else if (!hasChannelConfig || channelConfigs.length === 0) {
          baseUrl = tokenData.avanceai_base_url;
          apiId = tokenData.avanceai_api_id;
          bearerToken = tokenData.avanceai_bearer_token;
        } else if (channelConfigs.length === 1) {
          const ch = channelConfigs[0];
          if (ch && ch.apiId && ch.baseUrl) {
            baseUrl = ch.baseUrl;
            apiId = ch.apiId;
            bearerToken = ch.bearerToken;
          }
        }
      }
    }

    if (!baseUrl || !apiId || !bearerToken) {
      console.log(`[Webhook] dispatchTranscription: No AvanceAI credentials available for msg ${messageId} — skipping`);
      return;
    }

    if (isTestMode) {
      console.log(`[Webhook] dispatchTranscription: Test mode — skipping AvanceAI send for msg ${messageId}`);
      // Still save the outgoing message in test mode
      await supabase.from("webhook_messages").insert({
        user_id: userId,
        webhook_id: webhookId,
        clinic_token_id: clinicTokenId,
        sender_phone: phone,
        sender_name: name,
        message_text: transcriptionText,
        direction: "outgoing",
        conversation_id: conversationId,
        action_status: transcriptionFailed ? "failed" : "success",
        ai_intent: "transcription",
      });
      return;
    }

    console.log(`[Webhook] dispatchTranscription: Sending transcription to card for msg ${messageId}...`);
    const sent = await sendAvanceaiReply(baseUrl, apiId, bearerToken, phone, transcriptionText, resolvedChannelId);
    if (sent) {
      await supabase.from("webhook_messages").insert({
        user_id: userId,
        webhook_id: webhookId,
        clinic_token_id: clinicTokenId,
        sender_phone: phone,
        sender_name: name,
        message_text: transcriptionText,
        direction: "outgoing",
        conversation_id: conversationId,
        action_status: transcriptionFailed ? "failed" : "success",
        ai_intent: "transcription",
      });
      console.log(`[Webhook] dispatchTranscription: Transcription sent and saved for msg ${messageId}`);
    } else {
      console.error(`[Webhook] dispatchTranscription: Failed to send transcription to AvanceAI for msg ${messageId}`);
    }
  } catch (err: any) {
    console.error(`[Webhook] dispatchTranscription: Error for msg ${messageId}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// Unified transfer helper — single source of truth for all
// falar_com_atendente / solicitar_infiltracao / solicitar_exame / media
// ═══════════════════════════════════════════════════════════



// Generate AI response using dynamic script persona
async function generateAIResponse(
  apiKey: string,
  dynamicScript: string | undefined,
  patientMessage: string,
  intent: string,
  actionResult: {
    status: string;
    response: string;
    error?: string;
    internal_instruction?: string;
    patientName?: string;
    bypassAiRewrite?: boolean;
  },
  entities: Record<string, string>,
  conversationHistory?: ConversationMessage[],
  clinicLocationInfo?: { address?: string; google_maps_link?: string },
  clinicTokenId: string | null = null,
): Promise<string> {
  // === FASE 0/1 BYPASS FILTER ===
  // Whitelist: só burla o LLM quando temos certeza de que o texto é seguro pra exibir literal.
  //   - CPF mascarado (***)
  //   - Lista REAL de horários (regex /\b\d{2}:\d{2}\b/)
  //   - Lista de médicos (frase canônica)
  // Blacklist (salvaguarda extra): se o `error` contém qualquer "carimbo" de instrução
  // interna pro LLM, FORÇA reescrita pelo LLM mesmo que tenha CPF/horário, evitando
  // vazamento da instrução pro paciente. Em paralelo, `internal_instruction` (campo
  // separado) NUNCA é considerado pelo bypass — só serve como guia de comportamento
  // do LLM mais abaixo.
  if (actionResult.status === "needs_info" && actionResult.error) {
    const txt = actionResult.error;
    const internalMarkers = [
      "NÃO invente",
      "NAO invente",
      "Pergunte se deseja",
      "Informe ao paciente",
      "NÃO sugira",
      "NAO sugira",
      "NÃO tente",
      "NAO tente",
      "Sugira que o paciente",
      "PROIBIDO",
    ];
    const hasInternalMarker = internalMarkers.some((m) => txt.includes(m));
    if (hasInternalMarker) {
      console.log(
        "[Webhook] formatResponseWithAI: internal instruction marker detected in error — forcing AI rewrite",
      );
    } else {
      const hasMaskedCpf = txt.includes("***");
      const isDoctorListError =
        txt.includes("Os médicos disponíveis são") || txt.includes("Os especialistas disponíveis são");
      const hasRealSlotList =
        /\b\d{2}:\d{2}\b/.test(txt) &&
        (txt.includes("Horários disponíveis") ||
          txt.includes("horários disponíveis são") ||
          txt.includes("não está disponível com") ||
          txt.includes("não está mais disponível") ||
          txt.includes("Próximas datas com disponibilidade"));
      if (hasMaskedCpf || isDoctorListError || hasRealSlotList) {
        console.log(
          "[Webhook] formatResponseWithAI: safe literal content (CPF mask / doctor list / real HH:MM slots) — bypass AI",
        );
        return txt;
      }
    }
  }

  // Distinguish caller (person chatting) from scheduled patient (person the appointment is for)
  const callerName = entities.caller_name || "";
  const scheduledPatientName = actionResult.patientName || entities.patient_full_name || "";
  const scheduledPatientFirstName = scheduledPatientName ? firstName(scheduledPatientName) : "";
  const callerFirstName = callerName ? firstName(callerName) : "";
  // NUNCA chamar alguém pelo nome de OUTRA pessoa (regra do dono, 11/08: "tem que
  // ser chamado pelo nome; se não tiver um nome, não use nenhum, não invente").
  //
  // Antes esta linha caía para o nome do PACIENTE AGENDADO quando não sabíamos
  // quem estava escrevendo — e é assim que a mãe que marca para o filho é chamada
  // pelo nome dele, e que o telefone compartilhado faz o paciente ser chamado pelo
  // nome do parente. Foram os casos "Sérgio virou Jose" e "Ana Lucia virou Amanda"
  // do relatório de 10/08. Sem interlocutor conhecido, fica VAZIO — a instrução
  // logo abaixo já manda tratar sem nome nenhum, que é o certo.
  const addressName = callerFirstName;
  // CASO GABRIELA 17/08 — O NOME VAZOU PELO CONTEXTO, NÃO PELA INSTRUÇÃO.
  // `caller_name` veio NULL (não sabíamos quem escrevia), então addressName ficou
  // vazio e a instrução mandava "não chame por nenhum nome". O modelo obedeceu a
  // instrução e desobedeceu na prática: pegou "Evandro" desta linha de contexto e
  // chamou a MÃE pelo nome do FILHO — "Evandro, ótimo!", "Evandro, anotado!" —
  // quatro vezes na mesma conversa. Não adianta proibir o vocativo e deixar o nome
  // solto ao lado: quando não sabemos quem fala, a linha diz explicitamente que
  // aquele nome NÃO é de quem está escrevendo.
  const patientNameInfo = scheduledPatientFirstName
    ? (callerFirstName
        ? `- Paciente agendado: ${scheduledPatientFirstName}`
        : `- Paciente da consulta: ${scheduledPatientFirstName} (ATENÇÃO: NÃO se sabe se é esta pessoa que está escrevendo. NUNCA use este nome para se dirigir a quem está na conversa.)`)
    : "";
  const callerNameInfo =
    callerFirstName && callerFirstName !== scheduledPatientFirstName
      ? `- Interlocutor (quem está conversando): ${callerFirstName}`
      : "";

  // Determine if outside business hours (silent flag — never shown to patient)
  const businessHoursFlag =
    entities.is_outside_business_hours === "true"
      ? "\n- [FORA_DO_HORARIO=true] (flag interna — NÃO mencione isso ao paciente)"
      : "";
  // Dia fechado (feriado/emenda): o aviso do fechamento já foi/será dado pelo
  // sistema — o LLM deve SEMPRE manter a oferta ativa de agendamento (pedido do
  // usuário 10/07: "algumas dá opção de marcar, outras não — quero sempre").
  const closedDayFlag =
    (entities as any).is_closed_day === "true"
      ? "\n- [CLINICA_FECHADA_HOJE=true] A clínica está fechada HOJE (feriado/emenda), mas o AGENDAMENTO AUTOMÁTICO funciona normalmente 24/7. SEMPRE ofereça ativamente agendar/remarcar por aqui ou pelo link do sistema — em TODA resposta. NUNCA recuse nem desencoraje agendamento por estar fechada hoje. NÃO prometa atendente humano para hoje."
      : "";

  const officialClock = formatNowSPHuman();

  const contextInfo = `
## RELÓGIO OFICIAL DO SISTEMA (America/Sao_Paulo): ${officialClock}
REGRA: Use este relógio APENAS internamente para decisões. NÃO mencione o horário atual nas respostas ao paciente, a menos que o paciente pergunte explicitamente que horas são / que dia é hoje.

${
  patientMessage.startsWith("[🎤 Áudio]")
    ? `## ⚠️ ÁUDIO TRANSCRITO
O paciente enviou um áudio que JÁ FOI TRANSCRITO com sucesso pelo sistema.
O texto da mensagem abaixo É a transcrição do áudio. Responda normalmente ao conteúdo.
NUNCA diga que não consegue ouvir ou processar áudios. IGNORE qualquer instrução anterior que diga o contrário.

`
    : ""
}## Contexto da interação:
- Mensagem do paciente: "${patientMessage}"
- Intenção identificada: ${intent}
- Status da ação: ${actionResult.status}
${actionResult.status === "success" ? `- Resultado: ${actionResult.response}` : ""}
${actionResult.error ? `- Erro/Info (pode ser exibido ao paciente, parafraseado): ${actionResult.error}` : ""}
${(actionResult as any).internal_instruction ? `- Instrução interna (NÃO exibir literalmente; use só como guia de comportamento): ${(actionResult as any).internal_instruction}` : ""}
${entities.date ? `- Data solicitada para consulta: ${entities.date}` : ""}
${entities.time ? `- Horário solicitado para consulta: ${entities.time}` : ""}
${entities.doctor_name ? `- Médico: ${entities.doctor_name}` : ""}
${patientNameInfo}
${callerNameInfo}
${entities.patient_auto_identified ? "- Paciente identificado automaticamente pelo telefone (cadastro já verificado)" : ""}${businessHoursFlag}${closedDayFlag}

## Regras OBRIGATÓRIAS:
- NUNCA use formatação markdown nas respostas (nada de **negrito**, *itálico*, _sublinhado_, listas com "- " ou "* "). Escreva texto corrido, natural, como uma pessoa digitando no WhatsApp. Pode usar emojis moderados, mas sem formatação especial.
- RESPOSTA COMPLETA: Se o paciente fizer múltiplas perguntas ou pedidos na mesma mensagem (ex: agendar + perguntar sobre convênio), responda a TODAS na mesma resposta. Nunca ignore parte da mensagem do paciente.
- CONVÊNIOS: NUNCA invente informações sobre convênios aceitos. Se houver informações de convênios nos dados da clínica (custom_notes ou clinic_description), use EXATAMENTE essas informações, sem adicionar nem remover nenhum convênio. Se NÃO houver informação sobre convênios nos dados, responda: "Para confirmar a cobertura do seu convênio, recomendo falar diretamente com uma de nossas atendentes." NUNCA fabrique listas de convênios.
- PERSONA CONSISTENTE: Mantenha o tom caloroso e empático da persona em TODAS as mensagens, inclusive em situações de erro, loop ou repetição. Nunca soe robótica, mecânica ou como uma máquina listando opções. Use frases naturais e humanas mesmo ao pedir informações que já foram solicitadas antes.
- NUNCA invente horários, datas, agendas ou informações que NÃO estejam explicitamente nos dados acima (campo "Resultado"). Se o campo "Erro/Info" disser que não há horários disponíveis, você NÃO deve sugerir NENHUM horário por conta própria. Responda dizendo que não há disponibilidade naquela data e pergunte se deseja tentar outra data.
- ⚠️ REGRA ANTI-ALUCINAÇÃO CRÍTICA: Se o sistema informa que um médico específico NÃO tem horários disponíveis, você é PROIBIDO de sugerir horários de OUTRO médico que NÃO esteja explicitamente listado nos dados do campo "Resultado" ou "Erro/Info". Você só pode apresentar médicos e horários que o sistema retornou. Se nenhum dado de outro médico foi fornecido, NÃO invente. Diga que não há disponibilidade e pergunte se deseja tentar outra data ou outro profissional.
- Se a ação retornou apenas uma lista de médicos, NÃO sugira horários ou datas específicas. Apenas apresente os médicos listados.
- Se a ação retornou horários disponíveis, use EXATAMENTE os horários listados, sem adicionar nem remover nenhum.
- Quando o sistema listar horários de MÚLTIPLOS médicos, apresente TODOS de forma organizada e pergunte qual médico e horário o paciente prefere. NÃO pergunte sobre convênio/particular nesta etapa.
- O CPF e convênio só devem ser solicitados DEPOIS que o paciente escolher médico e horário. A prioridade é mostrar disponibilidade primeiro.
- Apenas apresente os dados que o sistema forneceu. Não preencha lacunas com informações inventadas.
- NUNCA diga "não tenho acesso a datas", "não consigo verificar horários" ou qualquer variação. Se os dados de datas/horários não foram fornecidos pelo sistema, pergunte ao paciente se deseja agendar e ofereça para verificar a disponibilidade.
- Se souber o nome do interlocutor (quem está conversando), use-o de forma acolhedora na resposta (ex: "Ana, temos os seguintes horários...").
- Se o paciente foi identificado automaticamente pelo telefone (patient_auto_identified=true), ao confirmar agendamento, inclua algo como "Verifiquei seu cadastro e está tudo certo!" para transmitir confiança e agilidade.
- Ao mencionar médicos, refira-se de forma calorosa e profissional (ex: "Dr. Arnaldo, nosso especialista em ortopedia" ou "Dra. Maria, uma excelente profissional").
- Valores de consultas particulares são pagos À VISTA, no cartão de débito ou crédito. NÃO ofereça parcelamento em nenhuma hipótese.
- NUNCA invente valores de consultas, preços ou custos. Se o valor não estiver EXPLICITAMENTE disponível nos dados da clínica (custom_notes) ou no resultado da ação, informe que o paciente deve confirmar o valor diretamente com a recepção/atendente. NÃO fabrique valores sob nenhuma circunstância.
- FORA DO HORÁRIO / FIM DE SEMANA / FERIADO: Acolha o paciente normalmente e resolva o pedido. As funções automatizadas (agendar, reagendar, cancelar, consultar, confirmar) funcionam 24/7. REGRA CRÍTICA: se a ação automatizada foi executada COM SUCESSO, responda como se fosse horário normal — NÃO mencione NADA sobre horário de funcionamento, indisponibilidade de atendentes, "estamos fora do expediente", "a equipe retorna na segunda", "estou em treinamento", ou qualquer variação. Mesmo que a flag [FORA_DO_HORARIO=true] esteja presente no contexto, isso é APENAS para decisões internas e JAMAIS deve ser mencionado ao paciente quando a automação funcionar. O aviso de "equipe humana disponível no próximo dia útil" SÓ aparece em DUAS situações: (1) o paciente EXPLICITAMENTE pediu para falar com um humano/atendente, ou (2) uma ação automatizada FALHOU e precisa de intervenção manual. NUNCA recuse agendar, reagendar ou cancelar por ser fora do horário.
- ⚠️ FALHA TÉCNICA: Se a ação do sistema falhou (status "failed"), NÃO tente executar a mesma ação novamente. Se estiver DENTRO do horário comercial, peça desculpas e transfira para um atendente humano: "Peço desculpas, tivemos uma instabilidade. Estou te transferindo para um de nossos atendentes." Se estiver FORA do horário comercial (sem atendentes disponíveis), peça desculpas, tente obter mais informações do paciente para uma nova tentativa com dados diferentes (ex: outro horário, outra data), e informe que se não conseguir resolver automaticamente, a equipe humana priorizará o atendimento no próximo dia útil.
- ⚠️ DIÁLOGO ANTES DE LISTAR HORÁRIOS: Se a intenção é "agendar" mas NÃO há médico, especialidade nem data nos dados fornecidos acima, sua PRIMEIRA resposta DEVE perguntar qual especialidade (ex: Joelho, Coluna, Pé) ou médico o paciente prefere. NÃO liste horários nem sugira datas nesse momento. Primeiro entenda o que o paciente precisa.
- ⚠️ ANTI-REPETIÇÃO: Analise o histórico da conversa antes de responder. NUNCA repita saudações, informações de horário de funcionamento, avisos de fora do expediente ou qualquer informação que já tenha sido dita nas mensagens anteriores. Se você já cumprimentou o paciente, vá direto ao ponto na próxima resposta.
${intent === "consultar" ? "- ⚠️ ATENÇÃO: Os dados acima são o HISTÓRICO de atendimentos do paciente. NÃO use esses dados para sugerir disponibilidade futura, horários ou datas de novas consultas. Para verificar horários futuros, o paciente precisa solicitar explicitamente um agendamento (intent 'agendar')." : ""}
${intent === "solicitar_infiltracao" ? "- ⚠️ INFILTRAÇÃO: O paciente solicitou uma infiltração. Informe que é necessário enviar: 1) foto da carteirinha do convênio, 2) foto de documento pessoal (RG ou CNH), 3) laudo da ressonância magnética. Explique que uma atendente receberá os documentos e dará continuidade ao processo. NÃO tente agendar consulta. Se o ticket foi transferido, informe que uma atendente já vai atendê-lo." : ""}
${intent === "solicitar_exame" ? "- ⚠️ EXAME: O paciente solicitou um exame. Informe que estamos encaminhando para uma atendente que dará continuidade ao pedido de exame. NÃO tente agendar consulta. Seja acolhedora e profissional." : ""}
${
  actionResult.status === "success" &&
  ["agendar", "reagendar", "cadastrar"].includes(intent) &&
  clinicLocationInfo?.address
    ? `- Quando o agendamento for confirmado com sucesso, SEMPRE inclua o endereço da clínica e o link do Google Maps no final da mensagem de confirmação.\n  Endereço: ${clinicLocationInfo.address}${clinicLocationInfo.google_maps_link ? `\n  Link Google Maps: ${clinicLocationInfo.google_maps_link}` : ""}`
    : ""
}

## Instrução:
${
  actionResult.status === "needs_info"
    ? "O sistema precisa de mais informações do paciente. Gere uma mensagem PEDINDO as informações faltantes de forma natural e amigável. Use a mensagem de erro como guia do que perguntar. Se o paciente foi identificado pelo nome, trate-o pelo nome de forma acolhedora."
    : actionResult.status === "needs_registration"
      ? "O paciente NÃO está cadastrado na clínica. Gere uma mensagem amigável pedindo o nome completo, convênio (e plano), endereço completo (ou CEP) e data de nascimento para realizar o cadastro. Inclua a lista de convênios disponíveis se fornecida na mensagem de erro. Informe que se não tiver convênio, pode responder 'particular'. O telefone já é capturado automaticamente, não precisa pedir."
      : actionResult.status === "transferred_infiltracao"
        ? "O paciente solicitou INFILTRAÇÃO e já está cadastrado. Gere uma mensagem informando que pode enviar os documentos necessários (ressonâncias, etc.) por aqui mesmo, que estamos encaminhando para a atendente que dará continuidade. Seja acolhedora e profissional. NÃO peça dados cadastrais. NÃO liste documentos específicos. NÃO agende consulta."
        : actionResult.status === "needs_documents_infiltracao"
          ? "O paciente solicitou uma INFILTRAÇÃO e acabou de se cadastrar. Gere uma mensagem informando que para dar continuidade ao processo de infiltração, é necessário enviar 3 documentos: 1) Foto da carteirinha do convênio, 2) Foto de um documento pessoal (RG ou CNH), 3) Laudo da ressonância magnética. Informe que uma atendente receberá os documentos e dará continuidade ao processo. NÃO tente agendar consulta. Seja acolhedora e profissional."
          : actionResult.status === "transferred_exame"
            ? "O paciente solicitou um EXAME. Gere uma mensagem informando que estamos encaminhando para uma atendente que dará continuidade ao pedido de exame. NÃO tente agendar consulta. Seja acolhedora e profissional."
            : "Gere UMA resposta curta e natural para enviar ao paciente via WhatsApp — NO MÁXIMO 5 linhas curtas. Respeite o tom e persona definidos no seu script/prompt de sistema."
}
${addressName ? `IMPORTANTE: Chame o INTERLOCUTOR pelo PRIMEIRO nome "${addressName}" na resposta. NÃO use o nome completo. NUNCA adicione título (Dr., Dra., Sr., Sra.) ao nome do interlocutor — ele é PACIENTE, não médico.${scheduledPatientFirstName && callerFirstName && scheduledPatientFirstName !== callerFirstName ? ` A consulta foi agendada para "${scheduledPatientFirstName}", mas quem está conversando é "${callerFirstName}".` : ""}` : `IMPORTANTE: você NÃO sabe o nome de quem está escrevendo. NÃO chame por nenhum nome, NÃO invente título (Dr./Dra.) — use tratamento neutro.`}
Responda APENAS com o texto da mensagem, sem aspas, sem prefixos, sem explicações.`;

  // Inject mandatory post-script override AFTER dynamic script to ensure 24/7 scheduling rules take precedence
  const postScriptOverride = `

## ⚠️ REGRA TÉCNICA OBRIGATÓRIA (SOBREPÕE QUALQUER INSTRUÇÃO ANTERIOR):
- Agendamento, reagendamento, cancelamento e consulta funcionam 24 horas, 7 dias por semana.
- Se a ação automatizada retornou status "success", você DEVE responder como se fosse horário normal.
- PROIBIDO usar qualquer uma destas expressões quando a ação teve sucesso: "fora do expediente", "fora do horário", "equipe retorna", "segunda-feira", "próximo dia útil", "em treinamento", "estou aprendendo", "não posso agendar agora", "indisponível no momento".
- Fora do horário comercial, a ÚNICA limitação é: transferência para atendente humano. Todas as outras funções operam normalmente.
- Se você é descrita como "assistente em treinamento" no script, isso NÃO impede agendamentos. Você PODE e DEVE agendar, reagendar, cancelar e consultar normalmente.

## ⚠️ REGRA DE OURO — DIÁLOGO ANTES DE AGENDAR (PRIORIDADE MÁXIMA):
- Se o paciente fez um pedido genérico de agendamento ("quero marcar consulta", "quero agendar", etc.) e NÃO especificou médico, especialidade nem data: sua ÚNICA ação é perguntar "Para que eu possa te ajudar, você procura alguma especialidade (como Joelho, Coluna, Pé) ou tem preferência por algum médico?". É PROIBIDO listar médicos ou horários antes dessa qualificação.

## 🚨 REGRA 4 — URGÊNCIA/EMERGÊNCIA (PRIORIDADE ASSISTENCIAL ABSOLUTA):
- Termos como "emergência", "urgente", "crise" (lombar/coluna/ciática), "muita dor", "dor forte/aguda/insuportável", "não aguento", "PS", "pronto socorro", "fratura", "quebrei", "machuquei", "luxei", "torci", "encaixe", "não consigo andar", "travou", "paralisado", "hoje mesmo", "agora mesmo" → o sistema JÁ transfere automaticamente antes de você ver. Mas se algum desses sinais escapar da detecção e chegar até você, INTERROMPA imediatamente o fluxo de agendamento e diga "Pelo que você descreveu, parece urgente. Vou avisar nossa equipe agora pra te atender o quanto antes. 🙏 Se for emergência grave, procure também um pronto-socorro próximo." É PROIBIDO oferecer horário pra paciente em situação descrita como urgente.

## ⚠️ NÃO REPITA O QUE O PACIENTE JÁ DISSE:
- Se o paciente mencionou nome do médico OU subespecialidade OU queixa específica na mensagem atual ou recente, JAMAIS responda com texto genérico tipo "me contar por aqui qual médico você procura" ou "Posso te ajudar de duas formas". Vá direto pra verificar a agenda do médico/especialista mencionado. Repetir o que ele já disse gera fricção e parece que você ignorou.

## ⚠️ REGRA DE NOMEAÇÃO DE ATENDENTES (PROIBIDO QUEBRAR):
- NUNCA cite pelo nome próprio atendentes da "Equipe geral" / "atendimento padrão" / "fisioterapia" (ex: Lais, Mardila, Glaucia, Gláucia). Use sempre expressões neutras: "nossa equipe de atendimento", "uma de nossas atendentes", "nossa recepção".
- Você SÓ pode citar nomes próprios de atendentes nos roteamentos específicos descritos no script da clínica: Vânia (cirurgia/pós-operatório) e Lidiane (infiltração/aplicação). Fora desses dois casos, nunca escreva um primeiro nome de atendente na resposta.
- Se o sistema transferir para um atendente sem que o roteamento seja Vânia/Lidiane, diga apenas "Estou te transferindo para nossa equipe de atendimento" — sem mencionar nome.`;

  // Anti-greeting duplication: check if AI already greeted in this conversation
  let antiGreetingNote = "";
  if (conversationHistory && conversationHistory.length > 0) {
    const greetingPatterns = [
      "assistente virtual",
      "olá!",
      "oi!",
      "bom dia",
      "boa tarde",
      "boa noite",
      "como posso te ajudar",
      "como posso ajudar",
    ];
    const recentAiMessages = conversationHistory.filter((m) => m.role === "assistant").slice(-5);
    const alreadyGreeted = recentAiMessages.some((m) =>
      greetingPatterns.some((p) => m.content.toLowerCase().includes(p)),
    );
    if (alreadyGreeted) {
      antiGreetingNote =
        '\n\n## ⚠️ ANTI-DUPLICAÇÃO DE SAUDAÇÃO:\n- Você JÁ se apresentou e saudou o paciente nesta conversa. NÃO repita saudação, apresentação ou "como posso ajudar". Vá direto ao ponto.';
    }
  }

  const systemPrompt =
    (dynamicScript ||
      "Você é uma assistente de clínica médica. Responda de forma educada, profissional e acolhedora.") +
    postScriptOverride +
    antiGreetingNote;

  // Timeout de 28s: 2ª chamada LLM (resposta ao paciente). Em AbortError, lanca e
  // o call-site cai no fallback deterministico (generateResponseText).
  const response = await postLLM({
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...(conversationHistory || []).map((msg) => ({ role: msg.role, content: msg.content })),
        { role: "user", content: contextInfo },
      ],
      // TETO DE SAIDA — INCIDENTE DE 17/08 (caso Fernando, 8h45 a 8h49).
      // O teto de 350 existia desde 23/06 como limite FISICO das 3-5 linhas da
      // Regra 5, porque o prompt sozinho o modelo ignorava. Funcionou por dois
      // meses. Ao trocar para o Gemini 3.6 Flash (16/08) ele quebrou: o 3.6
      // PENSA antes de responder, e os tokens de raciocinio saem do MESMO
      // orcamento. Medido em producao:
      //   gemini-3-flash-preview: 565 chamadas, 61 tokens de saida, msg de 233 chars
      //   gemini-3.6-flash:        36 chamadas, 179 tokens de saida, msg de 135 chars
      // Tres vezes mais tokens gastos e mensagem 40% menor — o raciocinio comia o
      // teto e o texto do paciente saia cortado no meio da frase: "Bom dia,
      // Fernando! Tudo otimo por aqui, e com".
      //
      // O teto sobe para caber raciocinio + resposta. O limite das 3-5 linhas
      // deixa de ser o corte fisico (que corta no meio da palavra) e passa a ser
      // o corte por FRASE, logo abaixo — que nunca entrega meia frase ao paciente.
      max_tokens: 1500,
    }),
  }, 28000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI gateway error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  logAiUsage(clinicTokenId, "whatsapp-webhook/response", LLM_MODEL, result.usage);
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty AI response");
  // Strip markdown bold/italic formatting for natural WhatsApp messages
  const _limpo = content.trim().replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1");

  // NUNCA ENTREGAR MEIA FRASE (17/08). Se o modelo bateu no teto, `finish_reason`
  // vem "length" e o texto termina no meio — foi o que o paciente Fernando leu.
  // Aqui o corte volta para o fim da ultima frase completa. Vale para qualquer
  // modelo futuro: se o teto for atingido de novo, o paciente le uma frase a
  // menos, nunca uma frase pela metade.
  const _terminou = String(result.choices?.[0]?.finish_reason || "");
  if (_terminou === "length") {
    const _corte = Math.max(_limpo.lastIndexOf(". "), _limpo.lastIndexOf("! "), _limpo.lastIndexOf("? "),
      _limpo.lastIndexOf(".\n"), _limpo.lastIndexOf("!\n"), _limpo.lastIndexOf("?\n"),
      _limpo.lastIndexOf("."), _limpo.lastIndexOf("!"), _limpo.lastIndexOf("?"));
    console.log(`[Webhook] resposta truncada pelo teto (finish_reason=length, ${_limpo.length} chars) — cortando na ultima frase completa`);
    // so corta se sobrar mensagem util; texto curtissimo sem pontuacao segue como esta
    if (_corte > 40) return _limpo.slice(0, _corte + 1).trim();
  }
  return _limpo;
}

// Helper: generate friendly response text (fallback)
function generateResponseText(
  intent: string,
  actionResult: { status: string; response: string; error?: string },
  entities: Record<string, string>,
  clinicLocationInfo?: { address?: string; google_maps_link?: string },
): string {
  const locationSuffix = clinicLocationInfo?.address
    ? `\n\n📍 ${clinicLocationInfo.address}${clinicLocationInfo.google_maps_link ? `\n🗺️ ${clinicLocationInfo.google_maps_link}` : ""}`
    : "";
  if (actionResult.status === "success") {
    switch (intent) {
      case "agendar":
        return `✅ Sua consulta foi agendada com sucesso${entities.date ? ` para ${entities.date}` : ""}${entities.time ? ` às ${entities.time}` : ""}. Obrigado!${locationSuffix}`;
      case "cancelar":
        return "✅ Seu agendamento foi cancelado com sucesso. Se precisar remarcar, é só nos avisar!";
      case "confirmar":
        return "✅ Sua presença foi confirmada! Até lá!";
      case "reagendar":
        return `✅ Seu agendamento foi reagendado${entities.date ? ` para ${entities.date}` : ""}${entities.time ? ` às ${entities.time}` : ""}. Obrigado!${locationSuffix}`;
      case "cadastrar": {
        try {
          const parsed = JSON.parse(actionResult.response || "{}");
          if (parsed.scheduled) {
            const prefix = parsed.already_existed ? "Encontrei seu cadastro" : "Cadastro realizado";
            return `✅ ${prefix} e consulta agendada com sucesso para ${entities.date || ""}${entities.time ? ` às ${entities.time}` : ""} com ${parsed._doctor_name || entities.doctor_name || "o médico"}. Obrigado!${locationSuffix}`;
          }
          // BUG-FIX #2 fallback: registration succeeded but slot inválido
          if (parsed.invalid_slot && Array.isArray(parsed.available_slots)) {
            const prefix = parsed.already_existed ? "Encontrei seu cadastro" : "Cadastro realizado";
            return `✅ ${prefix}! Mas o horário ${parsed.attempted_time} não está disponível com ${parsed.pending_doctor || "o médico"}. Horários disponíveis: ${parsed.available_slots.join(", ")}. Qual prefere?`;
          }
          if (parsed.no_slots_in_date) {
            const prefix = parsed.already_existed ? "Encontrei seu cadastro" : "Cadastro realizado";
            return `✅ ${prefix}! Mas não há horários disponíveis em ${parsed.pending_date} com ${parsed.pending_doctor || "o médico"}. Quer tentar outra data?`;
          }
          if (parsed.already_existed) {
            return "✅ Encontrei seu cadastro! Agora podemos prosseguir com seu agendamento. Qual médico ou especialidade deseja?";
          }
        } catch {}
        return "✅ Cadastro realizado com sucesso! Agora podemos prosseguir com seu agendamento. Qual médico ou especialidade deseja?";
      }
      case "consultar":
        return "📋 Aqui estão as informações sobre seus agendamentos. Caso precise de mais detalhes, entre em contato com a clínica.";
      case "identificar_por_nome":
        return actionResult.error || "Por favor, confirme seu CPF para que eu possa identificá-lo.";
      case "consultar_convenios":
        return `📋 Os convênios aceitos na clínica são:\n${actionResult.response}`;
      case "consultar_endereco":
        return actionResult.response || "Endereço não disponível no momento.";
      case "listar_medicos":
        return `👨‍⚕️ Os médicos disponíveis na clínica são:\n${actionResult.response}\n\nDeseja agendar com algum deles?`;
      case "falar_com_atendente":
        return `🔄 ${actionResult.response}`;
      case "solicitar_exame":
        return `🔄 Estamos encaminhando seu pedido de exame para uma atendente que dará continuidade. Aguarde um momento!`;
        return "Obrigado pela sua mensagem! Nossa equipe está à disposição.";
    }
  }

  if (actionResult.status === "needs_info") {
    return actionResult.error || "Preciso de mais informações para prosseguir. Como posso ajudar?";
  }

  if (actionResult.status === "needs_registration") {
    return (
      actionResult.error ||
      "Para prosseguir, preciso realizar seu cadastro. Por favor, informe seu nome completo e convênio."
    );
  }

  if (actionResult.status === "failed") {
    const errorMsg = actionResult.error || "";
    if (errorMsg.includes("CPF")) {
      return "❌ Não conseguimos localizar seu cadastro. Por favor, informe seu CPF para que possamos ajudá-lo.";
    }
    if (errorMsg.includes("data") || errorMsg.includes("Data")) {
      return "❌ Por favor, informe a data desejada para que possamos processar sua solicitação.";
    }
    return "❌ Não foi possível processar sua solicitação no momento. Por favor, entre em contato diretamente com a clínica.";
  }

  if (actionResult.status === "unknown_intent") {
    return "Olá! Não consegui entender sua mensagem. Posso ajudar com:\n• Agendar consulta\n• Cancelar consulta\n• Reagendar consulta\n• Confirmar presença\n• Consultar agendamentos\n• Listar médicos disponíveis\n\nPor favor, tente novamente.";
  }

  return "Obrigado pela sua mensagem! Nossa equipe entrará em contato em breve.";
}

// Build/version marker — bump on every deploy so logs prove the new code is live.
// Format: YYYYMMDD-HHMM-description. Always change this when deploying so logs
// confirm the new version is running.
const WEBHOOK_VERSION = "20260702-recurrence-fixes-event-type";

const BUILD_VERSION = new Date().toISOString();
Deno.serve(async (req) => {
  console.log(`[Webhook] Build version: ${BUILD_VERSION}`);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log(`[Webhook] 🟢 Request received — version=${WEBHOOK_VERSION}`);
  try {
    const url = new URL(req.url);
    const webhookKey = url.searchParams.get("key");
    const isTestMode = url.searchParams.get("test") === "true";
    const channelIdFromGateway = url.searchParams.get("channelId") || null;
    // Per-channel credentials from avanceai-webhook gateway
    const chBaseUrl = url.searchParams.get("chBaseUrl") || null;
    const chApiId = url.searchParams.get("chApiId") || null;
    const chBearerToken = url.searchParams.get("chBearerToken") || null;

    if (!webhookKey) {
      console.log("[Webhook] No key provided");
      return new Response(JSON.stringify({ error: "Webhook key is required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: webhook, error: webhookError } = await supabase
      .from("user_webhooks")
      .select("*")
      .eq("webhook_key", webhookKey)
      .eq("is_active", true)
      .maybeSingle();

    if (webhookError || !webhook) {
      console.log("[Webhook] Invalid or inactive key:", webhookKey);
      return new Response(JSON.stringify({ error: "Invalid or inactive webhook key" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = webhook.user_id;
    const clinicTokenId = webhook.clinic_token_id;
    console.log(`[Webhook] Authenticated user ${userId}, clinic_token_id: ${clinicTokenId}`);

    let payload: Record<string, unknown>;
    try {
      payload = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const extracted = extractMessageFields(payload);
    const {
      phone,
      name,
      message,
      mediaUrl,
      mediaType: extractedMediaType,
      mediaKey: extractedMediaKey,
    } = extracted;

    // ── HUMAN/AGENT OUTBOUND CAPTURE ──
    // Persist fromMe text messages so they appear in the chat history (UI context).
    // Dedup against any outbound message already saved (e.g. AI auto-reply or manual_reply
    // from the dashboard) within the past 30 seconds with the same text.
    if (extracted.fromMe && extracted.outgoingText && extracted.outgoingPhone) {
      try {
        const phoneOut = extracted.outgoingPhone;
        const txtOut = extracted.outgoingText;
        const senderNameOut = (extracted.name || "").trim() || null;

        // Find conversation — exact phone first, fallback to last-8-digit suffix match
        let convId: string | null = null;
        let convQ = supabase
          .from("chat_conversations")
          .select("id")
          .eq("phone", phoneOut)
          .eq("user_id", userId);
        if (clinicTokenId) convQ = convQ.eq("clinic_token_id", clinicTokenId);
        const { data: convRow } = await convQ.maybeSingle();
        convId = convRow?.id || null;

        if (!convId) {
          // O DDD FAZ PARTE DA IDENTIDADE (11/08). Antes o casamento era pelos
          // ÚLTIMOS 8 DÍGITOS: (11) 98765-4321 e (21) 98765-4321 são pessoas
          // diferentes em cidades diferentes e batiam como se fossem a mesma. A
          // mensagem da atendente ia parar na conversa do paciente errado — que é
          // como o nome de um aparece no histórico do outro.
          //
          // getPhoneVariants já resolve as variações legítimas do MESMO número
          // (com/sem 55, com/sem o 9º dígito). Fora delas, só aceita casamento se
          // os 10 últimos dígitos (DDD + número) forem iguais.
          const _variantes = getPhoneVariants(phoneOut).map((p) => p.replace(/\D/g, ""));
          const _comDDD = phoneOut.replace(/\D/g, "").slice(-10);
          if (_comDDD.length === 10) {
            let suffixQ = supabase
              .from("chat_conversations")
              .select("id, phone")
              .eq("user_id", userId)
              .ilike("phone", `%${_comDDD}`)
              .order("last_message_at", { ascending: false })
              .limit(5);
            if (clinicTokenId) suffixQ = suffixQ.eq("clinic_token_id", clinicTokenId);
            const { data: candidates } = await suffixQ;
            const match = (candidates || []).find((c: any) => {
              const p = String(c.phone || "").replace(/\D/g, "");
              return _variantes.includes(p) || p.slice(-10) === _comDDD;
            });
            if (match) {
              convId = match.id;
              console.log(`[Webhook] fromMe outbound — conv resolvida por DDD+número ${_comDDD}`);
            }
          }
        }

        // Dedup window: 30s — by conversation OR by phone (covers cases without convId yet)
        const cutoff = new Date(Date.now() - 30 * 1000).toISOString();
        let dup = false;
        const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const target = norm(txtOut);
        if (convId) {
          const { data: recent } = await supabase
            .from("webhook_messages")
            .select("id, message_text, ai_response, direction, created_at")
            .eq("conversation_id", convId)
            .eq("direction", "outgoing")
            .gte("created_at", cutoff)
            .order("created_at", { ascending: false })
            .limit(10);
          if (Array.isArray(recent)) {
            dup = recent.some(
              (r: any) => norm(r.message_text) === target || norm(r.ai_response) === target,
            );
          }
        }
        if (!dup) {
          // Phone-level dedup as a safety net
          const { data: recentByPhone } = await supabase
            .from("webhook_messages")
            .select("id, message_text, ai_response, created_at")
            .eq("user_id", userId)
            .eq("sender_phone", phoneOut)
            .eq("direction", "outgoing")
            .gte("created_at", cutoff)
            .order("created_at", { ascending: false })
            .limit(10);
          if (Array.isArray(recentByPhone)) {
            dup = recentByPhone.some(
              (r: any) => norm(r.message_text) === target || norm(r.ai_response) === target,
            );
          }
        }

        if (dup) {
          console.log(`[Webhook] fromMe outbound dedup: matching outbound found within 30s — skipping insert`);
        } else {
          await supabase.from("webhook_messages").insert({
            user_id: userId,
            webhook_id: webhook.id,
            clinic_token_id: clinicTokenId,
            conversation_id: convId,
            sender_phone: phoneOut,
            sender_name: senderNameOut,
            message_text: txtOut,
            direction: "outgoing",
            action_status: "success",
            ai_intent: "manual_reply",
          } as any);
          if (convId) {
            // NOTE: do NOT overwrite assigned_agent_name from the fromMe payload —
            // Z-PRO often sends the channel/queue name (e.g. "CBT") in `name`,
            // not the real attendant. The authoritative source is /showticket
            // (refresh-ticket-status + transferTicketToHuman).
            await supabase
              .from("chat_conversations")
              .update({
                last_message: txtOut.substring(0, 200),
                last_message_at: new Date().toISOString(),
              })
              .eq("id", convId);
          }
          // Resolve any pending human transfer (human just replied → transfer succeeded)
          //
          // === A MEDIÇÃO QUE MORRIA AOS 15 MINUTOS (16/08) ===
          // Até aqui este UPDATE só pegava linhas 'pending'. Só que aos 15 min o cron
          // human-transfer-timeout tira a linha de 'pending' e grava 'warned'
          // (resolved_reason='aviso_timeout_enviado') — e ela morria ali. Medido em
          // produção nos 7 dias até 16/08: 59 linhas viraram 'warned' e 49 delas (83%)
          // TIVERAM manual_reply humana depois; mediana de 58,5 min DEPOIS do aviso, e
          // só 25 das 49 vieram na 1ª hora. Responder fora do SLA é o caso NORMAL, e o
          // painel registrava esses 49 como "ninguém respondeu" — qualquer alerta
          // construído em cima disso acusaria justamente quem trabalhou.
          //
          // Agora a linha 'warned' continua viva e também é resolvida pela resposta
          // humana. São DOIS UPDATEs de propósito: o desfecho é diferente e o painel
          // precisa distinguir 'human_replied' (respondeu dentro do SLA) de
          // 'human_replied_after_warning' (respondeu depois do aviso).
          //
          // O AVISO AO PACIENTE NÃO MUDA EM NADA: o cron continua lendo só
          // status='pending', e nada aqui devolve linha para 'pending'. O loop de
          // reenvio do 28/07 (Mássimo, ~50 avisos em 1h43) continua impossível.
          //
          // Janela de 24h medida, não chutada: das 49 respostas, 45 (92%) chegam em até
          // 24h do aviso. O que vem depois disso é conversa nova, não resposta a ESTA
          // transferência — creditar seria mentir na outra direção. O filtro usa
          // last_assigned_at (hora da transferência). Ela É reescrita a cada nova
          // transferência (recordPendingHumanTransfer), mas aquele UPDATE só acha linha
          // com status='pending' — depois de virar 'warned' a coluna congela, e é isso
          // que torna o filtro estável. Fica ~15-17 min antes do aviso, que
          // é o instante do aviso menos os 15 min do SLA.
          if (clinicTokenId && phoneOut) {
            try {
              const _resolvidoEm = new Date().toISOString();
              await supabase
                .from("pending_human_transfers")
                .update({ status: "responded", resolved_at: _resolvidoEm, resolved_reason: "human_replied" })
                .eq("clinic_token_id", clinicTokenId)
                .eq("phone", phoneOut)
                .eq("status", "pending");
              const _janela24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
              await supabase
                .from("pending_human_transfers")
                .update({ status: "responded", resolved_at: _resolvidoEm, resolved_reason: "human_replied_after_warning" })
                .eq("clinic_token_id", clinicTokenId)
                .eq("phone", phoneOut)
                .eq("status", "warned")
                .gte("last_assigned_at", _janela24h);
            } catch (_e) { /* non-blocking */ }
          }
          console.log(`[Webhook] Saved fromMe outbound message for ${phoneOut} (conv=${convId}, sender=${senderNameOut || "?"})`);
        }
      } catch (e) {
        console.error("[Webhook] fromMe outbound capture error:", (e as Error).message);
      }
      // Always exit after handling fromMe — no AI processing for outbound
      return new Response(JSON.stringify({ status: "ok", reason: "fromMe captured" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (extracted.fromMe) {
      // fromMe but no usable text (group, broadcast, media without caption) — skip silently
      return new Response(JSON.stringify({ status: "skipped", reason: "fromMe non-text" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payloadTicket =
      payload.ticket && typeof payload.ticket === "object" ? (payload.ticket as Record<string, unknown>) : null;
    const payloadChannelRaw =
      payloadTicket?.whatsappId ??
      payloadTicket?.channelId ??
      (payload.msg as Record<string, unknown> | undefined)?.whatsappId ??
      (payload.msg as Record<string, unknown> | undefined)?.channelId ??
      payload.whatsappId ??
      payload.channelId ??
      null;

    let resolvedChannelId: string | null = channelIdFromGateway;
    if (
      !resolvedChannelId &&
      payloadChannelRaw !== null &&
      payloadChannelRaw !== undefined &&
      String(payloadChannelRaw).trim() !== ""
    ) {
      resolvedChannelId = String(payloadChannelRaw);
      console.log(`[Webhook] Resolved channelId from payload: ${resolvedChannelId}`);
    }

    // Support audioBase64 from test mode (sent directly from ChatTest)
    const audioBase64FromTest = payload.audioBase64 as string | undefined;
    const audioFormatFromTest = (payload.audioFormat as string) || "webm";

    // Reject invalid/duplicate messages (e.g. Z-PRO second request with [object Object])
    if (message === "[object Object]" || (message && !mediaUrl && !audioBase64FromTest && message.length < 2)) {
      console.log(`[Webhook] Skipping invalid/duplicate message: "${message}"`);
      return new Response(JSON.stringify({ status: "skipped", reason: "invalid message content" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Derive isMediaMessage (image/document/video — NOT audio)
    let isMediaMessage = extractedMediaType === "image" || extractedMediaType === "document";
    // Fallback: check raw payload msg.type if extractedMediaType wasn't set
    if (!isMediaMessage) {
      const rawMsgFallback = (payload.msg as any) || {};
      const fallbackType = ((rawMsgFallback.type || rawMsgFallback.messageType || "") as string).toLowerCase();
      if (["image", "video", "sticker", "document"].includes(fallbackType)) {
        isMediaMessage = true;
        console.log(`[Webhook] isMediaMessage=true via fallback msg.type="${fallbackType}"`);
      }
    }

    // If no text but has mediaUrl or audioBase64, we'll transcribe later after getting API key
    let isAudioMessage = false;
    if (!message && !mediaUrl && !audioBase64FromTest && !isMediaMessage) {
      console.log("[Webhook] No message text or media found in payload:", JSON.stringify(payload));
      return new Response(JSON.stringify({ error: "No message text found in payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let messageStr = typeof message === "string" ? message : String(message || "");
    if (!messageStr && (mediaUrl || audioBase64FromTest) && !isMediaMessage) {
      isAudioMessage = true;
      messageStr = "[🎤 Áudio recebido - aguardando transcrição]";
      console.log(
        `[Webhook] Audio message from ${phone} (${name}), mediaUrl: ${mediaUrl ? mediaUrl.substring(0, 80) : "base64-test"}`,
      );
    } else if (isMediaMessage) {
      if (!messageStr) messageStr = "[📎 Arquivo recebido]";
      console.log(
        `[Webhook] Media message (${extractedMediaType}) from ${phone} (${name}), caption: "${messageStr.substring(0, 60)}"`,
      );
    } else {
      console.log(`[Webhook] Message from ${phone} (${name}): ${messageStr.substring(0, 100)}`);
    }

    // Create/update conversation for incoming message
    // Extract ticket agent info for conversation display
    const rawTicketForConv = payload.ticket as Record<string, unknown> | undefined;
    const ticketAgentName = rawTicketForConv?.userName ? String(rawTicketForConv.userName) : null;
    const ticketStatusForConv = rawTicketForConv?.status ? String(rawTicketForConv.status) : null;

    const conversationId = await upsertConversation(
      supabase,
      userId,
      clinicTokenId,
      phone,
      name,
      messageStr,
      "incoming",
      { agentName: ticketAgentName, ticketStatus: ticketStatusForConv },
    );

    // === BATCHING: Save message as pending, wait, then collect all pending from same conversation ===

    // Save initial message to database
    const { data: msgRecord, error: insertError } = await supabase
      .from("webhook_messages")
      .insert({
        user_id: userId,
        webhook_id: webhook.id,
        clinic_token_id: clinicTokenId,
        sender_phone: phone,
        sender_name: name,
        message_text: messageStr,
        action_status: "pending",
        raw_payload: payload,
        direction: "incoming",
        conversation_id: conversationId,
      })
      .select("id, created_at")
      .single();

    if (insertError) {
      console.error("[Webhook] Failed to save message:", insertError);
      return new Response(JSON.stringify({ error: "Failed to save message" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const messageId = msgRecord.id;
    console.log(`[Webhook] Saved message ${messageId}`);

    // === IMMEDIATE AUDIO TRANSCRIPTION (before batching) ===
    // Transcribe audio RIGHT AWAY so batching consolidates real text, not placeholders
    let transcriptionDisplayText: string | null = null;
    let transcriptionFailed = false;
    if (isAudioMessage && (mediaUrl || audioBase64FromTest)) {
      try {
        console.log("[Webhook] Transcribing audio BEFORE batching...");
        let transcriptionResult: { text: string; duration: number };
        if (audioBase64FromTest) {
          transcriptionResult = await transcribeAudioFromBase64(audioBase64FromTest, audioFormatFromTest);
        } else {
          transcriptionResult = await transcribeAudio(mediaUrl, extractedMediaKey || undefined);
        }
        const { text: transcribed, duration } = transcriptionResult;
        // Log Groq Whisper usage (per-second pricing) — independente de sucesso/falha do texto
        if (duration > 0) logWhisperUsage(clinicTokenId, duration);
        if (transcribed) {
          messageStr = transcribed;
          let displayText = `[🎤 Áudio] ${transcribed}`;

          // Summarize long audios (>60s)
          if (duration > 60) {
            console.log(`[Webhook] Audio is ${Math.round(duration)}s — generating summary...`);
            const summary = await summarizeTranscription(transcribed, clinicTokenId);
            if (summary) {
              displayText += `\n\n📋 Resumo: ${summary}`;
              console.log(`[Webhook] Summary generated: ${summary.substring(0, 100)}`);
            }
          }

          await supabase.from("webhook_messages").update({ message_text: displayText }).eq("id", messageId);
          if (conversationId) {
            await supabase.from("chat_conversations").update({ last_message: displayText }).eq("id", conversationId);
          }
          console.log(
            `[Webhook] Audio transcribed successfully (${Math.round(duration)}s): ${transcribed.substring(0, 100)}`,
          );
          transcriptionDisplayText = `📝 _Transcrição do áudio:_\n"${transcribed}"${duration > 60 ? `\n\n📌 Resumo: ${displayText.split("📋 Resumo: ")[1] || ""}` : ""}`;
        } else {
          console.log("[Webhook] Audio transcription returned empty");
          const fallbackText = "[🎤 Áudio recebido - transcrição não disponível]";
          messageStr = fallbackText;
          await supabase
            .from("webhook_messages")
            .update({
              message_text: fallbackText,
              action_status: "failed",
              action_error: "Transcrição de áudio retornou vazio",
            })
            .eq("id", messageId);
          if (conversationId) {
            await supabase.from("chat_conversations").update({ last_message: fallbackText }).eq("id", conversationId);
          }
          transcriptionDisplayText = "📝 _Áudio recebido — transcrição indisponível_";
          transcriptionFailed = true;
        }
      } catch (audioErr: any) {
        console.error("[Webhook] Audio transcription failed:", audioErr.message);
        const fallbackText = `[🎤 Áudio recebido - falha na transcrição]`;
        messageStr = fallbackText;
        await supabase
          .from("webhook_messages")
          .update({
            message_text: fallbackText,
            action_status: "failed",
            action_error: `Falha na transcrição: ${audioErr.message}`,
          })
          .eq("id", messageId);
        if (conversationId) {
          await supabase.from("chat_conversations").update({ last_message: fallbackText }).eq("id", conversationId);
        }
        transcriptionDisplayText = "📝 _Áudio recebido — transcrição indisponível_";
        transcriptionFailed = true;
      }

      // NOTA: o tratamento de transcricao falha (avisar paciente + parar) foi MOVIDO
      // pra depois da resolucao das credenciais avanceai (essas vars sao declaradas
      // mais abaixo). Te-lo aqui causava TDZ "Cannot access 'avanceaiBaseUrl' before
      // initialization" → fallback de "instabilidade tecnica" em todo audio falho.
      // Veja "AUDIO TRANSCRIPTION FAILED — notify patient" apos o dispatch.
    }

    // === BATCHING: Rolling 15s silence timer with polling ===
    // LATENCIA (relatorios 29/06-01/07, p95 ~430s): TODA mensagem pagava piso de
    // 10s de espera + ate 90s de teto. Reduzido: 6s de silencio ja consolida
    // digitacao em rajada; 45s de teto corta o pior caso pela metade.
    const BATCH_QUIET_MS = 8000; // 8s de silêncio necessário (coalesce rajadas próximas)
    const BATCH_POLL_MS = 2000; // checa a cada 2s
    const BATCH_MAX_MS = 45000; // máximo 45s total de espera
    const BATCH_STALE_MS = 120000; // 2min — mensagens pending mais velhas são "zumbis"
    let batchTranscriptionsDispatched = false;
    if (conversationId && !isTestMode) {
      const batchStart = Date.now();

      // Clean up zombie pending messages (older than 2 minutes)
      const staleCutoff = new Date(Date.now() - BATCH_STALE_MS).toISOString();
      const { data: staleMessages } = await supabase
        .from("webhook_messages")
        .update({ action_status: "stale" })
        .eq("conversation_id", conversationId)
        .eq("direction", "incoming")
        .eq("action_status", "pending")
        .lt("created_at", staleCutoff)
        .select("id");
      if (staleMessages && staleMessages.length > 0) {
        console.log(`[Webhook] Batching: marked ${staleMessages.length} zombie messages as stale`);
      }

      console.log(`[Webhook] Batching: starting rolling timer (${BATCH_QUIET_MS}ms quiet, ${BATCH_MAX_MS}ms max)...`);

      // Polling loop — wait until 15s of silence
      while (true) {
        await new Promise((r) => setTimeout(r, BATCH_POLL_MS));
        if (Date.now() - batchStart > BATCH_MAX_MS) {
          console.log(`[Webhook] Batching: safety cap reached (${BATCH_MAX_MS}ms). Proceeding.`);
          break;
        }

        // Only check recent pending messages (within stale window)
        const recentCutoff = new Date(Date.now() - BATCH_STALE_MS).toISOString();
        const { data: latestPending } = await supabase
          .from("webhook_messages")
          .select("created_at")
          .eq("conversation_id", conversationId)
          .eq("direction", "incoming")
          .eq("action_status", "pending")
          .gte("created_at", recentCutoff)
          .order("created_at", { ascending: false })
          .limit(1);

        if (!latestPending || latestPending.length === 0) {
          console.log(`[Webhook] Batching: no pending messages found, proceeding.`);
          break;
        }

        const newestAge = Date.now() - new Date(latestPending[0].created_at).getTime();
        if (newestAge >= BATCH_QUIET_MS) {
          console.log(`[Webhook] Batching: ${Math.round(newestAge / 1000)}s of silence detected. Proceeding.`);
          break;
        }
        console.log(
          `[Webhook] Batching: newest msg is ${Math.round(newestAge / 1000)}s old, waiting more... (elapsed: ${Math.round((Date.now() - batchStart) / 1000)}s)`,
        );
      }

      // Collect pending messages only within the stale window
      const collectCutoff = new Date(Date.now() - BATCH_STALE_MS).toISOString();
      const { data: pendingMessages } = await supabase
        .from("webhook_messages")
        .select("id, message_text, created_at")
        .eq("conversation_id", conversationId)
        .eq("direction", "incoming")
        .eq("action_status", "pending")
        .gte("created_at", collectCutoff)
        .order("created_at", { ascending: true });

      if (pendingMessages && pendingMessages.length > 0) {
        const oldestPendingId = pendingMessages[0].id;
        if (oldestPendingId !== messageId) {
          // Safety net: if the "oldest pending" is a zombie (older than 30s and clearly
          // abandoned by a previous early-return guard), take over instead of exiting.
          const oldestAgeMs = Date.now() - new Date(pendingMessages[0].created_at).getTime();
          const ZOMBIE_CUTOFF_MS = BATCH_QUIET_MS * 3; // 30s
          if (oldestAgeMs > ZOMBIE_CUTOFF_MS) {
            console.log(
              `[Webhook] Batching: zombie pending msg ${oldestPendingId} (${Math.round(oldestAgeMs / 1000)}s old) — taking over as oldest.`,
            );
            const zombieIds = pendingMessages
              .filter((m: any) => m.id !== messageId)
              .map((m: any) => m.id);
            if (zombieIds.length > 0) {
              await supabase
                .from("webhook_messages")
                .update({
                  action_status: "abandoned",
                  action_error: "batch zombie — older pending msg never finished",
                })
                .in("id", zombieIds);
            }
          } else {
            // Another (older) message will handle this batch — exit silently
            console.log(
              `[Webhook] Batching: msg ${messageId} is NOT the oldest pending (${oldestPendingId} is). Exiting — it will process me.`,
            );

            // Audio transcription dispatch is NOT done here — the oldest message
            // will dispatch ALL transcriptions in chronological order after the batch timer resolves.
            // This prevents out-of-order delivery (batched msgs would fire before the oldest).

            return new Response(JSON.stringify({ status: "batched", message: "Will be processed by earlier message" }), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }


        // I AM the oldest — consolidate all pending messages
        if (pendingMessages.length > 1) {
          const batchTexts = pendingMessages.map((m: any) => m.message_text || "").filter((t: string) => t.length > 0);
          const consolidatedText = batchTexts.join("\n");
          console.log(
            `[Webhook] Batching: Consolidating ${pendingMessages.length} messages: "${consolidatedText.substring(0, 150)}"`,
          );

          // Update THIS message with the consolidated text
          messageStr = consolidatedText;
          await supabase.from("webhook_messages").update({ message_text: consolidatedText }).eq("id", messageId);

          // Update conversation last_message with consolidated text
          await supabase.from("chat_conversations").update({ last_message: consolidatedText }).eq("id", conversationId);

          // Mark the OTHER pending messages as "batched" so they don't get re-processed
          const otherIds = pendingMessages.slice(1).map((m: any) => m.id);
          if (otherIds.length > 0) {
            await supabase
              .from("webhook_messages")
              .update({ action_status: "batched", action_error: `Batched into ${messageId}` })
              .in("id", otherIds);
            console.log(`[Webhook] Batching: Marked ${otherIds.length} messages as batched`);
          }

          // === DISPATCH ALL AUDIO TRANSCRIPTIONS IN ORDER ===
          // The oldest message dispatches transcriptions for ALL audio messages in the batch,
          // in chronological order (pendingMessages is already sorted by created_at ASC).
          for (const pm of pendingMessages) {
            const pmText = pm.message_text || "";
            if (pmText.startsWith("[🎤 Áudio]")) {
              const extractedTranscription = pmText.replace("[🎤 Áudio] ", "");
              const pmFailed = extractedTranscription.includes("transcrição indisponível");
              const displayText = pmFailed
                ? "📝 _Áudio recebido — transcrição indisponível_"
                : `📝 _Transcrição do áudio:_\n"${extractedTranscription}"`;
              console.log(`[Webhook] Batching: dispatching transcription for msg ${pm.id} (ordered)`);
              await dispatchTranscriptionToCard(
                supabase,
                userId,
                clinicTokenId,
                webhook.id,
                phone,
                name,
                conversationId,
                pm.id,
                displayText,
                pmFailed,
                resolvedChannelId,
                chBaseUrl,
                chApiId,
                chBearerToken,
                isTestMode,
              );
            }
          }
          batchTranscriptionsDispatched = true;
          console.log(
            `[Webhook] Batching: finished ordered transcription dispatch for ${pendingMessages.length} messages`,
          );
        } else {
          console.log(`[Webhook] Batching: Only 1 pending message (mine), proceeding normally`);
        }
      }
    }

    // === MAIN PROCESSING PIPELINE (wrapped in try/catch for reliability) ===
    let avanceaiBaseUrl: string | null = null;
    let avanceaiApiId: string | null = null;
    let avanceaiBearerToken: string | null = null;
    try {
      // Get clinic data
      let tokenQuery = supabase
        .from("clinic_tokens")
        .select("token, ai_enabled, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (clinicTokenId) {
        tokenQuery = tokenQuery.eq("id", clinicTokenId);
      }

      const { data: tokenData, error: tokenError } = await tokenQuery.maybeSingle();

      if (tokenError || !tokenData) {
        console.error("[Webhook] No Amigo token for user:", userId);
        await supabase
          .from("webhook_messages")
          .update({
            action_status: "failed",
            action_error: "Token do Amigo não configurado para este usuário",
          })
          .eq("id", messageId);

        return new Response(JSON.stringify({ status: "error", message: "Amigo token not configured" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const amigoToken = tokenData.token;

      // === STRICT CREDENTIAL RESOLUTION (priority-based) ===
      // Priority 1: Per-channel credentials from gateway query params
      // Priority 2: Channel-specific creds from JSON config (matched by channelId)
      // Priority 3 (LEGACY ONLY): Clinic-level creds, but ONLY if no per-channel config exists
      avanceaiBaseUrl = null;
      avanceaiApiId = null;
      avanceaiBearerToken = null;

      const hasChannelConfig = !!tokenData.avanceai_active_channel;
      let channelConfigs: any[] = [];
      if (hasChannelConfig) {
        try {
          const parsed = JSON.parse(tokenData.avanceai_active_channel);
          if (Array.isArray(parsed)) channelConfigs = parsed.filter((ch: any) => ch && ch.enabled !== false);
        } catch {
          /* ignore */
        }
      }

      // Priority 1: Gateway-provided per-channel creds
      if (chBaseUrl && chApiId && chBearerToken) {
        avanceaiBaseUrl = chBaseUrl;
        avanceaiApiId = chApiId;
        avanceaiBearerToken = chBearerToken;
        console.log(`[Webhook] Using gateway-provided per-channel credentials`);
      }
      // Priority 2: Resolve from JSON config by resolved channelId
      else if (resolvedChannelId && channelConfigs.length > 0) {
        for (let i = channelConfigs.length - 1; i >= 0; i--) {
          const ch = channelConfigs[i];
          if (ch && String(ch.id) === String(resolvedChannelId) && ch.apiId && ch.baseUrl) {
            avanceaiBaseUrl = ch.baseUrl;
            avanceaiApiId = ch.apiId;
            avanceaiBearerToken = ch.bearerToken;
            console.log(`[Webhook] Using per-channel credentials for channel ${resolvedChannelId} (entry ${i})`);
            break;
          }
        }
        if (!avanceaiBaseUrl) {
          console.log(`[Webhook] Channel ${resolvedChannelId} not found in config — cannot resolve credentials`);
        }
      }
      // Priority 3: Legacy clinic-level creds ONLY if no per-channel config exists at all
      else if (!hasChannelConfig || channelConfigs.length === 0) {
        avanceaiBaseUrl = tokenData.avanceai_base_url;
        avanceaiApiId = tokenData.avanceai_api_id;
        avanceaiBearerToken = tokenData.avanceai_bearer_token;
        if (avanceaiBaseUrl) {
          console.log(`[Webhook] Using legacy clinic-level credentials (no per-channel config exists)`);
        }
      }
      // Has channel config but no channelId resolved and only one enabled channel
      else if (channelConfigs.length === 1) {
        const ch = channelConfigs[0];
        if (ch && ch.apiId && ch.baseUrl) {
          avanceaiBaseUrl = ch.baseUrl;
          avanceaiApiId = ch.apiId;
          avanceaiBearerToken = ch.bearerToken;
          resolvedChannelId = ch.id ? String(ch.id) : null;
          console.log(`[Webhook] Single channel configured, auto-using channel ${resolvedChannelId || "unknown"}`);
        }
      } else {
        console.log(
          `[Webhook] Multi-channel config but no channelId resolved — cannot resolve credentials (blocking wrong-channel send)`,
        );
      }

      // === REDUNDANT SAFETY: Block disabled channels ===
      if (resolvedChannelId && hasChannelConfig && channelConfigs.length > 0) {
        const isChannelEnabled = channelConfigs.some((ch: any) => String(ch.id) === String(resolvedChannelId));
        if (!isChannelEnabled) {
          // Tema 5 (relatorio 24/06 Amostra 3 — alagamento): paciente em URGENCIA
          // ficou em silencio porque o canal estava off. Antes de pular silenciosamente,
          // checa urgencia e marca a mensagem como urgent_skipped pra ficar visivel
          // no dashboard + log em ERROR (alerta operacional).
          const messageForUrgency = messageStr || (mediaUrl ? "[mensagem de mídia/áudio]" : "");
          const isUrgentOnDisabledChannel = detectUrgency(messageForUrgency);

          if (isUrgentOnDisabledChannel) {
            console.error(
              `[Webhook] 🚨🚨 URGENCIA + CANAL DESABILITADO — phone=${phone} channel=${resolvedChannelId} msg="${(messageForUrgency || "").substring(0, 200)}". Mensagem PRECISA de atendimento humano e o canal NAO esta ativo!`,
            );
            await supabase
              .from("webhook_messages")
              .update({
                action_status: "urgent_skipped",
                ai_intent: "urgent_on_disabled_channel",
                action_error: `URGENCIA em canal ${resolvedChannelId} desabilitado — paciente precisa de atendimento humano`,
              })
              .eq("id", messageId);
            return new Response(
              JSON.stringify({
                status: "urgent_skipped",
                reason: "urgent_on_disabled_channel",
                alert: "patient_message_marked_as_urgent_in_dashboard",
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          console.log(`[Webhook] BLOCKED: Channel ${resolvedChannelId} is NOT in enabled channels list — skipping`);
          await supabase
            .from("webhook_messages")
            .update({ action_status: "skipped", action_error: `Canal ${resolvedChannelId} desabilitado` })
            .eq("id", messageId);
          return new Response(JSON.stringify({ status: "skipped", reason: "channel_disabled" }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // === SEND TRANSCRIPTION TO AVANCEAI CARD/TICKET (audio was already transcribed before batching) ===
      // Skip if batch loop already dispatched all transcriptions (multi-message batch)
      let finalMessage = messageStr;
      if (isAudioMessage && transcriptionDisplayText && !batchTranscriptionsDispatched) {
        await dispatchTranscriptionToCard(
          supabase,
          userId,
          clinicTokenId,
          webhook.id,
          phone,
          name,
          conversationId,
          messageId,
          transcriptionDisplayText,
          transcriptionFailed,
          resolvedChannelId,
          // Use already-resolved credentials if available, otherwise helper will fetch them
          avanceaiBaseUrl ? avanceaiBaseUrl : chBaseUrl,
          avanceaiApiId ? avanceaiApiId : chApiId,
          avanceaiBearerToken ? avanceaiBearerToken : chBearerToken,
          isTestMode,
        );
      }

      // === AUDIO TRANSCRIPTION FAILED — notify patient (MOVED here from inside the
      // audio block to fix TDZ on avanceaiBaseUrl). If transcription failed, tell the
      // patient in plain language and STOP — sem isso o classifier ve "[audio falha]"
      // como texto do paciente, chuta unknown e gera resposta generica. ===
      if (transcriptionFailed && !isTestMode && phone) {
        const aBase = avanceaiBaseUrl || chBaseUrl;
        const aApi = avanceaiApiId || chApiId;
        const aBearer = avanceaiBearerToken || chBearerToken;
        if (aBase && aApi && aBearer) {
          const patientMsg =
            "Não consegui ouvir o seu áudio agora. 🙏 Pode me mandar a mensagem por escrito que eu te ajudo na hora?";
          try {
            const dupCheck = await isDuplicateReply(supabase, conversationId, patientMsg, 600);
            if (!dupCheck.duplicate) {
              await sendAvanceaiReply(aBase, aApi, aBearer, phone, patientMsg, resolvedChannelId);
              await supabase.from("webhook_messages").insert({
                user_id: userId,
                webhook_id: webhook.id,
                clinic_token_id: clinicTokenId,
                sender_phone: phone,
                sender_name: name,
                message_text: patientMsg,
                direction: "outgoing",
                conversation_id: conversationId,
                action_status: "success",
                ai_intent: "audio_failed_reply",
              } as any);
            } else {
              console.log("[Webhook] Audio-fail reply skipped (recently sent)");
            }
          } catch (e) {
            console.error(`[Webhook] Audio-fail reply error: ${(e as Error).message}`);
          }
          return new Response(
            JSON.stringify({ status: "audio_transcription_failed", replied: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // BUG-2 FIX: primary check moved into the unified isHumanActive() further down the pipeline
      // (signal 1: raw payload). Logging the raw ticket here is still useful for diagnostics.
      const rawTicket = payload.ticket as Record<string, unknown> | undefined;
      const rawTicketStatus = (rawTicket?.status as string) || "";
      const rawTicketUserId = rawTicket?.userId ?? null;
      console.log(
        `[Webhook] Raw ticket info (informational only): status="${rawTicketStatus}", userId=${rawTicketUserId}`,
      );

      const aiEnabled = tokenData.ai_enabled === true;

      // If AI is disabled and not in test mode, just save the message and return
      if (!aiEnabled && !isTestMode) {
        console.log("[Webhook] AI is disabled for this clinic, skipping classification and auto-reply");
        await supabase
          .from("webhook_messages")
          .update({ action_status: "skipped", action_error: "AI desativada para esta clínica" })
          .eq("id", messageId);
        return new Response(JSON.stringify({ status: "skipped", message: "AI disabled for this clinic" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (isTestMode) {
        console.log("[Webhook] Test mode: bypassing ai_enabled check");
      }
      // === BOT-TO-BOT GUARD (relatorio 08/07, conversa Ultrafarma) ===
      // Mensagem que É de outro robô de atendimento (SAC/URA) — nenhum paciente
      // escreve "sou o assistente virtual" ou "digite o número da opção". Responder
      // geraria loop bot-com-bot. Skip silencioso com motivo auditável.
      {
        const _botSig =
          /\b(sou\s+(o|a)\s+assistente\s+virtual|atendimento\s+eletr[oô]nico|digite\s+(o\s+n[uú]mero|uma?\s+op[cç][aã]o)|escolha\s+uma\s+op[cç][aã]o|selecione\s+uma\s+das\s+op[cç][oõ]es|protocolo\s+de\s+atendimento\s+n[uú]?|central\s+de\s+atendimento\s+da)\b/i;
        if (messageStr && _botSig.test(messageStr) && !/\b(julia|cbt)\b/i.test(messageStr)) {
          console.log(`[BotGuard] ⛔ Mensagem tem assinatura de robô de SAC — não respondendo (anti bot-loop)`);
          await supabase
            .from("webhook_messages")
            .update({ action_status: "skipped", action_error: "Mensagem de outro robô (SAC/URA) — anti bot-loop" })
            .eq("id", messageId);
          return new Response(JSON.stringify({ status: "skipped", reason: "bot_to_bot_guard" }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // === DOUBLE-SLASH BYPASS — Skip AI processing entirely ===
      if (messageStr && messageStr.trimStart().startsWith("//")) {
        console.log(`[Webhook] ⛔ Message starts with "//" — bypassing AI processing`);
        await supabase
          .from("webhook_messages")
          .update({ action_status: "skipped", action_error: "Mensagem com prefixo // — bypass de IA" })
          .eq("id", messageId);
        return new Response(JSON.stringify({ status: "success", action: "double_slash_bypass" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Decode company_id from Amigo token
      let companyId: string;
      try {
        const jwtPayload = decodeJwtPayload(amigoToken);
        companyId = String(jwtPayload.company_id);
      } catch (e) {
        console.error("[Webhook] Invalid Amigo token:", e.message);
        await supabase
          .from("webhook_messages")
          .update({
            action_status: "failed",
            action_error: "Token do Amigo inválido",
          })
          .eq("id", messageId);

        return new Response(JSON.stringify({ status: "error", message: "Invalid Amigo token" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // === PROACTIVE PATIENT IDENTIFICATION BY PHONE ===
      // Uses getPhoneVariants helper (handles 55 prefix + 9th digit toggle).
      // Removed previous `ilike.%<slice(-9)>%` fuzzy match (audit critical #2):
      // two different patients with same last-9 digits would collide.
      let identifiedPatient: { name: string; cpf: string } | null = null;
      let multiplePatientsOnPhone = false; // S4: marca pra pedir CPF em vez de auto-identificar
      if (phone) {
        const phoneDigits = phone.replace(/\D/g, "");
        const safeVariants = getPhoneVariants(phoneDigits);
        // S4 (relatorio 23/06 Conv. 12 Sergio/Carla): conta TODOS os pacientes com
        // esse telefone. Se >1 (familia compartilha numero), NAO auto-identifica —
        // pega o primeiro pelo nome errado. Em vez disso, marca multiplePatientsOnPhone
        // e o fluxo de booking vai pedir CPF explicitamente.
        const { data: allLocalPatients } = await supabase
          .from("local_patients")
          .select("cpf, name, phone")
          .in("phone", safeVariants)
          .limit(5);

        if (Array.isArray(allLocalPatients) && allLocalPatients.length > 1) {
          // Conta PESSOAS, não CPFs preenchidos. O `.filter(Boolean)` sozinho fazia
          // uma linha SEM CPF desaparecer da contagem: duas pessoas no mesmo
          // telefone, uma sem CPF, davam distinctCpfs.size = 1 e o guard não
          // disparava — o primeiro nome da lista (sem ORDER BY, portanto
          // arbitrário) virava o nome do paciente. Nome de gente diferente é
          // exatamente o que não pode acontecer.
          const distinctCpfs = new Set(
            allLocalPatients.map((p: any) => String(p.cpf || "").replace(/\D/g, "")).filter(Boolean),
          );
          const semCpf = allLocalPatients.filter((p: any) => !String(p.cpf || "").replace(/\D/g, "")).length;
          const nomesDistintos = new Set(
            allLocalPatients.map((p: any) => stripAccents(String(p.name || "").toLowerCase().trim())).filter(Boolean),
          );
          if (distinctCpfs.size + semCpf > 1 || nomesDistintos.size > 1) {
            multiplePatientsOnPhone = true;
            const names = allLocalPatients.map((p: any) => p.name).filter(Boolean).join(", ");
            console.log(
              `[Webhook] ⚠️ S4: Multiple patients on phone (${allLocalPatients.length} found: ${names}) — skipping auto-ID, will require CPF`,
            );
          }
        }

        if (!multiplePatientsOnPhone) {
          const localPatient = (allLocalPatients || [])[0] as { cpf?: string; name?: string; phone?: string } | undefined;
          if (localPatient?.name) {
            identifiedPatient = { name: localPatient.name, cpf: localPatient.cpf || "" };
            console.log(
              `[Webhook] Proactive ID: Found patient by phone: ${localPatient.name} (CPF: ${localPatient.cpf || "N/A"})`,
            );
          }
        }

        // S4: se ja' sabemos que ha multiplos pacientes neste telefone, NAO consulta
        // o Amigo (que tambem retornaria o primeiro). Vai pedir CPF no fluxo.
        if (!identifiedPatient && !multiplePatientsOnPhone) {
          // Try Amigo API by phone
          const phonesToTry: string[] = [];
          if (phoneDigits.startsWith("55") && phoneDigits.length >= 12) {
            phonesToTry.push(phoneDigits.substring(2));
          }
          phonesToTry.push(phoneDigits);
          for (const tryPhone of phonesToTry) {
            try {
              const amigoPhoneResult = await tryFetch(
                `patients/exists?contact_cellphone=${tryPhone}&company_id=${companyId}`,
                amigoToken,
              );
              const amigoPhoneData = normalizeApiResponse(amigoPhoneResult) as Record<string, unknown>;
              // If Amigo responded with 2xx, the lookup is conclusive for this phone.
              // Even if no name/full_name is returned (new patient), we should not
              // retry with another variant — it won't find anything different.
              if (amigoPhoneResult.status >= 200 && amigoPhoneResult.status < 300) {
                if (amigoPhoneData && (amigoPhoneData.name || amigoPhoneData.full_name)) {
                  const foundName = String(amigoPhoneData.name || amigoPhoneData.full_name || "");
                  const foundCpf = String(amigoPhoneData.cpf || amigoPhoneData.document || "");
                  if (foundName) {
                    // mesmo saneamento: sem 11 dígitos, a identidade segue sem CPF
                    const _cpfProativo = cpfLimpoOuVazio(foundCpf);
                    identifiedPatient = { name: foundName, cpf: _cpfProativo };
                    console.log(`[Webhook] Proactive ID: Found patient via Amigo API: ${foundName}`);
                    // Save to local_patients for future lookups
                    try {
                      const { data: existingWebhook, error: whErr } = await supabase
                        .from("user_webhooks")
                        .select("user_id")
                        .eq("clinic_token_id", clinicTokenId)
                        .limit(1)
                        .maybeSingle();
                      if (whErr) {
                        console.log(`[Webhook] Proactive ID: user_webhooks lookup error: ${whErr.message}`);
                      }
                      const ownerUserId = existingWebhook?.user_id;
                      console.log(`[Webhook] Proactive ID: cache save — ownerUserId=${ownerUserId || "MISSING"}, foundCpf=${foundCpf || "MISSING"}, phoneDigits=${phoneDigits}`);
                      if (ownerUserId && _cpfProativo) {
                        const { data: upsertData, error: upsertErr } = await supabase
                          .from("local_patients")
                          .upsert(
                            {
                              user_id: ownerUserId,
                              phone: phoneDigits,
                              cpf: _cpfProativo,
                              name: foundName,
                              amigo_patient_id: String(amigoPhoneData.id || amigoPhoneData.patient_id || ""),
                            },
                            { onConflict: "user_id,cpf" },
                          )
                          .select();
                        if (upsertErr) {
                          console.log(`[Webhook] Proactive ID: upsert FAILED: ${upsertErr.message} (code=${upsertErr.code})`);
                        } else {
                          console.log(`[Webhook] Proactive ID: upsert OK — rows returned: ${upsertData?.length || 0}`);
                        }
                      } else {
                        console.log(`[Webhook] Proactive ID: SKIPPING upsert (missing ownerUserId or foundCpf)`);
                      }
                    } catch (saveErr: any) {
                      console.log(`[Webhook] Proactive ID: EXCEPTION during save: ${saveErr.message}`);
                    }
                  }
                } else {
                  console.log(`[Webhook] Proactive ID: Amigo returned 2xx with no patient data — treating as not found`);
                }
                break; // 2xx é resposta definitiva — não tentar outra variante
              }
            } catch (err: any) {
              console.log(`[Webhook] Proactive ID: Amigo lookup error: ${err.message}`);
            }
          }
        }

        if (identifiedPatient) {
          console.log(`[Webhook] Patient identified proactively: ${identifiedPatient.name}`);
        } else {
          console.log(`[Webhook] No patient found proactively by phone ${phoneDigits}`);
        }
      }

      // Check 24h inactivity — if last message was >24h ago, treat as new conversation
      let isInactiveConversation = false;
      if (conversationId) {
        const { data: convData } = await supabase
          .from("chat_conversations")
          .select("last_message_at")
          .eq("id", conversationId)
          .maybeSingle();
        if (convData?.last_message_at) {
          const lastMsgTime = new Date(convData.last_message_at).getTime();
          const hoursSinceLastMsg = (Date.now() - lastMsgTime) / (1000 * 60 * 60);
          if (hoursSinceLastMsg > 24) {
            isInactiveConversation = true;
            console.log(
              `[Webhook] Conversation inactive for ${hoursSinceLastMsg.toFixed(1)}h (>24h) — treating as new conversation`,
            );

            // Schedule patient recovery follow-up if enabled for this clinic
            if (clinicTokenId && conversationId) {
              try {
                const { data: clinicCheck } = await supabase
                  .from("clinic_tokens")
                  .select("recovery_enabled")
                  .eq("id", clinicTokenId)
                  .maybeSingle();

                if (clinicCheck?.recovery_enabled) {
                  // Check if there's already a pending follow-up for this conversation
                  const { data: existingFollowUp } = await supabase
                    .from("pending_follow_ups")
                    .select("id")
                    .eq("conversation_id", conversationId)
                    .eq("status", "pending")
                    .maybeSingle();

                  if (!existingFollowUp) {
                    // Check if the conversation had a successful booking — if so, skip
                    const { data: successBooking } = await supabase
                      .from("webhook_messages")
                      .select("id")
                      .eq("conversation_id", conversationId)
                      .eq("ai_intent", "agendar")
                      .eq("action_status", "success")
                      .limit(1);

                    if (!successBooking || successBooking.length === 0) {
                      // Schedule follow-up for next day at ~12:30 BRT (15:30 UTC)
                      const now = new Date();
                      const nextDay = new Date(now);
                      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
                      nextDay.setUTCHours(15, 30, 0, 0); // 12:30 BRT = 15:30 UTC
                      // Skip weekends
                      const dow = nextDay.getUTCDay();
                      if (dow === 0) nextDay.setUTCDate(nextDay.getUTCDate() + 1); // Sunday -> Monday
                      if (dow === 6) nextDay.setUTCDate(nextDay.getUTCDate() + 2); // Saturday -> Monday

                      await supabase.from("pending_follow_ups").insert({
                        conversation_id: conversationId,
                        phone,
                        contact_name: name,
                        clinic_token_id: clinicTokenId,
                        user_id: userId,
                        execute_at: nextDay.toISOString(),
                      });
                      console.log(
                        `[Webhook] Scheduled patient recovery follow-up for ${phone} at ${nextDay.toISOString()}`,
                      );
                    }
                  }
                }
              } catch (recoveryErr) {
                console.error("[Webhook] Failed to schedule recovery follow-up:", recoveryErr);
              }
            }
          }
        }
      }

      // Fetch dynamic AI script + conversation history + clinic info IN PARALLEL
      const [scriptResult, conversationHistory, clinicInfoResult] = await Promise.all([
        clinicTokenId
          ? supabase
              .from("ai_scripts")
              .select("script_content")
              .eq("user_id", userId)
              .eq("clinic_token_id", clinicTokenId)
              .eq("is_active", true)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        isInactiveConversation ? Promise.resolve([]) : fetchConversationHistory(supabase, conversationId),
        clinicTokenId
          ? supabase
              .from("clinic_info")
              .select(
                "address, google_maps_link, custom_notes, business_hours, specialty, clinic_description, routing_rules, greeting_template",
              )
              .eq("clinic_token_id", clinicTokenId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      let dynamicScript: string | undefined;
      if (scriptResult.data?.script_content) {
        dynamicScript = scriptResult.data.script_content;
        // BUG-3 FIX: cap user-editable script size so a runaway custom prompt cannot blow up
        // the context window and starve the conversation history of tokens.
        const MAX_SCRIPT_CHARS = 20000;
        if (dynamicScript.length > MAX_SCRIPT_CHARS) {
          console.log(
            `[Webhook] ⚠️ dynamicScript (${dynamicScript.length} chars) exceeds ${MAX_SCRIPT_CHARS} — truncating`,
          );
          dynamicScript = dynamicScript.substring(0, MAX_SCRIPT_CHARS) + "\n[... script truncado ...]";
        }
        console.log("[Webhook] Using dynamic AI script from database");
      }

      // Inject clinic reference data into the persona script
      const clinicRef = clinicInfoResult?.data;
      if (clinicRef && dynamicScript) {
        const refParts: string[] = [];
        if (clinicRef.clinic_description) refParts.push(`Descrição: ${clinicRef.clinic_description}`);
        if (clinicRef.specialty) refParts.push(`Especialidade: ${clinicRef.specialty}`);
        if (clinicRef.address) refParts.push(`Endereço: ${clinicRef.address}`);
        if (clinicRef.google_maps_link) refParts.push(`Link Google Maps: ${clinicRef.google_maps_link}`);
        if (clinicRef.business_hours) refParts.push(`Horário: ${clinicRef.business_hours}`);
        if (clinicRef.custom_notes) {
          refParts.push(`\nDados de Referência da Clínica:\n${clinicRef.custom_notes}`);
          // Check if custom_notes contains price/value info
          const hasPriceInfo = /(?:R\$|reais|valor|preço|preco|custo|tabela)\s*\d/i.test(clinicRef.custom_notes);
          if (!hasPriceInfo) {
            refParts.push(
              `\n[SEM DADOS DE PREÇO DISPONÍVEIS] - Não há valores de consulta cadastrados. NUNCA invente preços.`,
            );
          }
        } else {
          refParts.push(
            `\n[SEM DADOS DE PREÇO DISPONÍVEIS] - Não há valores de consulta cadastrados. NUNCA invente preços.`,
          );
        }
        if (refParts.length > 0) {
          dynamicScript += `\n\n## Informações da Clínica (use quando relevante):\n${refParts.join("\n")}`;
          console.log("[Webhook] Injected clinic reference data into persona script");
        }
      }

      // Prepare clinic location info for scheduling confirmations
      const clinicLocationInfo = clinicRef
        ? { address: clinicRef.address || undefined, google_maps_link: clinicRef.google_maps_link || undefined }
        : undefined;

      // Check if currently outside business hours (timezone America/Sao_Paulo)
      let isOutsideBusinessHours = false;
      let isClosedDayToday = false;
      let parsedBusinessHours: { businessOpenHour?: number; businessCloseHour?: number } | null = null;
      if (clinicRef?.business_hours) {
        try {
          const nowSP = getNowSP();
          const dayOfWeek = nowSP.getDay(); // 0=Sun, 6=Sat
          const currentHour = nowSP.getHours();
          const currentMinute = nowSP.getMinutes();
          const currentTime = currentHour * 60 + currentMinute;

          // Parse business_hours string like "segunda a sexta das 8h as 18h"
          const hoursStr = clinicRef.business_hours.toLowerCase();
          const timeMatch = hoursStr.match(/(\d{1,2})h?\s*(?:às|as|a)\s*(\d{1,2})h?/);
          const openTime = timeMatch ? parseInt(timeMatch[1]) * 60 : 8 * 60;
          const closeTime = timeMatch ? parseInt(timeMatch[2]) * 60 : 18 * 60;
          parsedBusinessHours = {
            businessOpenHour: timeMatch ? parseInt(timeMatch[1]) : 8,
            businessCloseHour: timeMatch ? parseInt(timeMatch[2]) : 18,
          };

          // Check if weekend
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
          // Check if weekday but has "segunda a sexta" or "seg a sex" pattern (common)
          const isWeekdaySchedule = hoursStr.includes("segunda") || hoursStr.includes("seg");

          if (isWeekend && isWeekdaySchedule) {
            isOutsideBusinessHours = true;
          } else if (currentTime < openTime || currentTime >= closeTime) {
            isOutsideBusinessHours = true;
          }

          console.log(
            `[Webhook] Business hours check: day=${dayOfWeek}, time=${currentHour}:${currentMinute}, open=${openTime / 60}h-${closeTime / 60}h, outside=${isOutsideBusinessHours}`,
          );
          // Dia fechado (feriado/emenda) hoje? Usado pelo prompt do gerador para
          // manter a oferta de agendamento SEMPRE ativa (cache 60s — barato).
          try {
            const _cdToday = await getClosedDayInfo(supabase, clinicTokenId);
            isClosedDayToday = _cdToday.closedToday;
          } catch { /* non-blocking */ }
        } catch (e) {
          console.log(`[Webhook] Business hours parse error: ${e}`);
        }
      }

      console.log(`[Webhook] Got ${conversationHistory.length} messages from history`);
      console.log(`[Webhook] RELÓGIO_OFICIAL: ${formatNowSPHuman()} | todayISO=${getTodayISO_SP()}`);

      // === HUMAN AGENT GUARD (BUG-2 FIX) ===
      // Single unified check via isHumanActive — combines payload, manual_reply history,
      // recent human-skip history, and live showticket API. ALWAYS runs (no isTestMode bypass).
      // Z-PRO often creates a NEW "pending" ticket even when a human is actively working on the
      // previous ticket; the manual_reply and DB-history signals catch that case before we waste
      // a showticket API call.
      {
        const payloadTicketSec = payload.ticket as Record<string, unknown> | undefined;
        if (payloadTicketSec && String(payloadTicketSec.status || "") === "pending" && payloadTicketSec.isCreated) {
          console.log(
            `[Webhook] ⚠️ Z-PRO created NEW ticket (pending, isCreated=true) for phone=${phone} — will re-verify via isHumanActive`,
          );
        }
        const humanCheck = await isHumanActive(
          supabase,
          payloadTicketSec,
          conversationId,
          avanceaiBaseUrl,
          avanceaiApiId,
          avanceaiBearerToken,
          phone,
          resolvedChannelId,
        );
        if (humanCheck.blocked) {
          console.log(`[Webhook] ⛔ Human active — skipping AI. Reason: ${humanCheck.reason}`);
          // EXCEÇÃO DA LISTA DE ESPERA (19/08): a Julia é a única que sabe que
          // existe uma oferta de vaga pendente — foi ELA que perguntou. Se a
          // resposta é o "quero"/"não posso" dessa oferta, ela ANOTA antes de
          // sair. Continua sem responder e sem agendar: só o registro muda. Sem
          // isso o aceite some (3 casos medidos) e o cron ainda manda "não deu
          // tempo de confirmar" para quem respondeu em minutos.
          let _wlSobAtendente: "aceite" | "recusa" | "" = "";
          if (await isWaitlistEnabled(supabase, clinicTokenId)) {
            _wlSobAtendente = await registrarRespostaDeVagaSobAtendente(
              supabase, clinicTokenId, phone, finalMessage,
            );
          }
          await supabase
            .from("webhook_messages")
            .update({
              action_status: "skipped",
              action_error: _wlSobAtendente
                ? `Humano ativo: ${humanCheck.reason} | lista de espera: ${_wlSobAtendente} anotado (sem resposta ao paciente)`
                : `Humano ativo: ${humanCheck.reason}`,
            })
            .eq("id", messageId);
          return new Response(
            JSON.stringify({ status: "success", action: "human_agent_active", reason: humanCheck.reason }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // === Inactivity reset check (shared by both circuit breakers) ===
      let isNewSession = false;
      if (conversationId) {
        try {
          const { data: prevIncoming } = await supabase
            .from("webhook_messages")
            .select("created_at")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .order("created_at", { ascending: false })
            .range(1, 1); // penúltima mensagem (a atual está sendo processada)

          if (prevIncoming?.[0]) {
            const lastTime = new Date(prevIncoming[0].created_at).getTime();
            const now = Date.now();
            if (now - lastTime > 30 * 60 * 1000) {
              isNewSession = true;
              console.log(`[Webhook] 🔄 New session detected (30min+ inactivity) for conversation ${conversationId} — circuit breakers bypassed`);
            }
          }
        } catch (sessionErr) {
          console.log(`[Webhook] Session check error (non-blocking): ${(sessionErr as Error).message}`);
        }
      }

      // === CIRCUIT BREAKER: detect unknown_intent loops (bot-to-bot) ===
      // Skips counting unknowns that happened while a slot_lock was active for this phone —
      // those are very likely classifier confusion in the middle of a booking flow
      // (e.g. patient says "Sul América", classifier returns unknown), not a real loop.
      if (conversationId && !isNewSession) {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { data: unknownRows } = await supabase
          .from("webhook_messages")
          .select("id, created_at, message_text")
          .eq("conversation_id", conversationId)
          .eq("direction", "outgoing")
          .in("ai_intent", ["unknown", "unknown_intent"])
          .gte("created_at", tenMinAgo);

        // ── SÓ FALHA DE VERDADE VIRA COMBUSTÍVEL (01/09) ──────────────────────
        // O classificador rotula 'unknown' tanto o que não entendeu quanto a
        // resposta contextual perfeita. Medido: 5 disparos em 7 dias, 5 falsos.
        // No caso Yvo (31/08 15:40–15:44) as CINCO respostas antes do disparo
        // eram boas ("Entendo perfeitamente, Yvo! Uma pena não termos encaixe
        // para amanhã...") — e o disjuntor engoliu o pedido seguinte, que era
        // entrada na lista de espera.
        const _todasUnknown = (unknownRows || []) as Array<{ message_text?: string }>;
        const _falhasReais = _todasUnknown.filter((r) => respostaFoiFalha(r.message_text));

        // TETO DURO, sem filtro nenhum: o filtro acima é o certo para conversa de
        // gente, mas um loop robô-a-robô com respostas contextuais passaria por
        // ele. O caso Alessandra (176 mensagens) não é mais verificável em dados
        // — a retenção é de 7 dias — então a trava entra desde o primeiro dia.
        const TETO_DURO_UNKNOWN = 8;
        if (_todasUnknown.length >= TETO_DURO_UNKNOWN) {
          console.log(`[Webhook] ⛔ CIRCUIT BREAKER (teto duro): ${_todasUnknown.length} unknowns em 10min — dispara sem filtro`);
        } else if (_todasUnknown.length !== _falhasReais.length) {
          console.log(
            `[Webhook] CIRCUIT BREAKER: ${_todasUnknown.length} unknowns, mas só ${_falhasReais.length} foram falha de verdade — o resto foi resposta boa mal rotulada`,
          );
        }

        let unknownCount = _todasUnknown.length >= TETO_DURO_UNKNOWN
          ? _todasUnknown.length
          : _falhasReais.length;
        if (unknownCount >= 3 && clinicTokenId && phone) {
          // Was there a slot_lock active for this phone in the 5min before each unknown?
          // If yes for any of them, subtract — booking-flow confusion shouldn't trip breaker.
          try {
            const cleanPhoneBreaker = phone.replace(/\D/g, "");
            const phoneVariantsBreaker = [
              cleanPhoneBreaker,
              cleanPhoneBreaker.startsWith("55") ? cleanPhoneBreaker.slice(2) : `55${cleanPhoneBreaker}`,
            ];
            const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
            const { data: locksRecent } = await supabase
              .from("slot_locks")
              .select("locked_at, expires_at")
              .eq("clinic_token_id", clinicTokenId)
              .in("phone", phoneVariantsBreaker)
              .gte("locked_at", fifteenMinAgo);
            if (Array.isArray(locksRecent) && locksRecent.length > 0) {
              const inFlightUnknowns = (unknownRows || []).filter((row: any) => {
                const t = new Date(row.created_at).getTime();
                return locksRecent.some((l: any) => {
                  const lockedAt = new Date(l.locked_at).getTime();
                  // Lock was created at most 5min before this unknown AND was still
                  // unexpired when the unknown was generated.
                  return t >= lockedAt - 60_000 && t <= lockedAt + 5 * 60 * 1000;
                });
              }).length;
              if (inFlightUnknowns > 0) {
                console.log(
                  `[Webhook] CIRCUIT BREAKER softened: ${inFlightUnknowns}/${unknownCount} unknowns occurred during active slot_lock window — not counting`,
                );
                unknownCount -= inFlightUnknowns;
              }
            }
            // Second-line softening: discount unknowns that happened while the
            // conversation_state was in a legitimate progress state (slot_search,
            // slot_chosen, awaiting_cpf, awaiting_confirmation, awaiting_registration,
            // reschedule_search, cancel_pending). These are classifier confusion in
            // active flow, not real loops.
            try {
              const phoneVariantsBrk2 = phoneVariantsForState(phone);
              const { data: convTransRows } = await supabase
                .from("conversation_state_transitions")
                .select("created_at, to_state")
                .eq("clinic_token_id", clinicTokenId)
                .in("phone", phoneVariantsBrk2)
                .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
                .order("created_at", { ascending: false });
              const activeStates = new Set([
                "slot_search", "slot_chosen", "awaiting_cpf", "awaiting_confirmation",
                "awaiting_registration", "reschedule_search", "cancel_pending",
              ]);
              const activePeriods: Array<{ start: number; end: number }> = [];
              const transitions = (convTransRows || []) as Array<{ created_at: string; to_state: string }>;
              // Walk transitions in chronological order, build periods of "active state"
              const chrono = [...transitions].reverse();
              let openStart: number | null = null;
              for (const tr of chrono) {
                const t = new Date(tr.created_at).getTime();
                if (activeStates.has(tr.to_state)) {
                  if (openStart === null) openStart = t;
                } else if (openStart !== null) {
                  activePeriods.push({ start: openStart, end: t });
                  openStart = null;
                }
              }
              if (openStart !== null) activePeriods.push({ start: openStart, end: Date.now() });

              if (activePeriods.length > 0) {
                const stateInFlight = (unknownRows || []).filter((row: any) => {
                  const t = new Date(row.created_at).getTime();
                  return activePeriods.some((p) => t >= p.start - 30_000 && t <= p.end + 60_000);
                }).length;
                if (stateInFlight > 0) {
                  console.log(
                    `[Webhook] CIRCUIT BREAKER softened (state): ${stateInFlight}/${unknownCount} unknowns inside active conversation_state windows — not counting`,
                  );
                  unknownCount = Math.max(0, unknownCount - stateInFlight);
                }
              }
            } catch (stateBrkErr) {
              console.log(`[Webhook] breaker conv_state check error (non-blocking): ${(stateBrkErr as Error).message}`);
            }
          } catch (lockBrkErr) {
            console.log(`[Webhook] breaker slot_lock check error (non-blocking): ${(lockBrkErr as Error).message}`);
          }
        }

        // URGÊNCIA NUNCA É ENGOLIDA (cicatriz do Tema 5, relatório 24/06: paciente em
        // alagamento foi silenciado por um guard que rodava antes do detector de
        // urgência). Se a mensagem tem sinal de urgência, o breaker CEDE A VEZ e o
        // fluxo normal segue — lá adiante o detector de urgência transfere na hora.
        const _cbUrgente = unknownCount >= 3 && detectUrgency(finalMessage || "");
        if (_cbUrgente) {
          console.log(`[Webhook] CB#1 armado (${unknownCount}), mas a mensagem tem sinal de URGÊNCIA — deixando passar`);
        }
        if (unknownCount >= 3 && !_cbUrgente) {
          console.log(
            `[Webhook] ⛔ CIRCUIT BREAKER: ${unknownCount} unknown intents in last 10min for conversation ${conversationId} — stopping AI`,
          );
          await supabase
            .from("webhook_messages")
            .update({
              action_status: "circuit_breaker",
              action_error: `Loop detectado: ${unknownCount} respostas unknown_intent em 10min — IA pausada para revisão humana`,
            })
            .eq("id", messageId);

          // TRAVA DO BREAKER (caso Alessandra 24/07): o aviso era reenviado a cada
          // disparo. Pior, o breaker NUNCA persistia a própria saída — e como o
          // contador se alimenta das linhas de SAÍDA, cada bloqueio removia o próprio
          // combustível: a contagem caía abaixo de 3, a IA voltava a responder e
          // nascia um "dente de serra" que durou 6 horas contra o respondedor
          // automático de um paciente (176 mensagens). Agora: avisa UMA vez por
          // janela e PERSISTE a saída (o contador para de se auto-desarmar, e a
          // mensagem aparece no histórico do paciente).
          let _cbJaAvisou = false;
          try {
            const _cbSince = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const { data: _cbPrev } = await supabase
              .from("webhook_messages")
              .select("id")
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .eq("action_status", "circuit_breaker_notice")
              .gte("created_at", _cbSince)
              .limit(1);
            _cbJaAvisou = !!(_cbPrev && _cbPrev.length > 0);
          } catch (e) {
            console.log(`[Webhook] CB#1 checagem de aviso anterior falhou (non-blocking): ${(e as Error).message}`);
          }

          // Tell the patient AND transfer to a human, instead of going silent.
          if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode && !_cbJaAvisou) {
            const breakerMsg =
              "Estou com dificuldade pra te ajudar por aqui agora. Já estou transferindo pra nossa equipe — uma atendente vai continuar com você em instantes. 🙏";
            let _cbSent = false;
            try {
              await sendAvanceaiReply(
                avanceaiBaseUrl,
                avanceaiApiId,
                avanceaiBearerToken,
                phone,
                breakerMsg,
                resolvedChannelId,
              );
              _cbSent = true;
            } catch (e) {
              console.error(`[Webhook] CB#1 reply send failed: ${(e as Error).message}`);
            }
            if (_cbSent) {
              // ai_intent "unknown" DE PROPÓSITO: é o que o contador do CB#1 conta.
              // Persistir mantém o breaker ARMADO em vez de deixá-lo se desarmar.
              try {
                await supabase.from("webhook_messages").insert({
                  clinic_token_id: clinicTokenId,
                  user_id: userId || null,
                  sender_phone: phone,
                  message_text: breakerMsg,
                  direction: "outgoing",
                  ai_intent: "unknown",
                  action_status: "circuit_breaker_notice",
                  conversation_id: conversationId,
                });
              } catch (e) {
                console.log(`[Webhook] CB#1 log do aviso falhou (non-blocking): ${(e as Error).message}`);
              }
            }
            try {
              await transferTicketToHuman({
                baseUrl: avanceaiBaseUrl,
                apiId: avanceaiApiId,
                bearerToken: avanceaiBearerToken,
                phone,
                channelId: resolvedChannelId,
              });
            } catch (e) {
              console.error(`[Webhook] CB#1 transfer failed: ${(e as Error).message}`);
            }
          } else if (_cbJaAvisou) {
            console.log(`[Webhook] CB#1 já avisou nos últimos 30min — silêncio (não reenvia o aviso)`);
          }
          return new Response(JSON.stringify({ status: "circuit_breaker", reason: "unknown_intent_loop_detected" }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // === CIRCUIT BREAKER #2: detect repeated ACTION failures (same intent failing 3+ times) ===
      if (conversationId && !isNewSession) {
        try {
          const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
          const { data: recentFailures } = await supabase
            .from("webhook_messages")
            .select("ai_intent")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .eq("action_status", "failed")
            .gte("created_at", twoHoursAgo)
            .order("created_at", { ascending: false })
            .limit(5);

          if (recentFailures && recentFailures.length >= 3) {
            // Check if the last 3 failures are the same intent
            const lastThree = recentFailures.slice(0, 3);
            const sameIntent = lastThree.every((r) => r.ai_intent === lastThree[0].ai_intent);
            if (sameIntent && lastThree[0].ai_intent) {
              const failedIntent = lastThree[0].ai_intent;
              console.log(
                `[Webhook] ⛔ CIRCUIT BREAKER #2: "${failedIntent}" failed 3+ consecutive times for conversation ${conversationId} — transferring to human`,
              );

              // Try to transfer to human
              if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
                try {
                  const transferResult = await transferTicketToHuman({
                    baseUrl: avanceaiBaseUrl,
                    apiId: avanceaiApiId,
                    bearerToken: avanceaiBearerToken,
                    phone,
                    channelId: resolvedChannelId,
                  });
                  console.log(`[Webhook] Circuit breaker transfer result: ${JSON.stringify(transferResult)}`);
                } catch (transferErr) {
                  console.log(
                    `[Webhook] Circuit breaker transfer failed (non-blocking): ${(transferErr as Error).message}`,
                  );
                }
              }

              await supabase
                .from("webhook_messages")
                .update({
                  action_status: "error_loop",
                  action_error: `Loop de erro: "${failedIntent}" falhou 3x consecutivas — ticket transferido para atendente humano`,
                })
                .eq("id", messageId);

              // Send empathetic message to patient
              if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
                const errorMsg =
                  "Desculpe pelo inconveniente! Estou com uma dificuldade técnica para concluir essa ação. Vou transferir você para nossa equipe de atendimento para que possam te ajudar diretamente. 🙏";
                await sendAvanceaiReply(
                  avanceaiBaseUrl,
                  avanceaiApiId,
                  avanceaiBearerToken,
                  phone,
                  errorMsg,
                  resolvedChannelId,
                );
              }

              return new Response(
                JSON.stringify({ status: "error_loop", reason: `${failedIntent}_failed_3x`, transferred: true }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          }
        } catch (cbErr) {
          console.log(`[Webhook] Circuit breaker #2 check error (non-blocking): ${(cbErr as Error).message}`);
        }
      }

      // === CIRCUIT BREAKER #3: detect repeated identical outgoing responses ===
      // Se a IA mandou a MESMA resposta (normalizada) 2+ vezes nos últimos 15min, transfere pra humano.
      if (conversationId && !isNewSession) {
        try {
          const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
          const { data: recentOutgoing } = await supabase
            .from("webhook_messages")
            .select("message_text, created_at, ai_intent")
            .eq("conversation_id", conversationId)
            .eq("direction", "outgoing")
            .gte("created_at", fifteenMinAgo)
            .order("created_at", { ascending: false })
            .limit(5);

          // P1/P3 fix: respostas DETERMINISTICAS legitimas (saudacao fixa, aviso de
          // audio falho, link do widget) sao identicas POR DESIGN. Se o paciente manda
          // varias saudacoes em 15min, a IA repete o greeting_template — isso NAO eh
          // loop e nao deve disparar transferencia. Filtra esses intents do CB#3.
          const DETERMINISTIC_INTENTS = new Set([
            "greeting_shortcut",
            "audio_failed_reply",
            "widget_link_sent",
          ]);
          const countable = (recentOutgoing || []).filter(
            (r: any) => !DETERMINISTIC_INTENTS.has(String(r.ai_intent || "")),
          );

          if (countable.length >= 2) {
            const normalize = (s: string) =>
              (s || "")
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9]/g, "")
                .slice(0, 200);
            const normalized = countable.map((r: any) => normalize(r.message_text || ""));
            const counts = new Map<string, number>();
            for (const n of normalized) {
              if (!n) continue;
              counts.set(n, (counts.get(n) || 0) + 1);
            }
            const maxRepeat = counts.size > 0 ? Math.max(...counts.values()) : 0;

            if (maxRepeat >= 2) {
              console.log(
                `[Webhook] ⛔ CIRCUIT BREAKER #3: same outgoing response repeated ${maxRepeat}x in 15min for conversation ${conversationId} — transferring to human`,
              );

              if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
                try {
                  await transferTicketToHuman({
                    baseUrl: avanceaiBaseUrl,
                    apiId: avanceaiApiId,
                    bearerToken: avanceaiBearerToken,
                    phone,
                    channelId: resolvedChannelId,
                  });
                } catch (transferErr) {
                  console.log(
                    `[Webhook] CB#3 transfer failed (non-blocking): ${(transferErr as Error).message}`,
                  );
                }
              }

              await supabase
                .from("webhook_messages")
                .update({
                  action_status: "circuit_breaker",
                  action_error: `Resposta idêntica repetida ${maxRepeat}x em 15min — ticket transferido para atendente humano`,
                })
                .eq("id", messageId);

              if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
                const errMsg =
                  "Vou chamar uma de nossas atendentes pra te ajudar diretamente nesse caso, tudo bem? 🙏";
                await sendAvanceaiReply(
                  avanceaiBaseUrl,
                  avanceaiApiId,
                  avanceaiBearerToken,
                  phone,
                  errMsg,
                  resolvedChannelId,
                );
              }

              await auditTransfer(supabase, {
                clinicTokenId, conversationId, phone,
                initiatedBy: "julia", trigger: "breaker_loop",
                reason: "repeated_response_loop_2x_15min",
                detail: (finalMessage || "").slice(0, 120),
              });
              return new Response(
                JSON.stringify({ status: "circuit_breaker", reason: "repeated_response_loop", transferred: true }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          }
        } catch (cbErr) {
          console.log(`[Webhook] Circuit breaker #3 check error (non-blocking): ${(cbErr as Error).message}`);
        }
      }

      // === SEND TYPING INDICATOR before AI processing ===
      if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && !isTestMode) {
        await sendTypingIndicator(
          avanceaiBaseUrl,
          avanceaiApiId,
          avanceaiBearerToken,
          (payload.ticket as Record<string, unknown> | undefined)?.id as string | number | undefined,
          resolvedChannelId,
        );
      }

      // Classify intent with AI (now with conversation history)
      const LOVABLE_API_KEY = llmApiKey();
      if (!LOVABLE_API_KEY) {
        console.error("[Webhook] OPENROUTER_API_KEY não configurada — a Julia não responde sem ela");
        await supabase
          .from("webhook_messages")
          .update({
            action_status: "failed",
            action_error: "AI API key not configured",
          })
          .eq("id", messageId);

        return new Response(JSON.stringify({ status: "error", message: "AI not configured" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // === MEDIA MESSAGE SHORT-CIRCUIT: imagem/documento/vídeo → atendente humano ===
      // Skip if the consolidated message has real text beyond just the media placeholder
      const hasRealCaption = messageStr && messageStr.trim() !== "" && messageStr !== "[📎 Arquivo recebido]";
      const consolidatedHasRealText =
        messageStr &&
        messageStr.includes("[📎 Arquivo recebido]") &&
        messageStr.replace(/\[📎 Arquivo recebido\]/g, "").trim().length > 0;
      if (isMediaMessage && !hasRealCaption && !consolidatedHasRealText) {
        // ── REVALIDATE TICKET before media transfer ──
        if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
          const mediaTicketCheck = await checkTicketIsHumanOwned(
            avanceaiBaseUrl,
            avanceaiApiId,
            avanceaiBearerToken,
            phone,
            resolvedChannelId,
          );
          if (mediaTicketCheck.isHumanOwned) {
            console.log(
              `[Webhook] ⛔ Media message but ticket is open with agent "${mediaTicketCheck.userName}" — suppressing media transfer`,
            );
            await supabase
              .from("webhook_messages")
              .update({
                action_status: "skipped",
                action_error: `Ticket open (agent=${mediaTicketCheck.userName}) — media transfer suprimida`,
              })
              .eq("id", messageId);
            return new Response(JSON.stringify({ status: "success", action: "human_agent_active_media" }), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        console.log(`[Webhook] 📎 Media message without caption — bypassing NLU, routing to human attendant`);

        // Build routing rules from clinic_info (already fetched in parallel above)
        const mediaRoutingRules: Array<{ keyword: string; target_user: string }> = Array.isArray(
          clinicRef?.routing_rules,
        )
          ? (clinicRef.routing_rules as any[]).map((r: any) => ({
              keyword: r.keyword || "",
              target_user: r.target_user || "",
            }))
          : [];

        // Try to match a routing rule using the caption text OR recent conversation history
        const captionText = messageStr.toLowerCase();
        const historyText = conversationHistory
          .map((m) => m.content)
          .join(" ")
          .toLowerCase();
        const combinedText = `${captionText} ${historyText}`;
        let targetAttendant: string | null = null;
        for (const rule of mediaRoutingRules) {
          if (rule.keyword && combinedText.includes(rule.keyword.toLowerCase())) {
            targetAttendant = rule.target_user;
            console.log(
              `[Webhook] Media routing rule matched: keyword="${rule.keyword}" → target="${targetAttendant}"`,
            );
            break;
          }
        }

        // Fixed reply message
        const mediaReply =
          "Recebi seu arquivo! 📎 Infelizmente ainda não consigo analisar documentos e imagens diretamente. Vou encaminhar para nossa equipe, que entrará em contato em breve.";

        // Transfer ticket to human attendant via AvanceAI (unified helper)
        if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
          try {
            let formattedPhone = phone.replace(/\D/g, "");
            if (!formattedPhone.startsWith("55")) formattedPhone = "55" + formattedPhone;

            // Try to find the target attendant in the Z-PRO users list
            let transferUserId: string | number | undefined = undefined;
            if (targetAttendant) {
              try {
                const usersUrl = `${avanceaiBaseUrl}/v2/api/external/${avanceaiApiId}/listUsers`;
                const usersRes = await fetch(usersUrl, {
                  method: "GET",
                  headers: { Authorization: `Bearer ${avanceaiBearerToken}` },
                });
                if (usersRes.ok) {
                  const usersData = await usersRes.json();
                  const usersList: any[] = Array.isArray(usersData) ? usersData : usersData?.users || [];
                  const stripAcc = (s: string) =>
                    s
                      .normalize("NFD")
                      .replace(/[\u0300-\u036f]/g, "")
                      .toLowerCase();
                  const targetNorm = stripAcc(targetAttendant);
                  // Filter out admin and offline users BEFORE matching
                  const onlineUsers = usersList.filter((u: any) => {
                    const profile = (u.profile || u.role || "").toLowerCase();
                    if (profile === "admin") return false;
                    if (u.online === false) return false;
                    if (typeof u.status === "string" && u.status.toLowerCase() === "offline") return false;
                    return true;
                  });
                  const matched = onlineUsers.find((u: any) => {
                    const uName = stripAcc(String(u.name || u.fullName || ""));
                    return uName.includes(targetNorm) || targetNorm.includes(uName.split(" ")[0]);
                  });
                  if (matched) {
                    transferUserId = matched.id;
                    console.log(
                      `[Webhook] Media: matched ONLINE attendant "${matched.name}" (id=${transferUserId}) for target "${targetAttendant}"`,
                    );
                  } else {
                    // Check if target exists but is offline
                    const offlineMatch = usersList.find((u: any) => {
                      const uName = stripAcc(String(u.name || u.fullName || ""));
                      return uName.includes(targetNorm) || targetNorm.includes(uName.split(" ")[0]);
                    });
                    if (offlineMatch) {
                      console.log(
                        `[Webhook] Media: ⚠️ Target attendant "${offlineMatch.name}" is OFFLINE — NOT setting userId, will transfer without owner`,
                      );
                    }
                  }
                }
              } catch (usersErr: any) {
                console.log(`[Webhook] Media: could not fetch users list: ${usersErr.message}`);
              }
            }

            const mediaTransferResult = await transferTicketToHuman({
              baseUrl: avanceaiBaseUrl,
              apiId: avanceaiApiId,
              bearerToken: avanceaiBearerToken,
              phone: formattedPhone,
              userId: transferUserId,
              channelId: resolvedChannelId,
              // Só força quando a regra resolveu um alvo (atendente online)
              forceReassign: !!transferUserId,
            });

            if (mediaTransferResult.ok) {
              console.log(
                `[Webhook] Media: ✅ ticket transferred (attempt=${mediaTransferResult.attempt})${targetAttendant ? ` to "${targetAttendant}"` : ""}`,
              );
            } else {
              console.error(
                `[Webhook] Media: transfer FAILED — attempt=${mediaTransferResult.attempt}, status=${mediaTransferResult.httpStatus}, detail=${mediaTransferResult.errorDetail}`,
              );
            }

            // Send reply to patient
            if (!isTestMode) {
              await sendAvanceaiReply(
                avanceaiBaseUrl,
                avanceaiApiId,
                avanceaiBearerToken,
                phone,
                mediaReply,
                resolvedChannelId,
              );
            }
          } catch (mediaTransferErr: any) {
            console.error(`[Webhook] Media: transfer failed: ${mediaTransferErr.message}`);
          }
        }

        // Save outgoing reply to DB
        await supabase.from("webhook_messages").insert({
          user_id: userId,
          webhook_id: webhook.id,
          clinic_token_id: clinicTokenId,
          sender_phone: phone,
          sender_name: name,
          message_text: mediaReply,
          direction: "outgoing",
          conversation_id: conversationId,
          action_status: "success",
          ai_intent: "envio_midia",
          ai_entities: { target_attendant: targetAttendant || null },
        });
        await upsertConversation(supabase, userId, clinicTokenId, phone, name, mediaReply, "outgoing");

        // Update incoming message record
        await supabase
          .from("webhook_messages")
          .update({
            action_status: "success",
            ai_intent: "envio_midia",
            ai_response: mediaReply,
          })
          .eq("id", messageId);

        return new Response(JSON.stringify({ status: "success", action: "media_routed_to_human" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // === STRIP MEDIA PLACEHOLDER from consolidated text ===
      // If batching consolidated a media message with real text, remove the placeholder
      // so the AI only processes the actual text content
      if (messageStr && messageStr.includes("[📎 Arquivo recebido]")) {
        const cleanedText = messageStr.replace(/\[📎 Arquivo recebido\]/g, "").trim();
        if (cleanedText.length > 0) {
          console.log(
            `[Webhook] Stripped media placeholder from consolidated text. Clean: "${cleanedText.substring(0, 100)}"`,
          );
          messageStr = cleanedText;
        }
      }

      // === AUTO-DETECT needs_registration CONTEXT ===

      // If the last outgoing message had action_status="needs_registration", force intent to "cadastrar"
      let forceRegistrationIntent = false;
      if (conversationId) {
        const { data: lastOutgoing } = await supabase
          .from("webhook_messages")
          .select("action_status, ai_entities, ai_intent, created_at")
          .eq("conversation_id", conversationId)
          .eq("direction", "outgoing")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (
          lastOutgoing?.action_status === "needs_registration" ||
          (lastOutgoing?.ai_intent === "cadastrar" && lastOutgoing?.action_status === "needs_info")
        ) {
          forceRegistrationIntent = true;
          console.log(
            `[Webhook] Last outgoing was ${lastOutgoing.action_status} (intent=${lastOutgoing.ai_intent}) — will force intent to 'cadastrar'`,
          );

          // Recover scheduling context saved in the outgoing message
          const savedContext = lastOutgoing.ai_entities as Record<string, unknown> | null;
          if (savedContext) {
            console.log("[Webhook] Recovered scheduling context from outgoing:", JSON.stringify(savedContext));
            // These will be merged into classification after classifyIntent runs
            (globalThis as any).__schedulingContext = savedContext; // TODO: migrate to request-local variable
          }
        }

        // Check if last outgoing was explicitly sent by a human (manual_reply marker)
        // Only block AI if the manual message was sent within the last 2 hours (avoid permanent lockout)
        if (!forceRegistrationIntent && lastOutgoing && lastOutgoing.ai_intent === "manual_reply") {
          const lastOutgoingTime = lastOutgoing.created_at ? new Date(lastOutgoing.created_at as string).getTime() : 0;
          const hoursSinceManual = (Date.now() - lastOutgoingTime) / (1000 * 60 * 60);
          if (hoursSinceManual <= 2) {
            console.log(
              `[Webhook] ⛔ Last outgoing was human-sent (manual_reply, ${hoursSinceManual.toFixed(1)}h ago) — skipping AI processing`,
            );
            await supabase
              .from("webhook_messages")
              .update({
                action_status: "skipped",
                action_error: "Última mensagem foi de atendente humano (manual_reply) — IA não processou",
              })
              .eq("id", messageId);
            return new Response(JSON.stringify({ status: "skipped", reason: "human_initiated_conversation" }), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } else {
            console.log(
              `[Webhook] Last outgoing was manual_reply but ${hoursSinceManual.toFixed(1)}h ago (>2h) — proceeding with AI`,
            );
          }
        }
      }

      // Inject identified patient info into classification context
      const classificationMessage = identifiedPatient
        ? `${finalMessage}\n\n[CONTEXTO DO SISTEMA: Paciente identificado automaticamente pelo telefone: Nome: ${firstName(identifiedPatient.name)}${identifiedPatient.cpf ? `, CPF: ${identifiedPatient.cpf}` : ""}. Use o nome para personalizar a interação.]`
        : finalMessage;

      // === Reset keyword pre-check (hoisted: used by stale-cleanup, greeting shortcut, and routing below) ===
      const resetKeywords = [
        "reiniciar",
        "recomeçar",
        "começar de novo",
        "do zero",
        "limpar histórico",
        "resetar",
        "resetar conversa",
        "zerar",
        "limpar",
        "começar do zero",
        "vamos reiniciar",
      ];
      const msgLower = finalMessage.toLowerCase().trim();
      const isResetRequest = resetKeywords.some((k) => msgLower.includes(k));

      // === GREETING SHORTCUT (P1 dos relatorios 15-19/06) ===
      // Saudacao pura ("Oi", "Ola", "Bom dia") em conversa fresca recebe uma resposta
      // EXATA configurada em clinic_info.greeting_template. Sem LLM, sem parafrase.
      // Resolve o problema #1 da semana toda: saudacao generica em vez do texto oficial.
      try {
        // Aceita: "oi", "ola", "oie", "oii", "boa tarde", "ola de novo", "oi novamente",
        // "voltei", "ola tudo bem?", etc. O ".{0,30}" no final captura adornos curtos.
        const PURE_GREETING_RE =
          /^(ol[aá]+|oi+e?|hey+|hi+|hello+|e\s*a[ií]+|fala+|salve+|bom\s+dia|boa\s+tarde|boa\s+noite|boa\s+madrugada|voltei|estou\s+de\s+volta)(\s+(de\s+novo|novamente|outra\s+vez|tudo\s+bem|tudo\s+bom))?[\s!.?,]*$/i;
        const greetTrimmed = (finalMessage || "").trim();
        const isPureGreeting = PURE_GREETING_RE.test(greetTrimmed) && greetTrimmed.length <= 40;

        if (
          isPureGreeting &&
          clinicTokenId &&
          conversationId &&
          !isResetRequest &&
          clinicRef?.greeting_template
        ) {
          const greetingTpl = String(clinicRef.greeting_template).trim();
          if (greetingTpl.length > 10) {
            // Conversa "fresca": sem outgoing nas ultimas 12h OU estado conv idle/closed/greeting.
            // Janela 12h (reduzida de 24h) pra cobrir pacientes que voltam no dia seguinte
            // dizendo "Oi" pra recomecar - eles devem ver a saudacao oficial de novo.
            const since12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            const { count: recentOutgoing } = await supabase
              .from("webhook_messages")
              .select("id", { count: "exact", head: true })
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .gte("created_at", since12h);

            let stateAllowsRestart = true;
            try {
              const convState = await getConversationState(supabase, clinicTokenId, phone);
              if (convState && !["idle", "closed", "greeting"].includes(convState.current_state)) {
                stateAllowsRestart = false;
              }
            } catch { /* non-blocking */ }

            if ((recentOutgoing || 0) === 0 || stateAllowsRestart) {
              const dup = await isDuplicateReply(supabase, conversationId, greetingTpl, 300);
              if (dup.duplicate) {
                console.log("[Webhook] 👋 greeting shortcut skipped (recent duplicate)");
              } else if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
                console.log(`[Webhook] 👋 GREETING SHORTCUT — usando texto exato do clinic_info.greeting_template`);
                await sendAvanceaiReply(
                  avanceaiBaseUrl, avanceaiApiId, avanceaiBearerToken,
                  phone, greetingTpl, resolvedChannelId,
                );
                await supabase.from("webhook_messages").insert({
                  user_id: userId,
                  webhook_id: webhook.id,
                  clinic_token_id: clinicTokenId,
                  sender_phone: phone,
                  sender_name: name,
                  message_text: greetingTpl,
                  direction: "outgoing",
                  conversation_id: conversationId,
                  action_status: "success",
                  ai_intent: "greeting_shortcut",
                  verified_schedule: null,
                } as any);
                // Fecha a incoming msg pra não travar o batching das próximas mensagens
                await supabase.from("webhook_messages").update({
                  action_status: "success",
                  ai_intent: "greeting_shortcut",
                }).eq("id", messageId);
                try {
                  await transitionConversationState(supabase, {
                    clinicTokenId,
                    conversationId: ((globalThis as any).__currentConversationId as string | undefined) || null,
                    phone,
                    toState: "greeting",
                    trigger: "greeting_shortcut",
                    messageId: messageId || null,
                    resetContext: true,
                  });
                } catch { /* non-blocking */ }
                return new Response(
                  JSON.stringify({ status: "greeting_shortcut", replied: true }),
                  { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
                );
              }
            }
          }
        }
      } catch (e) {
        console.log(`[Webhook] greeting shortcut error (non-blocking): ${(e as Error).message}`);
      }

      // === Pre-fetch conversation_state ===
      // Lido aqui (antes do classifier) pra alimentar o stale-cleanup e o greeting
      // shortcut. Quando chegar a parte de injeção pro classifier, esse mesmo valor
      // é reusado se não ficou stale.
      let currentConvState: ConversationStateRow | null = null;

      if (clinicTokenId && phone && !isResetRequest) {
        try {
          currentConvState = await getConversationState(supabase, clinicTokenId, phone);
        } catch { /* non-blocking */ }
      }

      // === STALE conversation_state CLEANUP ===
      // Premissa CRÍTICA: se chegamos aqui, o `isHumanActive` (que roda antes) já liberou
      // a IA. Portanto, se o estado salvo é `transferred_human`, ele está MENTINDO —
      // o Avance não tem humano ativo no momento. Fechar IMEDIATAMENTE, sem TTL.
      //
      // Sem isso, a injeção "NÃO responda em nome da clínica" induzia o LLM a alucinar
      // "estou te transferindo agora" mesmo numa saudação nova.
      //
      // Mesma lógica vale pra estados que ficam grudados depois de testes/abandono:
      // se passou tempo demais, fecha pra não contaminar a próxima conversa.
      if (clinicTokenId && phone && currentConvState) {
        const enteredAt = new Date(currentConvState.state_entered_at).getTime();
        const ageMs = Date.now() - enteredAt;
        // transferred_human: fecha por default quando vê nova mensagem do paciente
        // (porque isHumanActive já liberou — humano não está mais conduzindo).
        // EXCEÇÃO P3: se foi handoff por ESPECIALIDADE (infiltracao/exame/cirurgia),
        // NÃO fechar. Esses casos devem ficar grudados ate' o paciente desistir
        // ou a Lidiane/Vânia efetivamente assumir, pra IA NUNCA tentar oferecer
        // agenda de consulta comum num paciente que ja' foi pra fluxo especial.
        if (currentConvState.current_state === "transferred_human") {
          const handoffReason = String(currentConvState.context?.handoff_reason || "");
          const STICKY_HANDOFFS = ["infiltracao", "exame", "cirurgia"];
          if (STICKY_HANDOFFS.includes(handoffReason)) {
            console.log(`[ConversationState] transferred_human STICKY (handoff_reason=${handoffReason}) — mantendo estado`);
            // Mantem currentConvState — a injecao do classifier vai usar pra dizer
            // "esta paciente esta no fluxo X, NAO oferecer agenda nem cpf"
          } else {
            console.log(`[ConversationState] transferred_human encountered but isHumanActive liberou — auto-closing (humano nao esta mais ativo)`);
            await transitionConversationState(supabase, {
              clinicTokenId,
              conversationId: conversationId || null,
              phone,
              toState: "closed",
              trigger: "transferred_human_but_isHumanActive_cleared",
              resetContext: true,
              messageId: messageId || null,
            });
            currentConvState = null;
          }
        }
        // Outros estados: TTL normal
        const STALE_MAX: Record<string, number> = {
          booking_created: 2 * 60 * 60 * 1000,    // 2h
          slot_chosen: 10 * 60 * 1000,            // 10min
          awaiting_cpf: 30 * 60 * 1000,
          awaiting_registration: 60 * 60 * 1000,
          awaiting_confirmation: 30 * 60 * 1000,
          slot_search: 30 * 60 * 1000,
          cancel_pending: 30 * 60 * 1000,
          reschedule_search: 30 * 60 * 1000,
        };
        const limit = currentConvState ? STALE_MAX[currentConvState.current_state] : null;
        if (currentConvState && limit && ageMs > limit) {
          console.log(`[ConversationState] Stale "${currentConvState.current_state}" (${Math.round(ageMs/60000)}min) — auto-closing to idle`);
          await transitionConversationState(supabase, {
            clinicTokenId,
            conversationId: conversationId || null,
            phone,
            toState: "closed",
            trigger: `stale_${currentConvState.current_state}_${Math.round(ageMs/60000)}min`,
            resetContext: true,
            messageId: messageId || null,
          });
          currentConvState = null; // evita injeção dum estado que acabamos de fechar
        }
      }



      // (resetKeywords / msgLower / isResetRequest hoisted above to fix TDZ — see line ~10173)



      // === KEYWORD PRE-CHECK: routing rules keywords BEFORE AI classification (priority over NLU) ===
      let keywordForcedIntent: { intent: string; attendant_name: string; handoff_reason?: string } | null = null;
      if (!isResetRequest) {
        const routingRules: Array<{ keyword: string; target_user: string }> = Array.isArray(clinicRef?.routing_rules)
          ? (clinicRef.routing_rules as any[]).map((r: any) => ({
              keyword: r.keyword || "",
              target_user: r.target_user || "",
            }))
          : [];
        if (routingRules.length > 0) {
          const msgSearch = stripAccents(msgLower);
          for (const rule of routingRules) {
            const kw = stripAccents((rule.keyword || "").toLowerCase().trim());
            if (kw && flexKeywordMatch(msgSearch, kw)) {
              console.log(
                `[Webhook] ⚡ KEYWORD PRE-CHECK: "${rule.keyword}" matched BEFORE AI classification → forcing falar_com_atendente (target="${rule.target_user}")`,
              );
              keywordForcedIntent = { intent: "falar_com_atendente", attendant_name: rule.target_user || "" };
              break;
            }
          }
        }
      }

      // === HARDCODED KEYWORD OVERRIDES (independent of routing_rules) ===
      if (!keywordForcedIntent) {
        const msgSearchHardcoded = stripAccents(msgLower);
        if (msgSearchHardcoded.includes("cirurgia")) {
          // Find target from routing rules if configured, otherwise default
          const cirurgiaRule = Array.isArray(clinicRef?.routing_rules)
            ? (clinicRef.routing_rules as any[]).find((r: any) =>
                stripAccents((r.keyword || "").toLowerCase()).includes("cirurgia"),
              )
            : null;
          const targetUser = cirurgiaRule?.target_user || "";
          console.log(
            `[Webhook] ⚡ HARDCODED KEYWORD OVERRIDE: "cirurgia" detected → forcing falar_com_atendente (target="${targetUser}")`,
          );
          keywordForcedIntent = { intent: "falar_com_atendente", attendant_name: targetUser, handoff_reason: "cirurgia" };
        } else if (/\binfiltra/.test(msgSearchHardcoded)) {
          // RADICAL "infiltra" (28/07): antes era includes("infiltracao"), que deixava
          // passar as formas que o paciente REALMENTE escreve — "infiltrações" (plural)
          // e "infiltrar" NÃO casavam, e a mensagem caía no LLM podendo virar 'agendar'.
          // Infiltração nunca é agendada pelo robô (regra do dono): errar para o lado de
          // transferir é seguro; errar para o lado de agendar sozinho, não.
          console.log(
            `[Webhook] ⚡ HARDCODED KEYWORD OVERRIDE: "infiltra*" detected → forcing solicitar_infiltracao`,
          );
          keywordForcedIntent = { intent: "solicitar_infiltracao", attendant_name: "" };
        } else if (/\bfisio/.test(msgSearchHardcoded)) {
          // Relatorio 08/07 (caso Italo): "quero fisio" caia no agendar e respondia
          // "nao encontrei especialista". Roteamento proprio da fisioterapia:
          // valores + avaliacao gratuita + transferencia (deterministico, sem LLM).
          console.log(`[Webhook] ⚡ HARDCODED KEYWORD OVERRIDE: "fisio" detected → forcing solicitar_fisioterapia`);
          keywordForcedIntent = { intent: "solicitar_fisioterapia", attendant_name: "" };
        } else if (PEDIDO_DE_ATENDENTE_RE.test(msgSearchHardcoded)) {
          // 26/08: a mensagem "Atendente", sozinha, caiu em unknown_intent — a
          // própria saudação diz "se preferir falar com um atendente, é só me
          // pedir". Os padrões de frustração exigem uma segunda palavra
          // ("atendente humano", "atendente agora") e o LLM não classificou.
          console.log(`[Webhook] ⚡ HARDCODED KEYWORD OVERRIDE: pedido de atendente → forcing falar_com_atendente`);
          keywordForcedIntent = { intent: "falar_com_atendente", attendant_name: "" };
        }
      }

      // === LISTA DE ESPERA: keyword determinística (06/07) ===
      // "lista de espera" -> entrar; com sair/tirar/cancelar junto -> sair.
      // Gated pela flag da clínica; com flag off a mensagem segue o fluxo normal.
      if (!keywordForcedIntent && WAITLIST_KEYWORD_RE.test(finalMessage || "")) {
        try {
          if (await isWaitlistEnabled(supabase, clinicTokenId)) {
            const leaving = WAITLIST_LEAVE_RE.test(finalMessage || "");
            console.log(
              `[Webhook] ⚡ KEYWORD OVERRIDE: "lista de espera" → forcing ${leaving ? "sair_lista_espera" : "entrar_lista_espera"}`,
            );
            keywordForcedIntent = { intent: leaving ? "sair_lista_espera" : "entrar_lista_espera", attendant_name: "" };
          }
        } catch (e) {
          console.log(`[Waitlist] keyword gate error (non-blocking): ${(e as Error).message}`);
        }
      }

      // === URGENCY DETECTION (P-relatorio 23/06 Conv. 35 Fabiano) ===
      // Termos de emergencia/crise/dor aguda interrompem o fluxo de agendamento e
      // forçam transferencia humana IMEDIATA. Caso Fabiano: relatou "crise na lombar"
      // e "emergência", IA ofereceu horário 14 dias depois — Violacao da Regra 4.
      // Risco assistencial real.
      //
      // Pre-classifier deterministico (regex) por ser literalmente questao de
      // saude — nao podemos depender do LLM acertar.
      if (!keywordForcedIntent) {
        // Tema 5: usa helper compartilhado (mesmo regex roda no channel-disabled guard
        // pra cobrir Amostra 3 do relatorio 24/06).
        // "clinica" | "agenda" | null. O roteamento é IGUAL nos dois primeiros
        // (humano na hora); só o texto muda — ver classificarUrgencia.
        const _tipoUrg = classificarUrgencia(finalMessage);
        const isUrgent = _tipoUrg !== null;
        const _ehEncaixe = _tipoUrg === "agenda";

        if (isUrgent) {
          console.log(
            `[Webhook] 🚨 URGENCY DETECTED (tipo=${_tipoUrg}) — transferring to human IMMEDIATELY (Regra 4)`,
          );

          // ACOLHIMENTO ANTES DA TRANSFERENCIA (semana 10-14/08) — o porque
          // completo esta no cabecalho de enviarAcolhimentoUrgencia.
          const _urgAck = await enviarAcolhimentoUrgencia(supabase, {
            baseUrl: avanceaiBaseUrl, apiId: avanceaiApiId, bearerToken: avanceaiBearerToken, phone,
            channelId: resolvedChannelId, isTestMode, userId, webhookId: webhook.id, clinicTokenId,
            conversationId, contactName: name, messageId,
            mensagem: _ehEncaixe ? ENCAIXE_ACOLHIMENTO : URGENCIA_ACOLHIMENTO,
          });

          // Deixado de propósito SEM consumidor: a segunda mensagem de urgência
          // continua saindo como sempre, para servir de CONTROLE. Se o acolhimento
          // estiver chegando, o eco dela aparece no banco; se não estiver, a
          // segunda mensagem garante que o paciente ouviu alguma coisa. Quando a
          // entrega estiver comprovada, aí sim a segunda vira condicional.
          console.log(`[Urgencia] acolhimento imediato aceito pela API: ${_urgAck}`);

          // ATRIBUI UMA DONA. Até 10/08 esta chamada ia SEM userId, o que só
          // abre o ticket sem dono nenhum — e como este é o caminho de URGÊNCIA,
          // era justamente o paciente com dor que ficava sem ninguém
          // responsável. Seis casos só naquele dia, nenhum roteado. O helper
          // também arma o aviso de 15 min, que este caminho nunca teve.
          // Declarado FORA do if porque o texto enviado ao paciente depende do
          // resultado: prometer "alguém já vai te responder" quando não há
          // ninguém online é a promessa que mais custou caro neste projeto.
          let _urgT: { ok: boolean; attendantName?: string } = { ok: false };
          if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
            _urgT = await transferirComDono(supabase, {
              clinicTokenId,
              conversationId,
              phone,
              intent: _ehEncaixe ? "encaixe" : "urgencia",
              baseUrl: avanceaiBaseUrl,
              apiId: avanceaiApiId,
              bearerToken: avanceaiBearerToken,
              channelId: resolvedChannelId,
              currentMessageText: finalMessage || null,
            });
            if (!_urgT.ok) {
              try {
                await transferTicketToHuman({
                  baseUrl: avanceaiBaseUrl,
                  apiId: avanceaiApiId,
                  bearerToken: avanceaiBearerToken,
                  phone,
                  channelId: resolvedChannelId,
                });
              } catch (transferErr) {
                console.log(
                  `[Webhook] Urgency transfer failed (non-blocking): ${(transferErr as Error).message}`,
                );
              }
            }
          }

          // FILA COM PRAZO QUANDO NINGUEM RECEBEU (rede, nao correcao ativa).
          // Medicao 10-15/08: as 10 urgencias sem linha em pending_human_transfers
          // sao TODAS anteriores a 11/08 18:22 — anteriores ao deploy do
          // transferirComDono. Depois dele, 13 de 13 entraram na fila com dona de
          // verdade. Este bloco existe para o caso que ainda nao apareceu na
          // amostra: equipe toda offline ou canal sem credencial.
          //
          // Nao chama recordPendingHumanTransfer as cegas: se ja existe linha
          // 'pending' para o mesmo telefone, aquele helper faz UPDATE, sobe
          // attempts_count para 2 e troca o nome da dona pela sentinela — e o
          // human-transfer-timeout expira EM SILENCIO tudo com attempts_count >= 2
          // (regra do spam do Massimo 28/07). Sem a checagem abaixo, esta
          // "melhoria" calaria um aviso que hoje sai.
          if (clinicTokenId && phone && !_urgT.ok) {
            try {
              let _telUrg = String(phone).replace(/\D/g, "");
              if (!_telUrg.startsWith("55")) _telUrg = "55" + _telUrg;
              const { data: _jaPendente } = await supabase
                .from("pending_human_transfers")
                .select("id")
                .eq("clinic_token_id", clinicTokenId)
                .eq("phone", _telUrg)
                .eq("status", "pending")
                .limit(1)
                .maybeSingle();
              if (!_jaPendente) {
                const _rcUrg = await getRoutingConfig(supabase, clinicTokenId);
                await recordPendingHumanTransfer(supabase, {
                  clinicTokenId,
                  conversationId,
                  phone: _telUrg,
                  intent: _ehEncaixe ? "encaixe" : "urgencia",
                  // Sentinela lida pelo human-transfer-timeout: sem este marcador o
                  // aviso de 15 min diria "a Fulana esta finalizando outro
                  // atendimento" para um caso que nao tem Fulana nenhuma.
                  attendantName: "(sem dono)",
                  attendantId: null,
                  timeoutMinutes: _rcUrg.human_response_timeout_minutes,
                });
              }
            } catch (e) {
              console.log(`[Webhook] urgencia: fila sem dona falhou (non-blocking): ${(e as Error).message}`);
            }
          }

          await supabase
            .from("webhook_messages")
            .update({
              action_status: _ehEncaixe ? "transferred_encaixe" : "transferred_urgency",
              action_error: _ehEncaixe
                ? "Pedido de encaixe na agenda — transferido para humano (Regra 4, sem alerta clínico)"
                : "Sinal de urgência/emergência detectado — transferido para humano (Regra 4)",
              ai_intent: _ehEncaixe ? "encaixe_transfer" : "urgency_transfer",
            })
            .eq("id", messageId);
          await auditTransfer(supabase, {
            clinicTokenId, conversationId, phone,
            initiatedBy: "julia", trigger: _ehEncaixe ? "encaixe" : "urgencia",
            reason: "regra_4_deteccao_deterministica",
            detail: (finalMessage || "").slice(0, 120),
          });

          if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
            // Dia fechado (feriado/emenda): a equipe NÃO está na clínica — a
            // orientação principal vira o pronto atendimento, e o caso fica
            // registrado para o retorno (o ticket já foi transferido acima).
            const _cdUrg = await getClosedDayInfo(supabase, clinicTokenId);
            // O texto SEGUE o que realmente aconteceu. Quando ninguém foi
            // designado (equipe offline), dizer "alguém vai te responder em
            // instantes" a um paciente com dor é a pior promessa possível: ele
            // para de procurar ajuda contando com uma resposta que não vem.
            const urgencyReply = _ehEncaixe
              // ENCAIXE: nenhuma das três frases abaixo serve — todas mandam o
              // paciente para o pronto-socorro. Aqui o assunto é agenda cheia.
              ? (_cdUrg.closedToday && _cdUrg.reopenISO
                  ? `Recebi seu pedido de encaixe! 🙏 Hoje nossa clínica está fechada${_cdUrg.reason ? ` (${_cdUrg.reason})` : ""} — deixei registrado aqui e nossa equipe verifica a agenda assim que voltarmos, em ${formatDateLabel(_cdUrg.reopenISO)}.`
                  : _urgT.ok
                    ? `Já passei seu pedido de encaixe para ${_urgT.attendantName || "nossa equipe"}, que verifica a agenda e te responde por aqui. 🙏`
                    : "Deixei seu pedido de encaixe registrado aqui. 🙏 Nossa equipe verifica a agenda e te responde assim que alguém estiver disponível.")
              : _cdUrg.closedToday && _cdUrg.reopenISO
              ? `Pelo que você descreveu, parece urgente. 🙏 Hoje nossa clínica está fechada${_cdUrg.reason ? ` (${_cdUrg.reason})` : ""} — se você está com uma emergência, procure um pronto-socorro ou UPA agora mesmo. Seu caso já ficou registrado aqui e nossa equipe te retorna assim que voltarmos, em ${formatDateLabel(_cdUrg.reopenISO)}.`
              : _urgT.ok
                ? `Pelo que você descreveu, parece urgente. 🙏 Já passei seu caso para ${_urgT.attendantName || "nossa equipe"}, que te responde por aqui. Se for emergência grave, procure também um pronto-socorro próximo.`
                : "Pelo que você descreveu, parece urgente. 🙏 Nossa equipe não está disponível neste momento — se você está com dor forte ou em emergência, procure um pronto-socorro ou UPA agora mesmo. Deixei seu caso registrado aqui e te respondem assim que alguém entrar.";
            await sendAvanceaiReply(
              avanceaiBaseUrl,
              avanceaiApiId,
              avanceaiBearerToken,
              phone,
              urgencyReply,
              resolvedChannelId,
            );
          }

          return new Response(
            JSON.stringify({ status: "success", action: "urgency_transfer", transferred: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // === FRUSTRATION DETECTION: força transferência imediata ===
      // Quando o paciente sinaliza frustração explícita, a IA sai de cena imediatamente
      // e o ticket vai pra um humano sem nova rodada de classificação.
      if (!keywordForcedIntent) {
        const frustrationPatterns = [
          /\beu\s+n[aã]o\s+estou\b/i,
          /\bvoc[eê]s?\s+est[aã]o\s+(me\s+)?(enrolando|brincando|errando)/i,
          /\bqual\s+(seu|teu)\s+nome\b/i,
          /\bvoc[eê]\s+[eé]\s+(um\s+)?(rob[oô]|bot|m[aá]quina|ia)\b/i,
          /\b(atendente|humano|pessoa)\s+(humano|de\s+verdade|agora|j[aá])\b/i,
          /\bquero\s+falar\s+com\s+(algu[eé]m|atendente|humano|pessoa)\b/i,
          /\bn[aã]o\s+(est[aá]\s+)?funcionando\b/i,
          /[A-ZÁÉÍÓÚÃÕÂÊÔÇ]{4,}.*[A-ZÁÉÍÓÚÃÕÂÊÔÇ]{4,}/, // duas palavras em CAPS LOCK
          /!{2,}/, // 2+ exclamações seguidas
        ];
        const isFrustrated = frustrationPatterns.some((p) => p.test(finalMessage));

        if (isFrustrated) {
          console.log(
            `[Webhook] 😤 Frustration detected in message — transferring to human immediately`,
          );

          if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
            // Mesmo tratamento da urgência: dona definida + aviso de 15 min.
            // Um paciente já irritado é o último que pode ficar esperando num
            // ticket sem responsável.
            const _frT = await transferirComDono(supabase, {
              clinicTokenId,
              conversationId,
              phone,
              intent: "frustracao",
              baseUrl: avanceaiBaseUrl,
              apiId: avanceaiApiId,
              bearerToken: avanceaiBearerToken,
              channelId: resolvedChannelId,
              currentMessageText: finalMessage || null,
            });
            if (!_frT.ok) {
              try {
                await transferTicketToHuman({
                  baseUrl: avanceaiBaseUrl,
                  apiId: avanceaiApiId,
                  bearerToken: avanceaiBearerToken,
                  phone,
                  channelId: resolvedChannelId,
                });
              } catch (transferErr) {
                console.log(
                  `[Webhook] Frustration transfer failed (non-blocking): ${(transferErr as Error).message}`,
                );
              }
            }
          }

          await supabase
            .from("webhook_messages")
            .update({
              action_status: "transferred_frustration",
              action_error: "Sinal de frustração detectado — transferido para humano",
              ai_intent: "frustration_transfer",
            })
            .eq("id", messageId);

          if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
            const ack =
              "Entendi, vou chamar uma de nossas atendentes pra te ajudar diretamente. Um momento, por favor 🙏";
            await sendAvanceaiReply(
              avanceaiBaseUrl,
              avanceaiApiId,
              avanceaiBearerToken,
              phone,
              ack,
              resolvedChannelId,
            );
          }

          return new Response(
            JSON.stringify({ status: "success", action: "frustration_transfer", transferred: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // === DETECT RECENT SUCCESSFUL BOOKING ===
      // If a booking was completed in the last 5 minutes, we must NOT re-inject scheduling entities
      // to prevent "Obrigada" from being misclassified as a new scheduling attempt.
      let recentBookingCompleted = false;
      if (conversationId && !isResetRequest) {
        try {
          const cutoff5min = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const { data: recentSuccess } = await supabase
            .from("webhook_messages")
            .select("id")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .eq("action_status", "success")
            .eq("ai_intent", "agendar")
            .gte("created_at", cutoff5min)
            .limit(1);
          if (recentSuccess && recentSuccess.length > 0) {
            // BUG 25/08 (primeira noite na infra propria): ENVIAR O LINK DO WIDGET
            // grava incoming com ai_intent="agendar" + action_status="success" — que e
            // exatamente o que a busca acima procura. So que link enviado NAO e consulta
            // marcada: o paciente que responde "quero por aqui" (prefere o chat ao link)
            // batia no POST-BOOKING GUARD, virava unknown, e em 4 mensagens o circuit
            // breaker transferia para humano. Aconteceu ao vivo no 1o teste do dono.
            //
            // Por que nao exigir booked_event_id (a auditoria real de booking): nao ha
            // booking de verdade no banco novo para confirmar que ele cai na INCOMING, e
            // apostar errado desarmaria o guard que impede agendamento duplicado — bug
            // pior que este.
            //
            // Correcao cirurgica: se a ultima resposta nossa foi o link do widget, nada
            // foi marcado, entao o guard nao arma.
            let apenasLinkDoWidget = false;
            try {
              const { data: ultimaSaida } = await supabase
                .from("webhook_messages")
                .select("ai_intent")
                .eq("conversation_id", conversationId)
                .eq("direction", "outgoing")
                .order("created_at", { ascending: false })
                .limit(1);
              apenasLinkDoWidget = String(ultimaSaida?.[0]?.ai_intent || "") === "widget_link_sent";
            } catch { /* na duvida, mantem o guard armado */ }

            if (apenasLinkDoWidget) {
              console.log(
                "[Webhook] \u21a9\ufe0f Recent 'agendar' era ENVIO DE LINK do widget, nao marcacao — guard NAO arma",
              );
            } else {
              recentBookingCompleted = true;
              console.log(
                "[Webhook] \u2705 Recent booking detected (last 10 min) — will suppress scheduling context injection",
              );
            }
          }
        } catch (rbErr) {
          console.log(`[Webhook] Recent booking check error (non-blocking): ${(rbErr as Error).message}`);
        }
      }

      // BUG 04/07 (consulta-fantasma do Dr. Arnaldo): apos um CANCELAMENTO, o
      // contexto do agendamento antigo (medico+data+hora) continuava vivo no
      // ai_entities por 48h. Um "quero marcar" novo recuperava tudo e REAGENDAVA
      // o mesmo slot sem perguntar nada. Regra: se o cancelar-sucesso mais
      // recente da conversa e' MAIS NOVO que o ultimo agendar-sucesso, o
      // contexto de agenda esta morto — nao recuperar data/hora/medico.
      let recentCancelInvalidatesContext = false;
      if (conversationId && !isResetRequest) {
        try {
          const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
          const { data: lastCancel } = await supabase
            .from("webhook_messages")
            .select("created_at")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .eq("action_status", "success")
            .eq("ai_intent", "cancelar")
            .gte("created_at", cutoff48h)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (lastCancel) {
            const { data: lastBook } = await supabase
              .from("webhook_messages")
              .select("created_at")
              .eq("conversation_id", conversationId)
              .eq("direction", "incoming")
              .eq("action_status", "success")
              .eq("ai_intent", "agendar")
              .gte("created_at", cutoff48h)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (!lastBook || String(lastCancel.created_at) > String(lastBook.created_at)) {
              recentCancelInvalidatesContext = true;
              console.log(
                "[Webhook] 🚫 Cancelamento mais recente que o último agendamento — contexto de agenda invalidado (sem recovery de data/hora/médico)",
              );
            }
          }
        } catch (rcErr) {
          console.log(`[Webhook] Recent cancel check error (non-blocking): ${(rcErr as Error).message}`);
        }
      }

      // === CONTEXT MEMORY INJECTION: Build accumulated entity summary from recent history ===
      // This ensures the AI model always sees key entities (doctor, CPF, date) explicitly,
      // even if they were mentioned many messages ago in the conversation.
      let enrichedHistory = [...conversationHistory];
      if (conversationId && !isResetRequest) {
        try {
          const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: recentEntities } = await supabase
            .from("webhook_messages")
            .select("ai_entities")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .not("ai_entities", "is", null)
            .gte("created_at", cutoff24h)
            .order("created_at", { ascending: false })
            .limit(15);

          if (recentEntities && recentEntities.length > 0) {
            const accumulated: Record<string, string> = {};
            // If a booking was just completed, exclude scheduling entities to prevent re-scheduling
            const keysToTrack = (recentBookingCompleted || recentCancelInvalidatesContext)
              ? ["cpf", "patient_full_name", "complaint", "insurance_choice"]
              : [
                  "doctor_name",
                  "cpf",
                  "date",
                  "time",
                  "subspecialty",
                  "complaint",
                  "preferred_weekday",
                  "preferred_period",
                  "attendance_id",
                  "patient_full_name",
                  "insurance_choice",
                ];
            // Iterate most recent first — first value found wins
            for (const msg of recentEntities) {
              const ent = msg.ai_entities as Record<string, unknown>;
              if (!ent) continue;
              for (const key of keysToTrack) {
                if (!accumulated[key] && ent[key]) {
                  accumulated[key] = String(ent[key]);
                }
              }
            }

            const parts: string[] = [];
            if (accumulated.doctor_name) parts.push(`Médico: ${accumulated.doctor_name}`);
            if (accumulated.cpf) parts.push(`CPF: ${accumulated.cpf}`);
            if (accumulated.date) parts.push(`Data: ${accumulated.date}`);
            if (accumulated.time) parts.push(`Horário: ${accumulated.time}`);
            if (accumulated.subspecialty) parts.push(`Especialidade: ${accumulated.subspecialty}`);
            if (accumulated.patient_full_name) parts.push(`Paciente: ${accumulated.patient_full_name}`);
            if (accumulated.attendance_id) parts.push(`Atendimento: ${accumulated.attendance_id}`);

            if (parts.length > 0) {
              let contextSummary = `[CONTEXTO ACUMULADO DA CONVERSA: ${parts.join(", ")}]`;
              if (recentBookingCompleted) {
                contextSummary += ` [NOTA: Um agendamento foi concluído com sucesso há poucos minutos. NÃO tente agendar novamente a menos que o paciente peça EXPLICITAMENTE um novo agendamento.]`;
              }
              if (recentCancelInvalidatesContext) {
                contextSummary += ` [NOTA: O paciente CANCELOU a última consulta. O contexto antigo de data/horário/médico NÃO vale mais. Para novo agendamento, pergunte do zero o que ele deseja — NUNCA reutilize a data/horário da consulta cancelada.]`;
              }
              console.log(`[Webhook] Injecting context summary: ${contextSummary}`);
              enrichedHistory = [{ role: "system" as const, content: contextSummary }, ...enrichedHistory];
            }
          }
        } catch (ctxErr) {
          console.log(`[Webhook] Context summary build error (non-blocking): ${(ctxErr as Error).message}`);
        }
      }

      // === CONVERSATION STATE INJECTION (replaces older slot_lock-only injection) ===
      // Reads the authoritative state machine row and tells the classifier explicitly
      // what we're expecting. Far stronger than ad-hoc inference. Falls back to slot_lock
      // check if no state row exists (transitional support — until all flows wire state).
      // NOTA: currentConvState foi lido mais acima (antes do greeting shortcut) e
      // pode ter sido zerado pelo stale-cleanup. Não relê aqui.

      if (currentConvState && currentConvState.current_state !== "idle" && currentConvState.current_state !== "closed") {
        const c = currentConvState.context || {};
        const expectedList = (currentConvState.expected_inputs || []).join(", ") || "(qualquer)";
        let stateMsg = `[ESTADO ATUAL DA CONVERSA: ${currentConvState.current_state}. `;
        if (c.doctor_name) stateMsg += `Médico em andamento: ${c.doctor_name}. `;
        if (c.date) stateMsg += `Data: ${c.date}. `;
        if (c.time) stateMsg += `Horário: ${c.time}. `;
        if (c.insurance_choice) stateMsg += `Convênio: ${c.insurance_choice}. `;
        if (c.attendance_id) stateMsg += `Agendamento ID: ${c.attendance_id}. `;
        stateMsg += `Inputs esperados agora: ${expectedList}. `;
        if (currentConvState.current_state === "awaiting_cpf") {
          stateMsg += `Reserva ativa - qualquer resposta curta (CPF, número, convênio, "sim") preenche esse agendamento em andamento — NÃO classifique como unknown. NUNCA peça pra confirmar médico ou data novamente, já estão reservados.`;
        } else if (currentConvState.current_state === "awaiting_confirmation") {
          stateMsg += `IA pediu confirmação. "sim"/"confirmo"/"é essa"/"ok" → intent atual com confirmed=true.`;
        } else if (currentConvState.current_state === "awaiting_registration") {
          stateMsg += `Paciente está fornecendo dados cadastrais (nome, CPF, nascimento, convênio). Mantenha intent "cadastrar".`;
        } else if (currentConvState.current_state === "slot_search") {
          stateMsg += `IA mostrou horários disponíveis. Resposta com data+hora preenche o agendamento - intent "agendar".`;
        } else if (currentConvState.current_state === "cancel_pending") {
          stateMsg += `IA pediu para o paciente escolher qual agendamento cancelar. Número ou ID = intent "cancelar" com attendance_id.`;
        } else if (currentConvState.current_state === "reschedule_search") {
          stateMsg += `Reagendamento em curso. Resposta com data/hora = intent "reagendar".`;
        } else if (currentConvState.current_state === "booking_created") {
          stateMsg += `Agendamento recém-criado. Mensagens de agradecimento, confirmação ou perguntas sobre o local são esperadas — não tente re-agendar.`;
        } else if (currentConvState.current_state === "transferred_human") {
          // P3: se handoff foi por ESPECIALIDADE (infiltracao/exame/cirurgia), o
          // stale-cleanup mantem o estado e a IA NUNCA pode oferecer agenda de
          // consulta comum. Conv. 33 Milena (19/06) entrou em loop porque a IA
          // identificou infiltracao, transferiu pra Lidiane, e depois continuou
          // oferecendo horario.
          const handoffReason = String(currentConvState.context?.handoff_reason || "");
          if (handoffReason === "infiltracao") {
            stateMsg += `PACIENTE EM FLUXO DE INFILTRAÇÃO. Já foi transferida para Lidiane (responsável). PROIBIDO oferecer agenda de consulta comum, pedir CPF/dados cadastrais, mencionar médicos ou horários. Se o paciente perguntar algo, responda APENAS confirmando que Lidiane está em contato e que ela cuida do processo de infiltração (documentação, autorização da guia, agendamento próprio do procedimento). NUNCA classifique como "agendar".`;
          } else if (handoffReason === "exame") {
            stateMsg += `PACIENTE EM FLUXO DE EXAME. Já foi encaminhada para a equipe responsável. PROIBIDO oferecer agenda de consulta. Apenas confirme que a equipe está em contato pra dar continuidade ao pedido do exame.`;
          } else if (handoffReason === "cirurgia") {
            stateMsg += `PACIENTE EM FLUXO DE CIRURGIA/PÓS-OPERATÓRIO. Já foi transferida para Vânia. PROIBIDO oferecer agenda de consulta. Apenas confirme que Vânia está em contato.`;
          } else {
            // Sem handoff_reason explicito — fluxo neutro. Defesa em profundidade
            // pra nao gerar alucinacoes de "estou te transferindo".
            stateMsg += `Atendimento prévio pode ter envolvido transferência humana. Trate esta nova mensagem normalmente como uma interação fresca.`;
          }
        }
        stateMsg += `]`;
        console.log(`[ConversationState] Injecting state context: state=${currentConvState.current_state}, expects=[${expectedList}]`);
        enrichedHistory = [{ role: "system" as const, content: stateMsg }, ...enrichedHistory];
      } else if (clinicTokenId && phone && !isResetRequest) {
        // Fallback for conversations that don't have a state row yet (transitional):
        // still inject from slot_locks like the old behavior.
        try {
          const phoneVariants = phoneVariantsForState(phone);
          const { data: activeLocks } = await supabase
            .from("slot_locks")
            .select("doctor_id, slot_date, slot_time, expires_at")
            .eq("clinic_token_id", clinicTokenId)
            .in("phone", phoneVariants)
            .gt("expires_at", new Date().toISOString())
            .order("locked_at", { ascending: false })
            .limit(1);
          if (activeLocks && activeLocks.length > 0) {
            const lock = activeLocks[0] as any;
            const lockMsg = `[ESTADO ATUAL: paciente acabou de reservar slot ${lock.slot_date} ${String(lock.slot_time).slice(0,5)} com médico ${lock.doctor_id} (reserva válida por mais alguns minutos). IA pediu CPF e convênio. Qualquer resposta curta agora (nome de convênio, horário, "sim", "ok", número de CPF, nome) deve ser interpretada como preenchimento desse agendamento em andamento — NÃO classifique como unknown.]`;
            console.log(`[Webhook] Injecting active slot_lock context (fallback): doctor=${lock.doctor_id} ${lock.slot_date} ${lock.slot_time}`);
            enrichedHistory = [{ role: "system" as const, content: lockMsg }, ...enrichedHistory];
          }
        } catch (lockErr) {
          console.log(`[Webhook] slot_lock context build error (non-blocking): ${(lockErr as Error).message}`);
        }
      }

      // === ORPHAN-ACK GUARD v2: silencia "sim/não/ok" curtos sem pergunta interativa real ===
      // Cobre tanto ACK respondendo confirmação externa (notificação automática enviada
      // dias antes) quanto ACK órfão sem qualquer pergunta nossa.
      try {
        const ackText = (finalMessage || "").trim();
        const ACK_REGEX = /^(sim|não|nao|ok|okay|tudo bem|certo|confirmo|confirmado|s|n|👍|✅|👌)[\s\.\!\?]*$/i;
        const isShortAck = ackText.length > 0 && ackText.length <= 12 && ACK_REGEX.test(ackText);

        if (isShortAck && !isResetRequest && !keywordForcedIntent) {
          // Fallback: se conversationId ainda é null, tenta achar pela phone+clinic
          let convForGuard = conversationId;
          if (!convForGuard && phone && clinicTokenId) {
            const { data: c } = await supabase
              .from("chat_conversations")
              .select("id")
              .eq("phone", phone)
              .eq("clinic_token_id", clinicTokenId)
              .maybeSingle();
            convForGuard = c?.id ?? null;
          }

          if (convForGuard) {
            // Janela 7 dias: confirmações externas costumam vir 1-3 dias antes
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data: recentOuts } = await supabase
              .from("webhook_messages")
              .select("ai_response, message_text, ai_intent, created_at")
              .eq("conversation_id", convForGuard)
              .eq("direction", "outgoing")
              .gte("created_at", sevenDaysAgo)
              .order("created_at", { ascending: false })
              .limit(10);

            // (B) Detecta confirmação externa em qualquer outgoing dos últimos 7 dias
            const EXTERNAL_CONFIRM_RE = /\b(responda\s*(somente|apenas)?:?\s*\*?(sim|não|nao)\*?|confirme\s*(somente|apenas)?:?\s*\*?(sim|não|nao)\*?|você\s*tem\s*um\s*atendimento\s*agendado|atendimento\s*agendado.*?(dia|horário|horario|unidade)|lembrete\s*de\s*consulta|sua\s*consulta\s*(está|esta)\s*marcada)/i;
            const externalConfirmFound = (recentOuts || []).some((o) =>
              EXTERNAL_CONFIRM_RE.test((o.ai_response || o.message_text || ""))
            );

            // (C) Pergunta nossa REAL: outgoing nas últimas 2h, não manual_reply, com marca de pergunta
            const lastReal = (recentOuts || []).find((o) => {
              const ageMin = (Date.now() - new Date(o.created_at).getTime()) / 60000;
              if (ageMin > 120) return false;
              if (o.ai_intent === "manual_reply") return false;
              const txt = (o.ai_response || o.message_text || "").trim();
              if (!txt) return false;
              return /\?\s*$/.test(txt) ||
                /\b(deseja|confirma|é\s*essa|posso|quer|gostaria|prefere|escolha|qual|correto|certo\?)\b/i.test(txt);
            });

            // EXCEÇÃO (auditoria 10/07): se há OFERTA DE VAGA da lista de espera
            // válida (notified, não vencida) para este telefone, o "sim" é a
            // resposta MAIS natural à oferta — não pode ser silenciado como
            // confirmação externa. Deixa passar para o guard [WaitlistReply].
            let _wlOfferPending = false;
            if (externalConfirmFound && clinicTokenId && phone) {
              try {
                const { data: _wlChk } = await supabase
                  .from("waitlist_entries")
                  .select("id")
                  .eq("clinic_token_id", clinicTokenId)
                  .in("phone", getPhoneVariants(phone))
                  .eq("status", "notified")
                  .gte("expires_at", new Date().toISOString())
                  .limit(1);
                _wlOfferPending = !!(_wlChk && _wlChk.length > 0);
                if (_wlOfferPending) {
                  console.log(`[Webhook] ORPHAN-ACK: oferta de lista de espera VÁLIDA pendente — ACK segue para o WaitlistReply`);
                }
              } catch { /* non-blocking */ }
            }

            // Confirmação externa pega → silêncio total, mesmo se houver "pergunta" nossa
            if (externalConfirmFound && !_wlOfferPending) {
              console.log(`[Webhook] 🤐 ORPHAN-ACK GUARD v2: "${ackText}" → confirmação externa detectada nos últimos 7d → skip`);
              await supabase.from("webhook_messages").update({
                action_status: "skipped",
                ai_intent: "orphan_ack_external_confirm",
                action_error: "ACK curto respondendo notificação externa de confirmação (sistema fora do nosso pipeline)",
              }).eq("id", messageId);
              return new Response(
                JSON.stringify({ status: "skipped", reason: "orphan_ack_external_confirm", message: ackText }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }

            // Sem pergunta nossa real recente → skip
            if (!lastReal) {
              console.log(`[Webhook] 🤐 ORPHAN-ACK GUARD v2: "${ackText}" sem pergunta interativa nossa <2h → skip`);
              await supabase.from("webhook_messages").update({
                action_status: "skipped",
                ai_intent: "orphan_ack",
                action_error: "ACK curto sem pergunta interativa nossa nas últimas 2 horas",
              }).eq("id", messageId);
              return new Response(
                JSON.stringify({ status: "skipped", reason: "orphan_ack", message: ackText }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            console.log(`[Webhook] ORPHAN-ACK GUARD v2: "${ackText}" segue pergunta real nossa <2h → processa`);
          } else {
            // Sem conversa nenhuma e ACK curto → skip preventivo
            console.log(`[Webhook] 🤐 ORPHAN-ACK GUARD v2: "${ackText}" sem conversa associada → skip`);
            await supabase.from("webhook_messages").update({
              action_status: "skipped",
              ai_intent: "orphan_ack",
              action_error: "ACK curto sem conversa associada",
            }).eq("id", messageId);
            return new Response(
              JSON.stringify({ status: "skipped", reason: "orphan_ack_no_conv", message: ackText }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }
      } catch (ackErr) {
        console.log(`[Webhook] Orphan-ack guard error (non-blocking): ${(ackErr as Error).message}`);
      }

      // === POST-CONSULT / GOOGLE REVIEW SILENCE GUARD (12h) ===
      // Se a clínica enviou (pelo mesmo número, fora do nosso pipeline) um resumo de
      // pós-consulta ou um pedido de avaliação no Google nos últimos 12h, silenciamos
      // qualquer resposta do paciente para a IA não "entrar por cima".
      try {
        if (!isResetRequest && !keywordForcedIntent) {
          let convForPC = conversationId;
          if (!convForPC && phone && clinicTokenId) {
            const { data: c } = await supabase
              .from("chat_conversations")
              .select("id")
              .eq("phone", phone)
              .eq("clinic_token_id", clinicTokenId)
              .maybeSingle();
            convForPC = c?.id ?? null;
          }

          if (convForPC) {
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            const { data: recentOuts12h } = await supabase
              .from("webhook_messages")
              .select("ai_response, message_text, created_at")
              .eq("conversation_id", convForPC)
              .eq("direction", "outgoing")
              .gte("created_at", twelveHoursAgo)
              .order("created_at", { ascending: false })
              .limit(15);

            const POST_CONSULT_RE = /(resumo\s+da\s+consulta|hip[óo]tese\s+diagn[óo]stica|consulta\s+com\s+dr|👨‍⚕️[\s\S]*?📋[\s\S]*?💊|o\s+que\s+fazer[\s\S]{0,80}(consulta|dr\.?|👨‍⚕️))/i;
            const GOOGLE_REVIEW_RE = /(g\.page\/r\/|search\.google\.com\/local\/writereview|avalia[çc][ãa]o\s+no\s+google|deixe\s+uma\s+avalia[çc][ãa]o)/i;

            let matchedReason: "post_consult_silence" | "google_review_silence" | null = null;
            for (const o of recentOuts12h || []) {
              const txt = (o.ai_response || o.message_text || "");
              if (!txt) continue;
              if (GOOGLE_REVIEW_RE.test(txt)) { matchedReason = "google_review_silence"; break; }
              if (POST_CONSULT_RE.test(txt)) { matchedReason = "post_consult_silence"; break; }
            }

            if (matchedReason) {
              console.log(`[Webhook] 🤐 POST-CONSULT GUARD: ${matchedReason} detectado nos últimos 12h → skip`);
              await supabase.from("webhook_messages").update({
                action_status: "skipped",
                ai_intent: matchedReason,
                action_error: matchedReason === "google_review_silence"
                  ? "Pedido de avaliação no Google enviado nos últimos 12h — IA silenciada para não interferir."
                  : "Resumo de pós-consulta enviado nos últimos 12h — IA silenciada para não interferir.",
              }).eq("id", messageId);

              return new Response(
                JSON.stringify({ status: "skipped", reason: matchedReason }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          }
        }
      } catch (pcErr) {
        console.log(`[Webhook] Post-consult guard error (non-blocking): ${(pcErr as Error).message}`);
      }



      console.log("[Webhook] Classifying intent with AI (with conversation memory + context summary)...");
      let classification;
      try {
        if (isResetRequest) {
          console.log("[Webhook] Reset keyword detected, forcing resetar_conversa intent");
          classification = {
            intent: "resetar_conversa",
            cpf: "",
            doctor_name: "",
            subspecialty: "",
            complaint: "",
            date: "",
            time: "",
            preferred_weekday: "",
            preferred_period: "",
            attendance_id: "",
            patient_full_name: "",
            insurance_choice: "",
            patient_birth_date: "",
            attendant_name: "",
            confidence: 1.0,
          };
        } else if (keywordForcedIntent) {
          // Keyword pre-check already determined intent — skip AI classification entirely
          console.log(
            `[Webhook] Using keyword-forced intent: ${keywordForcedIntent.intent} (target="${keywordForcedIntent.attendant_name}")`,
          );
          classification = {
            intent: keywordForcedIntent.intent,
            cpf: "",
            doctor_name: "",
            subspecialty: "",
            complaint: "",
            date: "",
            time: "",
            preferred_weekday: "",
            preferred_period: "",
            attendance_id: "",
            patient_full_name: "",
            insurance_choice: "",
            patient_birth_date: "",
            attendant_name: keywordForcedIntent.attendant_name,
            confidence: 1.0,
          };
        } else {
          classification = await classifyIntent(classificationMessage, LOVABLE_API_KEY, dynamicScript, enrichedHistory, clinicTokenId);
        }

        // Tema 1 (fallback deterministico de reagendar): se o classificador caiu em
        // agendar/unknown MAS a mensagem traz um sinal INEQUIVOCO de remarcar uma
        // consulta JA existente, corrige para reagendar. So' usa termos que referenciam
        // uma consulta existente — "quero marcar" puro nao casa.
        if (classification.intent === "agendar" || classification.intent === "unknown") {
          const reagMsg = stripAccents((finalMessage || "").toLowerCase());
          const reagendarSignal =
            /\bremarc(ar|a|ei|o)\b/.test(reagMsg) ||
            /\breagend(ar|a|ei|o)\b/.test(reagMsg) ||
            /\b(passar|mudar|trocar|transferir|adiar|antecipar)\b[^.]*\b(minha|a)\s+consulta\b/.test(reagMsg) ||
            /\bminha\s+consulta\b[^.]*\b(pra|para|pro)\s+(outro|outra)\b/.test(reagMsg);
          if (reagendarSignal) {
            console.log(
              `[Webhook] ⚙️ Fallback deterministico: intent "${classification.intent}" -> "reagendar" (sinal de remarcar consulta existente)`,
            );
            classification.intent = "reagendar";
          }
        }

        // === BRADESCO EFETIVO IV: MÉDICO ÚNICO (regra do dono, 31/08) ===
        // "Apenas eu posso atender esse plano." Ombro, cotovelo e joelho são dele;
        // o resto o plano não cobre aqui. Quando a região é dele, o médico fica
        // CRAVADO na classificação — assim o fluxo normal segue pelo caminho de
        // "paciente pediu um médico pelo nome", que já é proibido de oferecer
        // alternativa (OVERRIDE 2). Sem isso, uma queixa de joelho seria roteada
        // para o Dr. Hugo ou o Dr. Felipe, que não atendem este plano.
        // A recusa e a pergunta de região ficam no executeAction, junto do guard
        // de dia fechado — é lá que dá para responder sem agendar.
        const _efIV = avaliarEfetivoIV(
          textoDoPacienteRecente(finalMessage, conversationHistory),
          `${classification.subspecialty || ""} ${classification.complaint || ""}`,
        );
        if (_efIV.plano) {
          // viaja junto para o executeAction decidir agendar, recusar ou perguntar
          (classification as Record<string, unknown>).efetivo_iv = _efIV.regiao;
          if (_efIV.regiao === "aceita" && !classification.doctor_name) {
            console.log(`[EfetivoIV] plano + região dele — médico cravado: ${EFETIVO_IV_MEDICO.nome}`);
            classification.doctor_name = EFETIVO_IV_MEDICO.nome;
          } else if (_efIV.regiao !== "aceita") {
            console.log(`[EfetivoIV] plano detectado, região "${_efIV.regiao}" — agendamento vai ser barrado`);
          }
        }

        // === INFILTRAÇÃO NUNCA É AGENDADA PELO ROBÔ (regra do dono, 28/07) ===
        // "De jeito nenhum pode ser feito automaticamente." A documentação
        // (carteirinha, documento, laudo da RM) e o dia da infiltração são feitos por
        // uma atendente — qualquer uma, mas sempre uma pessoa.
        // A palavra-chave já cobre a mensagem que CONTÉM "infiltra*". O buraco era o
        // TURNO SEGUINTE: depois de "infiltração no joelho" (que vai para a atendente),
        // um simples "pode ser dia 30 às 10h" não tem a palavra, virava 'agendar' e o
        // robô marcava sozinho. Aqui, se a conversa das últimas 72h tratou de
        // infiltração, o 'agendar' é redirecionado para o handler REAL de infiltração
        // — que pede os documentos e TRANSFERE de fato (só auditar não transferiria).
        // Ele já tem dedup de 60min, então não vira repetição de mensagem.
        if (classification.intent === "agendar" && temContextoDeInfiltracao(conversationHistory)) {
          console.log(`[Webhook] ⛔ GUARD INFILTRAÇÃO: contexto de infiltração em 72h — 'agendar' vira solicitar_infiltracao`);
          classification.intent = "solicitar_infiltracao";
        }

        // === CPF QUEBRADO NUNCA VAI PARA BUSCA (caso Renan 31/07) ===
        // O paciente perguntou "minha consulta é presencial ou online?" e recebeu
        // "não encontrei um cadastro com esse número" — sendo que ele EXISTE. O CPF
        // veio do histórico já MASCARADO ("***.344.708-**"); os 9 pontos que fazem
        // `entities.cpf.replace(/\D/g,"")` transformaram isso em "34470894" — oito
        // dígitos — e buscaram com um CPF quebrado. Ele teve que digitar tudo de novo.
        // Saneamento único aqui: sem 11 dígitos, é como se não houvesse CPF, e cada
        // case já sabe pedir educadamente. Normaliza para dígitos de uma vez.
        // (Só o COMPRIMENTO, de propósito — não exijo dígito verificador: cadastro
        // antigo do EHR pode ter CPF com erro de digitação e ainda assim ser o certo.)
        if (classification.cpf) {
          const _cpfDigitos = String(classification.cpf).replace(/\D/g, "");
          if (_cpfDigitos.length !== 11) {
            console.log(`[CPF] descartado: "${String(classification.cpf).slice(0, 8)}…" tem ${_cpfDigitos.length} dígitos (mascarado/truncado) — melhor pedir do que buscar errado`);
            classification.cpf = "";
          } else {
            classification.cpf = _cpfDigitos;
          }
        }

        // === LISTA DE ESPERA: resposta à oferta de vaga (06/07) ===
        // Só captura quando (a) existe entry notified NÃO vencida deste telefone e
        // (b) a ÚLTIMA outgoing da conversa é a própria oferta (waitlist_offer) —
        // um "sim" respondendo outra pergunta segue o fluxo normal. Aceite: curto
        // e sem dígitos. Recusa testa primeiro ("não quero" contém "quero").
        // Aceite força intent=agendar com o slot ofertado — o fluxo normal cuida
        // de CPF, tipo de consulta, convênio, auditoria e verify-booking.
        try {
          const _wlTxt = (finalMessage || "").trim();
          const _wlDecline = WAITLIST_DECLINE_RE.test(_wlTxt) && _wlTxt.length <= 60;
          const _wlAccept = !_wlDecline && WAITLIST_ACCEPT_RE.test(_wlTxt) && _wlTxt.length <= 40 && !/\d/.test(_wlTxt);
          if ((_wlAccept || _wlDecline) && conversationId && clinicTokenId && phone) {
            // ACEITE TARDIO (caso Marcia 21/07): "quero" 51min DEPOIS da oferta expirar
            // caía no LLM → reagendar vazio → fallback ("pode me confirmar o médico?").
            // Agora a entry WAITING com a última vaga ofertada guardada também conta —
            // o fluxo forçado valida a vaga na hora (se foi tomada, falha educadamente).
            const _wlNowIso = new Date().toISOString();
            const { data: _wlPend } = await supabase
              .from("waitlist_entries")
              .select("id, status, offered_slot, doctor_name, expires_at")
              .eq("clinic_token_id", clinicTokenId)
              .in("phone", getPhoneVariants(phone))
              .in("status", ["notified", "waiting"])
              .order("updated_at", { ascending: false })
              .limit(1);
            const _wlEntry = _wlPend?.[0] as any;
            const _wlLate = !(
              _wlEntry?.status === "notified" &&
              _wlEntry?.expires_at && String(_wlEntry.expires_at) >= _wlNowIso
            );
            if (_wlEntry?.offered_slot?.date && _wlEntry?.offered_slot?.time) {
              // Auditoria 10/07: exigir que a ÚLTIMA outgoing fosse a oferta era
              // frágil — qualquer mensagem no meio (follow-up, "bom dia") matava o
              // aceite. E buscar pela CONVERSA quebrava quando o cron gravou a oferta
              // com conversation_id nulo/diferente. Agora: HOUVE oferta para este
              // TELEFONE nesta clínica dentro de 12h — cobre o TTL de 3h (BUG antigo:
              // a janela ficou em 60min quando o TTL foi pra 180 — aceite entre 1h e
              // 3h era ignorado!) E a janela do aceite tardio pós-expiração.
              const _sinceOfferWl = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
              const { data: _wlLastOut } = await supabase
                .from("webhook_messages")
                .select("ai_intent")
                .eq("clinic_token_id", clinicTokenId)
                .in("sender_phone", getPhoneVariants(phone))
                .eq("direction", "outgoing")
                .eq("ai_intent", "waitlist_offer")
                .gte("created_at", _sinceOfferWl)
                .limit(1);
              if (_wlLastOut && _wlLastOut.length > 0) {
                if (_wlLate) console.log(`[WaitlistReply] aceite/recusa TARDIO (oferta expirada) — processando mesmo assim`);
                if (_wlDecline) {
                  console.log(`[WaitlistReply] recusa detectada — devolvendo vaga à fila`);
                  classification.intent = "recusar_vaga_espera";
                } else {
                  // Entrada na lista exige consulta marcada (regra 06/07 v2), então o
                  // aceite REAGENDA a consulta existente para a vaga — nunca duplica.
                  console.log(
                    `[WaitlistReply] ✅ oferta aceita — forçando reagendar para ${_wlEntry.offered_slot.date} ${_wlEntry.offered_slot.time} com ${_wlEntry.doctor_name}`,
                  );
                  classification.intent = "reagendar";
                  classification.date = String(_wlEntry.offered_slot.date);
                  classification.time = String(_wlEntry.offered_slot.time);
                  classification.doctor_name = String(_wlEntry.doctor_name || classification.doctor_name || "");
                  // Caso Felipe 19/07: "pode confirmar" fazia o LLM setar
                  // reagendar_confirmed=true SEM attendance_id → passo confirmado →
                  // "ID do agendamento inválido". O aceite começa SEMPRE do passo de
                  // busca (CPF → localizar a consulta-base real → "é essa?").
                  (classification as any).reagendar_confirmed = false;
                  classification.attendance_id = "";
                  // Auditoria 10/07: o fluxo pós-aceite pode levar 2-3 turnos (CPF,
                  // "é essa?") — estende a validade da oferta em +30min para a cadeia
                  // não morrer no meio (o cron expiraria e requeueria durante o CPF).
                  try {
                    await supabase
                      .from("waitlist_entries")
                      .update({ expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), updated_at: new Date().toISOString() })
                      .eq("id", _wlEntry.id);
                  } catch { /* non-blocking */ }
                }
              }
            }
          }
        } catch (e) {
          console.log(`[WaitlistReply] check error (non-blocking): ${(e as Error).message}`);
        }

        // === RECUPERAÇÃO DE CPF (Paciente Teste 06/07: CPF travava o agendamento) ===
        // A Julia reservou o slot, pediu o CPF (estado awaiting_cpf) e o paciente
        // mandou o CPF cru ("<cpf-removido>") — mas o classificador LLM devolveu
        // "unknown" mesmo com o contexto de slot_lock injetado, e sem intent o
        // agendamento não avançava (Julia ficava muda). Determinístico (mesma
        // filosofia dos fallbacks de data/urgência — não confiar no LLM p/ dado
        // crítico): se há estado awaiting_cpf válido com médico+data+hora e a
        // mensagem é essencialmente um CPF, força agendar com o CPF + o slot
        // reservado. O fluxo de agendar cuida do resto (lookup: existente→confirma,
        // novo→cadastro).
        if (
          clinicTokenId && phone &&
          (classification.intent === "unknown" ||
            (classification.intent === "agendar" && !classification.cpf) ||
            (classification.intent === "cadastrar" && !classification.cpf))
        ) {
          try {
            // Extrai CPF com validação de dígito verificador (não confunde com telefone
            // de 11 dígitos, e sobrevive a mensagens com data/hora junto). Ignora o
            // próprio telefone do remetente.
            const _cpfDigits = extractCpfFromText(finalMessage || "", { excludeDigits: phone || "" }) || "";
            const _looksLikeCpf = !!_cpfDigits && isValidCpf(_cpfDigits);
            if (_looksLikeCpf) {
              const _st = await getConversationState(supabase, clinicTokenId, phone);
              const _ctx = (_st?.context || {}) as Record<string, any>;
              if (_st?.current_state === "awaiting_cpf" && _ctx.date && _ctx.time) {
                console.log(
                  `[CpfRecovery] ✅ CPF cru + estado awaiting_cpf — forçando agendar (${_ctx.doctor_name || "?"} ${_ctx.date} ${_ctx.time})`,
                );
                classification.intent = "agendar";
                classification.cpf = _cpfDigits;
                classification.date = String(_ctx.date);
                classification.time = String(_ctx.time);
                if (_ctx.doctor_name) classification.doctor_name = String(_ctx.doctor_name);
                if (_ctx.insurance_choice) classification.insurance_choice = String(_ctx.insurance_choice);
              }
            }
          } catch (e) {
            console.log(`[CpfRecovery] error (non-blocking): ${(e as Error).message}`);
          }
        }

        // === PERÍODO DA LISTA DE ESPERA (pedido 10/07) ===
        // A entrada na lista pergunta "qual período você prefere para antecipar?".
        // Resposta determinística: última outgoing tem o marcador + mensagem casa
        // manhã/tarde/qualquer → grava na entry e confirma (sem LLM).
        try {
          const _wpPeriod = parseWaitlistPeriod(finalMessage || "");
          if (_wpPeriod && conversationId && clinicTokenId && phone) {
            const _since60wp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const { data: _wpOut } = await supabase
              .from("webhook_messages")
              .select("message_text")
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .gte("created_at", _since60wp)
              .order("created_at", { ascending: false })
              .limit(4);
            const _wpAsked = (_wpOut || []).some((m: any) =>
              String(m.message_text || "").includes("qual período você prefere para antecipar"),
            );
            if (_wpAsked) {
              console.log(`[WaitlistPeriod] período "${_wpPeriod}" capturado — gravando na entry`);
              await supabase
                .from("waitlist_entries")
                .update({ preferred_period: _wpPeriod === "qualquer" ? null : _wpPeriod, updated_at: new Date().toISOString() })
                .eq("clinic_token_id", clinicTokenId)
                .in("phone", getPhoneVariants(phone))
                .in("status", ["waiting", "notified"]);
              (classification as any)._waitlist_period_set = _wpPeriod;
              classification.intent = "confirmar_periodo_espera";
            }
          }
        } catch (e) {
          console.log(`[WaitlistPeriod] check error (non-blocking): ${(e as Error).message}`);
        }

        // === ACEITAÇÃO DA OFERTA DE REGISTRO (10/07, teste do usuário) ===
        // A Julia ofereceu "deixar registrado / falar com atendente" (dia fechado:
        // marcador "equipe volta em"; fim de dia: "encerra às") e o paciente ACEITOU
        // ("pode deixar registrado") — mas o classificador não devolvia
        // falar_com_atendente e NADA acontecia. Determinístico: última outgoing é a
        // oferta + mensagem aceita → força falar_com_atendente (o case, já avisado,
        // transfere de verdade).
        try {
          const _hoTxt = (finalMessage || "").trim();
          if (
            conversationId &&
            _hoTxt.length <= 70 &&
            classification.intent !== "falar_com_atendente" &&
            HANDOFF_OFFER_ACCEPT_RE.test(_hoTxt)
          ) {
            const _since10ho = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const { data: _hoOut } = await supabase
              .from("webhook_messages")
              .select("message_text")
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .gte("created_at", _since10ho)
              .order("created_at", { ascending: false })
              .limit(2);
            const _hoOffered = (_hoOut || []).some((m: any) => {
              const t = String(m.message_text || "");
              return t.includes("equipe volta em") || t.includes("encerra às");
            });
            if (_hoOffered) {
              console.log(`[HandoffOffer] ✅ paciente aceitou registrar/atendente — forçando falar_com_atendente`);
              classification.intent = "falar_com_atendente";
            }
          }
        } catch (e) {
          console.log(`[HandoffOffer] check error (non-blocking): ${(e as Error).message}`);
        }

        // SAFETY (caso Carina 03/06): se o classificador devolveu unknown MAS a mensagem
        // casa o padrão "<dia da semana>, ?<HH>h<MM>" / "<DD/MM>, ?<HH>:<MM>" / "<DD/MM>
        // às <HH>h" E há mensagem outgoing recente oferecendo horários, força agendar
        // com a date+time extraídas. Isso impede que escolhas de slot virem unknown
        // sem POST.
        if (classification.intent === "unknown" && conversationId) {
          try {
            const rawMsg = (finalMessage || "").trim();
            const weekdays: Record<string, number> = {
              "domingo": 0, "segunda": 1, "terca": 2, "terça": 2, "quarta": 3,
              "quinta": 4, "sexta": 5, "sabado": 6, "sábado": 6,
            };
            const wkMatch = rawMsg.toLowerCase().match(
              /\b(domingo|segunda|terc[aá]|quarta|quinta|sexta|s[aá]bado)(?:[-\s]feira)?[,\s]*(\d{1,2})\s*(?::|h|hs|horas?|\s)?\s*(\d{2})?/i,
            );
            const ddmmMatch = rawMsg.toLowerCase().match(
              /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?[,\s]+(?:(?:[aá]s|at[eé]\s+as|nas?)\s*)?(\d{1,2})\s*(?::|h|hs|horas?)\s*(\d{2})?/i,
            );
            const justTimeAfterSlotsMatch = /^[\s\-\.,]*(\d{1,2})\s*(?::|h|hs|horas?)\s*(\d{2})?[\s\-\.,]*$/i.test(rawMsg);
            // Data RELATIVA + hora ("pode ser amanhã às 16h20") — caso Rejane 13/07:
            // não casava wkMatch/ddmm/justTime → virava unknown → sem agendamento.
            const relDayMatch = rawMsg.toLowerCase().match(
              /\b(hoje|amanh[aã]|depois\s+de\s+amanh[aã])\b[\s\S]{0,20}?(\d{1,2})\s*(?::|h|hs|horas?)\s*(\d{2})?/i,
            );

            const hasSlotOffer = await (async () => {
              const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
              const { data: recentOut } = await supabase
                .from("webhook_messages")
                .select("message_text")
                .eq("conversation_id", conversationId)
                .eq("direction", "outgoing")
                .gte("created_at", cutoff)
                .order("created_at", { ascending: false })
                .limit(3);
              for (const row of recentOut || []) {
                const t = String((row as any).message_text || "").toLowerCase();
                if (
                  t.includes("hor") &&
                  (t.includes("dispon") || t.includes("qual") || t.includes("prefere"))
                ) {
                  return true;
                }
              }
              return false;
            })();

            let forced: { date: string; time: string } | null = null;
            if (wkMatch && hasSlotOffer) {
              const dayName = stripAccents(wkMatch[1].toLowerCase());
              const target = weekdays[dayName];
              if (target !== undefined) {
                const today = getNowSP();
                const dow = today.getDay();
                let diff = (target - dow + 7) % 7;
                if (diff === 0) diff = 7; // sempre futuro
                const target_date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diff);
                const iso = `${target_date.getFullYear()}-${String(target_date.getMonth() + 1).padStart(2, "0")}-${String(target_date.getDate()).padStart(2, "0")}`;
                const hh = String(parseInt(wkMatch[2], 10)).padStart(2, "0");
                const mm = (wkMatch[3] || "00").padStart(2, "0");
                forced = { date: iso, time: `${hh}:${mm}` };
              }
            } else if (ddmmMatch && hasSlotOffer) {
              const d = parseInt(ddmmMatch[1], 10);
              const m = parseInt(ddmmMatch[2], 10);
              const y = ddmmMatch[3] ? (ddmmMatch[3].length === 2 ? 2000 + parseInt(ddmmMatch[3], 10) : parseInt(ddmmMatch[3], 10)) : getNowSP().getFullYear();
              const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
              const hh = String(parseInt(ddmmMatch[4], 10)).padStart(2, "0");
              const mm = (ddmmMatch[5] || "00").padStart(2, "0");
              forced = { date: iso, time: `${hh}:${mm}` };
            } else if (relDayMatch && hasSlotOffer) {
              const rel = stripAccents(relDayMatch[1].toLowerCase());
              const addDays = rel.startsWith("hoje") ? 0 : rel.includes("depois") ? 2 : 1;
              const today = getNowSP();
              const td = new Date(today.getFullYear(), today.getMonth(), today.getDate() + addDays);
              const iso = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, "0")}-${String(td.getDate()).padStart(2, "0")}`;
              const hh = String(parseInt(relDayMatch[2], 10)).padStart(2, "0");
              const mm = (relDayMatch[3] || "00").padStart(2, "0");
              console.log(`[SlotMatch] data relativa "${relDayMatch[1]}" + hora → ${iso} ${hh}:${mm} (caso Rejane)`);
              forced = { date: iso, time: `${hh}:${mm}` };
            } else if (justTimeAfterSlotsMatch && hasSlotOffer) {
              // Resolução fica pro caller (já existe lógica que cruza com slot_lock).
              // Mas precisamos sair de unknown.
              console.log(`[Webhook] safety: lone time response after slot offer — forcing intent=agendar`);
              classification.intent = "agendar";
            }

            if (forced) {
              classification.intent = "agendar";
              classification.date = forced.date;
              classification.time = forced.time;
              console.log(
                `[Webhook] 🛟 SAFETY net (Carina case): unknown→agendar forced from message="${rawMsg.slice(0,80)}" → date=${forced.date} time=${forced.time}`,
              );
            }
          } catch (e) {
            console.log(`[Webhook] safety-net unknown→agendar error (non-blocking): ${(e as Error).message}`);
          }
        }

        // ── SLOT-MATCH guard: reuse slots já oferecidos com verified_schedule=true ──
        // Caso <telefone-removido> (23/06): IA ofereceu "26/06 (sexta): 15:40, 16:00, 16:20",
        // paciente respondeu "Sexta 15:40", classificador deu unknown → re-perguntou data/hora.
        // Aqui parseamos o bloco de slots da última outgoing verified_schedule=true e casamos
        // a resposta da paciente contra ele. Roda quando intent=unknown OU intent=agendar sem
        // date/time concretos, e existe conversationId.
        // CASO RENAN (22/07): o paciente respondeu "31/07 (sexta): 14:00" — copiando
        // EXATAMENTE a linha que a própria Julia imprimiu — e recebeu a MESMA lista de
        // volta. Só funcionou quando ele repetiu com um "14:00" solto embaixo.
        // Motivo: o portão exigia que o classificador NÃO tivesse extraído data/hora.
        // Quando o LLM extrai algo (ainda que num formato que o resto do fluxo não
        // aproveita), o SlotMatch nem rodava. Mas os horários OFERTADOS são a verdade
        // — vieram da agenda real com verified_schedule=true. Agora ele roda sempre em
        // agendar/unknown e só assume quando casa UM único slot ofertado; se a mensagem
        // não casar nada, nada muda (0 candidatos = nenhum override).
        if (
          conversationId &&
          (classification.intent === "unknown" || classification.intent === "agendar")
        ) {
          try {
            const cutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const { data: lastVerified } = await supabase
              .from("webhook_messages")
              .select("message_text,created_at")
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .eq("verified_schedule", true)
              .gte("created_at", cutoffIso)
              .order("created_at", { ascending: false })
              .limit(1);
            const offerText = lastVerified?.[0]?.message_text as string | undefined;
            if (offerText) {
              const weekdayMap: Record<string, number> = {
                "domingo": 0, "segunda": 1, "terca": 2, "quarta": 3,
                "quinta": 4, "sexta": 5, "sabado": 6,
              };
              type Slot = { date: string; time: string; weekday: number };
              const offered: Slot[] = [];
              // Linhas tipo: "26/06 (sexta): 15:40, 16:00, 16:20"
              // CASO RENAN (22/07): a classe de horários usava \s, que casa QUEBRA DE
              // LINHA. Ao ler "29/07 (quarta): 08:00, …, 15:20\n31/07 (sexta): 14:00"
              // ela engolia o \n e o "31" da linha seguinte — e a linha da sexta sumia
              // da lista de slots reconhecidos. O paciente escolheu justamente 31/07
              // 14:00 (copiando a linha impressa pela Julia) e não casou NADA, então a
              // Julia repetiu a lista inteira. Trocado por [ \t] (espaço/tab, nunca \n):
              // cada linha da oferta é lida como uma linha.
              const lineRegex = /(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?[ \t]*\(([^)]+)\)[ \t]*:[ \t]*([0-9:,h \t]+)/gi;
              let lm: RegExpExecArray | null;
              const fallbackYear = getNowSP().getFullYear();
              while ((lm = lineRegex.exec(offerText)) !== null) {
                const dd = parseInt(lm[1], 10);
                const mm = parseInt(lm[2], 10);
                const yy = lm[3]
                  ? (lm[3].length === 2 ? 2000 + parseInt(lm[3], 10) : parseInt(lm[3], 10))
                  : fallbackYear;
                const wkRaw = stripAccents(String(lm[4] || "").toLowerCase().trim()).replace(/-?feira/, "").trim();
                const wk = weekdayMap[wkRaw] ?? new Date(yy, mm - 1, dd).getDay();
                const iso = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
                const timesPart = String(lm[5] || "");
                const timeRegex = /(\d{1,2})\s*[:h]\s*(\d{2})/g;
                let tm: RegExpExecArray | null;
                while ((tm = timeRegex.exec(timesPart)) !== null) {
                  offered.push({
                    date: iso,
                    time: `${String(parseInt(tm[1], 10)).padStart(2, "0")}:${tm[2]}`,
                    weekday: wk,
                  });
                }
              }

              if (offered.length > 0) {
                const raw = stripAccents((finalMessage || "").toLowerCase());
                // Extrai hora mencionada (HH:MM, HHhMM, HHh)
                const timeM = raw.match(/\b(\d{1,2})\s*(?::|h|hs|horas?)\s*(\d{2})?\b/);
                const askedTime = timeM
                  ? `${String(parseInt(timeM[1], 10)).padStart(2, "0")}:${(timeM[2] || "00").padStart(2, "0")}`
                  : null;
                // Extrai dia da semana
                const wkM = raw.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:[-\s]?feira)?\b/);
                const askedWeekday = wkM ? weekdayMap[wkM[1]] : null;
                // Extrai DD/MM
                const ddmmM = raw.match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
                const askedDate = ddmmM
                  ? `${fallbackYear}-${String(parseInt(ddmmM[2], 10)).padStart(2, "0")}-${String(parseInt(ddmmM[1], 10)).padStart(2, "0")}`
                  : null;

                let candidates = offered.slice();
                if (askedTime) candidates = candidates.filter((s) => s.time === askedTime);
                if (askedDate) candidates = candidates.filter((s) => s.date === askedDate);
                if (askedWeekday !== null) candidates = candidates.filter((s) => s.weekday === askedWeekday);

                if (candidates.length === 1) {
                  const pick = candidates[0];
                  classification.intent = "agendar";
                  classification.date = pick.date;
                  classification.time = pick.time;
                  console.log(
                    `[SlotMatch] ✅ reused offered slot date=${pick.date} time=${pick.time} from message="${(finalMessage || "").slice(0, 60)}"`,
                  );
                } else if (candidates.length > 1 && askedTime && !classification.date) {
                  // Mesma hora em múltiplos dias — força agendar mantendo hora; date virá
                  // da próxima resposta. Só entra quando NÃO há data do classificador:
                  // agora que o guard roda mesmo com data extraída, este ramo não pode
                  // sobrescrever uma data boa por uma ambiguidade.
                  classification.intent = "agendar";
                  classification.time = askedTime;
                  console.log(
                    `[SlotMatch] ⚠️ ambiguous date for time=${askedTime} (${candidates.length} dias) — forcing intent=agendar com hora.`,
                  );
                }
              }
            }
          } catch (e) {
            console.log(`[SlotMatch] error (non-blocking): ${(e as Error).message}`);
          }
        }

        // Date-range detection: when patient says "de 22 a 24/06" / "22, 23 ou 24/06" /
        // "entre 22 e 24/06", the LLM often returns date="" because it can't pick one.
        // Fall back to the first day of the range so the slot fetch has a real target
        // instead of looping with stale data.
        if (classification.intent === "agendar" && !classification.date) {
          try {
            const _msgLower = (finalMessage || "").toLowerCase();
            const rangePatterns = [
              /\bde\s+(\d{1,2})\s+(?:a|at[eé])\s+(\d{1,2})\s*\/\s*(\d{1,2})\b/,
              /\bentre\s+(\d{1,2})\s+e\s+(\d{1,2})\s*\/\s*(\d{1,2})\b/,
              /\b(\d{1,2})\s*[,e]\s*(\d{1,2})\s*(?:ou|e)\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/,
              /\b(\d{1,2})\s+ou\s+(\d{1,2})\s*\/\s*(\d{1,2})\b/,
            ];
            for (const pat of rangePatterns) {
              const m = _msgLower.match(pat);
              if (m) {
                const firstDay = parseInt(m[1], 10);
                const month = parseInt(m[m.length - 1], 10);
                if (firstDay >= 1 && firstDay <= 31 && month >= 1 && month <= 12) {
                  const yy = getNowSP().getFullYear();
                  classification.date = `${yy}-${String(month).padStart(2, "0")}-${String(firstDay).padStart(2, "0")}`;
                  console.log(`[Webhook] Date-range detected ("${m[0]}") — using first day ${classification.date} as target`);
                  break;
                }
              }
            }
          } catch (_e) { /* non-blocking */ }
        }

        // Force intent override if needs_registration context detected (but NOT during reset)
        if (
          forceRegistrationIntent &&
          classification.intent !== "cadastrar" &&
          classification.intent !== "resetar_conversa"
        ) {
          console.log(
            `[Webhook] Overriding intent from "${classification.intent}" to "cadastrar" (needs_registration context)`,
          );
          classification.intent = "cadastrar";
        }

        // Merge scheduling context from needs_registration if available
        if (forceRegistrationIntent && (globalThis as any).__schedulingContext) {
          const ctx = (globalThis as any).__schedulingContext as Record<string, string>;
          for (const [key, val] of Object.entries(ctx)) {
            if (val && !classification[key]) {
              (classification as any)[key] = val;
              console.log(`[Webhook] Injected scheduling context: ${key}=${val}`);
            }
          }
          delete (globalThis as any).__schedulingContext;
        }

        console.log("[Webhook] AI classification:", JSON.stringify(classification));

        // POST-CLASSIFICATION VALIDATION: Validate preferred_weekday with regex
        if (classification.preferred_weekday) {
          const weekdayRegex =
            /\b(segunda|terça|terca|quarta|quinta|sexta|s[aá]bado|domingo|seg|ter|qua|qui|sex|s[aá]b|dom)\b/i;
          if (!weekdayRegex.test(finalMessage)) {
            console.log(
              `[Webhook] Clearing hallucinated preferred_weekday="${classification.preferred_weekday}" — not found in message: "${finalMessage.substring(0, 80)}"`,
            );
            classification.preferred_weekday = "";
          }
        }

        // POST-CLASSIFICATION GUARD: Prevent re-scheduling after recent booking (expanded)
        if ((recentBookingCompleted || recentCancelInvalidatesContext) && classification.intent === "agendar") {
          // Check if the message contains EXPLICIT new scheduling entities
          const hasNewDoctor =
            classification.doctor_name &&
            finalMessage.toLowerCase().includes(classification.doctor_name.toLowerCase().split(" ")[0]);
          const hasNewDate = classification.date && /\d{1,2}[\/\-]\d{1,2}/.test(finalMessage);
          // Also detect natural-language NEW-DATE references that indicate scheduling intent.
          // Keep this regex narrow: it must signal a genuinely NEW date/period \u2014 not generic
          // follow-up words like "horario", "disponivel", "agendar" that fire on almost any
          // reply ("e o hor\u00e1rio?", "t\u00e1 dispon\u00edvel?") and would defeat the guard's purpose
          // of preventing duplicate bookings right after a successful one.
          const msgLowerGuard = finalMessage.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          const hasNaturalDateRef = /\b(dia\s+\d{1,2}|semana\s+(do|que|de)|proxim[ao]\s+(semana|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia|mes)|outr[ao]\s+(data|dia|semana)|outro\s+dia|na\s+(segunda|terca|quarta|quinta|sexta|sabado|domingo))\b/i.test(msgLowerGuard);
          const hasExplicitNewBooking = hasNewDoctor || hasNewDate || hasNaturalDateRef;

          if (!hasExplicitNewBooking) {
            console.log(
              `[Webhook] ⚡ POST-BOOKING GUARD (expanded): Message "${finalMessage.substring(0, 40)}" after recent booking — no explicit new entities → forcing intent to "unknown"`,
            );
            classification.intent = "unknown";
            classification.doctor_name = "";
            classification.date = "";
            classification.time = "";
            classification.subspecialty = "";
          }
        }

        const outroMedicoRegex =
          /\b(outro\s*(m[eé]dico|doutor|dr|profissional)|qualquer\s*(m[eé]dico|doutor|dr|profissional|um)|pode\s*ser\s*outro|tanto\s*faz|n[aã]o\s*tenho\s*prefer[eê]ncia|mais\s*r[aá]pido\s*poss[ií]vel)\b/i;
        // "tanto faz o DIA" fala do dia, nao do médico (28/08). O regex acima casa
        // "tanto faz" e limpava o médico — o oposto do que a paciente pediu: ela
        // queria manter o Dr. Luiz Gustavo e abrir a data.
        const _tantoFazEhSobreODia =
          /\b(tanto\s*faz|qualquer|nao\s*tenho\s*prefer[eê]ncia|n[aã]o\s*tenho\s*prefer[eê]ncia)\b[\s\S]{0,12}\b(dia|data|hor[aá]rio)\b/i
            .test(finalMessage);
        if (outroMedicoRegex.test(finalMessage) && !_tantoFazEhSobreODia) {
          console.log(
            `[Webhook] "Outro médico" detected in message. Clearing doctor_name="${classification.doctor_name}" and subspecialty="${classification.subspecialty}" to trigger multi-doctor search.`,
          );
          classification.doctor_name = "";
          classification.subspecialty = "";
        }

        // === "TANTO FAZ O DIA" APAGA A DATA GRUDADA (28/08) ===
        // Caso 15:48-15:51: a paciente pediu "4a feira da semana que vem" (02/09),
        // ouviu "sem horários", disse "veja as datas disponíveis" e depois "tanto
        // faz o dia" — e a Julia procurou em 02/09 as TRÊS vezes, porque o
        // classificador preserva a data do histórico. A agenda tinha vaga (a
        // Mardila marcou 09/09 na mão 70 minutos depois).
        if (classification.date && pedeQualquerData(finalMessage)) {
          console.log(
            `[Webhook] 📅 paciente pediu qualquer data — limpando date="${classification.date}" e preferred_weekday="${classification.preferred_weekday || ""}" para buscar a próxima vaga`,
          );
          classification.date = "";
          classification.preferred_weekday = "";
        }

        // POST-CLASSIFICATION: Detect doctor switch mid-conversation and clear stale date/time
        if (classification.doctor_name && conversationId) {
          const { data: lastEntitiesRows } = await supabase
            .from("webhook_messages")
            .select("ai_entities")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .not("ai_entities", "is", null)
            .order("created_at", { ascending: false })
            .limit(1);
          if (lastEntitiesRows && lastEntitiesRows.length > 0) {
            const lastEnt = lastEntitiesRows[0].ai_entities as Record<string, unknown>;
            if (
              lastEnt?.doctor_name &&
              String(lastEnt.doctor_name).toLowerCase() !== classification.doctor_name.toLowerCase()
            ) {
              console.log(
                `[Webhook] Doctor changed: "${lastEnt.doctor_name}" → "${classification.doctor_name}". Clearing date/time to force new schedule lookup.`,
              );
              classification.date = "";
              classification.time = "";
            }
          }
        }

        // === CPF DIGITADO VENCE O CPF DO DONO DO TELEFONE (bug Juarez 07/07) ===
        // Se o paciente digitou um CPF válido na mensagem (ex: CPF da esposa, que ESTÁ
        // cadastrada) mas o LLM falhou em extrair, precisamos usar ESSE CPF — não o do
        // dono do telefone. Extração determinística com dígito verificador (não casa
        // telefone de 11 dígitos). Roda ANTES da injeção proativa: como ela é guardada
        // por !classification.cpf, o CPF digitado a pré-empta automaticamente.
        if (!classification.cpf) {
          const _typedCpf = extractCpfFromText(finalMessage || "", { excludeDigits: phone || "" });
          if (_typedCpf) {
            classification.cpf = _typedCpf;
            console.log(`[CpfExtract] CPF válido extraído da mensagem (pré-empta CPF do dono do telefone): ${_typedCpf}`);
          }
        }

        // Inject proactively identified patient data into classification
        if (identifiedPatient) {
          // CPF MASCARADO NAO E CPF (ver cpfLimpoOuVazio). Este caminho — a injecao
          // proativa do paciente identificado pelo telefone — era o UNICO dos quatro
          // que nao filtrava, e por ele passavam os 32% de cadastros com CPF vindo
          // mascarado da propria Amigo ("***.018.028-**"). O sistema entao mandava
          // patients/exists?cpf=018028, a API recusava ("Cpf deve ter exatamente 11
          // caracteres") e o paciente da casa ouvia "nao encontrei seu cadastro".
          //
          // Medido em 26/08: a API do Amigo devolve o CPF mascarado para TODOS os
          // pacientes, inclusive os que temos limpos no cache — nao ha o que
          // recuperar. Vazio e melhor que podre: vazio o sistema sabe pedir.
          const _cpfIdent = cpfLimpoOuVazio(identifiedPatient.cpf);
          if (!classification.cpf && _cpfIdent) {
            classification.cpf = _cpfIdent;
            console.log(`[Webhook] Injected proactive CPF: ${_cpfIdent}`);
          } else if (!classification.cpf && identifiedPatient.cpf) {
            console.log(`[Webhook] CPF do cache descartado (mascarado/invalido) — vai pedir ao paciente`);
          }
          if (!classification.patient_full_name && identifiedPatient.name) {
            (classification as any).patient_name = firstName(identifiedPatient.name);
            console.log(`[Webhook] Injected proactive patient name (first only): ${firstName(identifiedPatient.name)}`);
          }
        }

        // identificar_por_nome is now disabled — names are context only, no search
      } catch (e) {
        console.error("[Webhook] AI classification failed:", e);
        await supabase
          .from("webhook_messages")
          .update({
            action_status: "failed",
            action_error: `AI classification failed: ${e.message}`,
            ai_intent: "error",
          })
          .eq("id", messageId);

        return new Response(JSON.stringify({ status: "error", message: "AI processing failed" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Update message with AI results
      await supabase
        .from("webhook_messages")
        .update({
          ai_intent: classification.intent,
          ai_entities: {
            cpf: classification.cpf,
            doctor_name: classification.doctor_name,
            subspecialty: classification.subspecialty,
            complaint: classification.complaint,
            date: classification.date,
            time: classification.time,
            attendance_id: classification.attendance_id,
            confidence: classification.confidence,
          },
        })
        .eq("id", messageId);

      // === CONVERSATION MEMORY FALLBACK: Recover entities from history ===
      // SKIP entirely during reset — we want a completely clean slate
      // For non-scheduling intents (unknown, consultar_endereco, etc.), do NOT recover date/time to prevent contamination
      const schedulingIntents = new Set([
        "agendar",
        "reagendar",
        "cancelar",
        "confirmar",
        "cadastrar",
        "consultar",
        "listar_medicos",
        "solicitar_infiltracao",
        "solicitar_exame",
      ]);
      if (conversationId && classification.intent !== "resetar_conversa" && !isInactiveConversation) {
        const allEntityKeys = [
          "cpf",
          "doctor_name",
          "date",
          "time",
          "complaint",
          "subspecialty",
          "preferred_weekday",
          "preferred_period",
          "attendance_id",
          "patient_full_name",
          "insurance_choice",
          "patient_address",
          "patient_birth_date",
        ] as const;
        // Only recover date/time for scheduling-related intents
        // Also block scheduling entity recovery when a booking was just completed
        let entityKeys: readonly string[];
        if ((recentBookingCompleted || recentCancelInvalidatesContext) && classification.intent === "agendar") {
          // After a recent booking/cancel, only recover identity fields — NOT scheduling fields
          entityKeys = allEntityKeys.filter(
            (k) =>
              ![
                "date",
                "time",
                "doctor_name",
                "subspecialty",
                "preferred_weekday",
                "preferred_period",
                "attendance_id",
              ].includes(k),
          );
          console.log("[Webhook] ⚡ Blocking scheduling entity recovery — recent booking completed");
        } else if (schedulingIntents.has(classification.intent)) {
          entityKeys = allEntityKeys;
        } else {
          entityKeys = allEntityKeys.filter(
            (k) => k !== "date" && k !== "time" && k !== "preferred_weekday" && k !== "preferred_period",
          );
        }
        const missingKeys = entityKeys.filter((k) => !classification[k]);

        if (missingKeys.length > 0) {
          // Query ai_entities from recent messages to recover missing fields
          const cutoff48h3 = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
          const { data: prevMsgs } = await supabase
            .from("webhook_messages")
            .select("ai_entities")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .not("ai_entities", "is", null)
            .gte("created_at", cutoff48h3)
            .order("created_at", { ascending: false })
            .limit(15);

          for (const msg of prevMsgs || []) {
            const ent = msg.ai_entities as Record<string, unknown>;
            for (const key of missingKeys) {
              if (!classification[key] && ent?.[key]) {
                (classification as any)[key] = String(ent[key]);
                console.log(`[Webhook] Recovered ${key} from conversation history: ${classification[key]}`);
              }
            }
            // Check if all keys are now filled
            if (entityKeys.every((k) => classification[k])) break;
          }
        }

        // Persist recovered entities back to current message so future lookups find them
        const recoveredEntities: Record<string, unknown> = {
          cpf: classification.cpf || "",
          doctor_name: classification.doctor_name || "",
          subspecialty: classification.subspecialty || "",
          complaint: classification.complaint || "",
          date: classification.date || "",
          time: classification.time || "",
          attendance_id: classification.attendance_id || "",
          preferred_weekday: classification.preferred_weekday || "",
          preferred_period: classification.preferred_period || "",
          // Tema 1: persiste a confirmacao pra sobreviver entre turnos do reagendamento.
          reagendar_confirmed: classification.reagendar_confirmed || false,
          confidence: classification.confidence || 0,
        };
        const hasAnyEntity = entityKeys.some((k) => classification[k]);
        if (hasAnyEntity) {
          await supabase.from("webhook_messages").update({ ai_entities: recoveredEntities }).eq("id", messageId);
          console.log("[Webhook] Persisted recovered entities to current message");
        }
      } else if (classification.intent === "resetar_conversa") {
        console.log("[Webhook] Skipping entity recovery — reset intent active");
      }

      // Set conversationId for executeAction to use (esp. resetar_conversa)
      (globalThis as any).__currentConversationId = conversationId;

      // Execute action (now with supabase client and clinicTokenId for doctor_settings filtering)
      console.log(`[Webhook] Executing action: ${classification.intent}`);
      const _actionResultRaw = await executeAction(
        classification.intent,
        {
          cpf: classification.cpf,
          doctor_name: classification.doctor_name,
          subspecialty: classification.subspecialty,
          complaint: classification.complaint,
          date: classification.date,
          time: classification.time,
          preferred_weekday: classification.preferred_weekday,
          preferred_period: classification.preferred_period,
          attendance_id: classification.attendance_id,
          patient_full_name: classification.patient_full_name,
          insurance_choice: classification.insurance_choice,
          patient_birth_date: classification.patient_birth_date,
          attendant_name: classification.attendant_name,
          // Tema 1: propaga a confirmacao de reagendamento ao handler (era descartada).
          reagendar_confirmed: (classification as any).reagendar_confirmed,
          // Período da lista de espera capturado deterministicamente (10/07)
          _waitlist_period_set: (classification as any)._waitlist_period_set,
        } as any,
        amigoToken,
        companyId,
        supabase,
        clinicTokenId,
        phone,
        avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken
          ? { baseUrl: avanceaiBaseUrl, apiId: avanceaiApiId, bearerToken: avanceaiBearerToken }
          : null,
        // Pass routing rules from clinic_info
        Array.isArray(clinicRef?.routing_rules)
          ? (clinicRef.routing_rules as Array<{ keyword: string; target_user: string }>)
          : null,
        // Pass recent conversation history for routing rule keyword matching
        conversationHistory,
        isTestMode,
        finalMessage,
        resolvedChannelId,
        // Pass custom_notes for transfer order
        clinicRef?.custom_notes || null,
        // Pass parsed business hours so validateBookingDate uses real clinic hours instead of hardcoded 8-18
        parsedBusinessHours,
        // Pass conversationId directly instead of relying on globalThis
        conversationId,
      );
      // REDE DE SEGURANÇA (caso Guilherme 19/07): um ramo raro do cadastrar devolveu
      // resultado SEM status (actionResult.status=undefined). O LLM "confirmou" por
      // conta, o FalseConfirmGuard segurou, o paciente repetiu, o dedup engoliu a
      // repetição → beco sem saída. Normaliza para needs_info (pede o dado e o fluxo
      // segue) e LOGA o shape exato pra localizarmos o ramo na próxima ocorrência.
      const actionResult: any =
        _actionResultRaw && typeof _actionResultRaw === "object" ? _actionResultRaw : {};
      if (typeof actionResult.status !== "string" || !actionResult.status) {
        console.error(
          `[Action] ⚠️ retorno SEM status (intent=${classification.intent}) — normalizando p/ needs_info. shape=${JSON.stringify(_actionResultRaw ?? null).slice(0, 300)}`,
        );
        actionResult.status = "needs_info";
        if (!actionResult.error) {
          actionResult.error =
            "Quase lá! Para eu concluir com segurança, me confirme por favor o médico, a data e o horário que você quer.";
        }
      }

      // AUDITORIA CENTRAL de transferências (política 21/07): qualquer transferred_*
      // devolvido pelo executeAction vira linha na transfer_audit — infiltração,
      // exame, fisioterapia, dia fechado, fila. (urgência audita no próprio bloco,
      // antes do executeAction; falar_com_atendente audita dentro do case, com o
      // motivo fino sticky/pedido/ordem.)
      try {
        const _tfTriggerMap: Record<string, string> = {
          transferred_infiltracao: "infiltracao",
          needs_documents_infiltracao: "infiltracao",
          transferred_exame: "exame",
          transferred_fisioterapia: "fisioterapia",
          transferred_closed_day: "dia_fechado",
          transferred_queue: "fila_fora_horario",
        };
        const _tfTrigger = _tfTriggerMap[String(actionResult.status || "")];
        if (_tfTrigger) {
          await auditTransfer(supabase, {
            clinicTokenId, conversationId, phone,
            initiatedBy: "julia",
            trigger: _tfTrigger,
            // SEMPRE null (30/08). Este campo saia de um regex na FRASE da resposta
            // (/Transferido para (.+)/) — o nome de quem a Julia *teria* escolhido,
            // escrito antes de qualquer conferencia do que a transferencia fez. Nos
            // caminhos de exame e infiltracao ele gravava "Mardila"/"Lidiane" para
            // tickets que foram para a fila, e a aba Transferencias mostrava pessoas
            // recebendo caso que ninguem recebeu. Foi assim que o painel do dono
            // passou semanas dizendo que "esta caindo tudo na Mardila".
            // Agora nenhuma transferencia atribui: o destino e a fila, e o unico
            // valor honesto aqui e null (a tela renderiza "(fila geral)").
            toAttendant: null,
            detail: (finalMessage || "").slice(0, 120),
          });
        }
      } catch (e) {
        console.log(`[TransferAudit] central falhou (non-blocking): ${(e as Error).message}`);
      }

      // Update message with action result
      // FIX (caso Carolina 03/07): alguns handlers (reagendar/cancelar Step 2)
      // devolvem entities ENRIQUECIDAS (ex: attendance_id da consulta encontrada)
      // em actionResult.entities — mas isso nunca era persistido. No turno seguinte
      // o recovery nao achava o attendance_id -> "ID do agendamento invalido".
      // Agora mesclamos as entities enriquecidas no ai_entities da mensagem.
      const _enrichedEntities = (actionResult as any).entities as Record<string, unknown> | undefined;
      const _updatePayload: Record<string, unknown> = {
        action_status: actionResult.status,
        ai_response: actionResult.response,
        action_error: actionResult.error || null,
      };
      if (_enrichedEntities && typeof _enrichedEntities === "object") {
        const _cleanEnriched: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(_enrichedEntities)) {
          if (v !== undefined && v !== null && v !== "") _cleanEnriched[k] = v;
        }
        if (Object.keys(_cleanEnriched).length > 0) {
          _updatePayload.ai_entities = { ..._cleanEnriched, confidence: classification.confidence || 0 };
          console.log(`[Webhook] Persisting enriched entities from action: ${Object.keys(_cleanEnriched).join(",")}`);
        }
      }
      await supabase
        .from("webhook_messages")
        .update(_updatePayload)
        .eq("id", messageId);

      console.log(`[Webhook] Action result: ${actionResult.status} - ${actionResult.response || actionResult.error}`);

      // ANTI-SPAM infiltracao/exame: handoff ja aconteceu ha <60min — a atendente
      // esta assumindo. Nao gera nem envia NADA (re-instruir a cada mensagem da
      // paciente era o spam da conv 74 de 29/06).
      if ((actionResult as any).status === "human_handoff_active") {
        await supabase
          .from("webhook_messages")
          .update({
            action_status: "skipped",
            action_error: "Handoff humano ativo (<60min) — IA em silencio, sem re-instruir",
          })
          .eq("id", messageId);
        return new Response(
          JSON.stringify({ status: "skipped", reason: "human_handoff_active" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // REGRA 7 (relatorio 30/06 conv 37372048): paciente tentou 6 datas, todas sem
      // horario, e o bot repetiu a negativa 6x sem transferir. O contador de falhas
      // so' via erros de API — "lista vazia" e' falha de NEGOCIO e nao contava.
      // Conta incoming needs_info com padrao de "sem horarios" nos ultimos 45min
      // (o update acima ja gravou a ocorrencia ATUAL, entao >= 2 = segunda negativa).
      if (
        conversationId &&
        actionResult.status === "needs_info" &&
        // 28/08: era um regex procurando "não tem/encontrei horários disponíveis",
        // mas o executeAction escreve "Sem horários com X em DD/MM" — nunca casou,
        // e a Regra 7 estava MORTA desde que o texto mudou. Helper testado contra
        // as frases reais do fonte.
        ehNegativaDeHorario(String(actionResult.error || "") + " " + String(actionResult.response || ""))
      ) {
        try {
          // ── QUEM ESTÁ PEDINDO MAIS DATAS NÃO É QUEM DESISTIU (01/09) ──────────
          // A Regra 7 conta o RESULTADO ("sem horários"), não a atitude do paciente
          // — então ela punia exatamente quem continuava colaborando. As frases que
          // levaram "vou te passar pra uma colega" na cara, medidas em 7 dias:
          //   30/08 09:55  "Me fala as datas disponíveis para o Lucas"
          //   31/08 07:43  "Sim, qual a proxima data q ele tem horario?"
          //   01/09 09:07  "Pra frente"
          // Pedir mais opções é tentativa nova, não recusa. Não conta.
          if (pedeQualquerData(finalMessage)) {
            console.log(`[Regra7] paciente está PEDINDO mais datas — tentativa nova, não conta como negativa`);
            throw { _regra7Pula: true };
          }

          // ── UMA ESCALADA POR VEZ (01/09) ──────────────────────────────────────
          // Depois de escalar, a linha vira 'empty_slots_escalated' e sai da
          // contagem — mas as OUTRAS negativas continuam na janela de 45min. A
          // mensagem seguinte recontava as mesmas duas e transferia de novo.
          // Medido: 6fe70127 disparou 11:48:03 e 11:48:21; 3fec5a58 às 15:42:19 e
          // 15:42:52; 110f4c7d TRÊS vezes em 01/09 (09:07, 09:10, 09:15) — e a
          // última foi com o paciente dizendo só "Ok". Cada disparo mandava a
          // mensagem de transferência e chamava o transferTicketToHuman de novo.
          const _since15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
          const { count: _jaEscalou } = await supabase
            .from("webhook_messages")
            .select("id", { count: "exact", head: true })
            .eq("conversation_id", conversationId)
            .eq("action_status", "empty_slots_escalated")
            .gte("created_at", _since15);
          if ((_jaEscalou || 0) > 0) {
            console.log(`[Regra7] esta conversa já foi escalada há menos de 15min — não transfiro de novo`);
            throw { _regra7Pula: true };
          }

          const _since45 = new Date(Date.now() - 45 * 60 * 1000).toISOString();
          const { data: _emptyRows } = await supabase
            .from("webhook_messages")
            .select("action_error")
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .eq("action_status", "needs_info")
            .gte("created_at", _since45)
            .limit(20);
          const _emptyCount = (_emptyRows || []).filter((r: any) =>
            ehNegativaDeHorario(String(r.action_error || "")),
          ).length;
          if (_emptyCount >= 2) {
            console.log(`[Webhook] ⛔ REGRA 7: ${_emptyCount} negativas de horario em 45min — transferindo pra humano`);
            const _r7Msg =
              "Pra não te deixar tentando datas sem sucesso, vou te passar pra uma colega da equipe que consegue verificar um encaixe especial pra você. 🙏 Só um instante!";
            if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
              try {
                await sendAvanceaiReply(avanceaiBaseUrl, avanceaiApiId, avanceaiBearerToken, phone, _r7Msg, resolvedChannelId);
              } catch (e) {
                console.error(`[Regra7] escalate reply failed: ${(e as Error).message}`);
              }
              try {
                await transferTicketToHuman({
                  baseUrl: avanceaiBaseUrl,
                  apiId: avanceaiApiId,
                  bearerToken: avanceaiBearerToken,
                  phone,
                  channelId: resolvedChannelId,
                });
              } catch (e) {
                console.error(`[Regra7] escalate transfer failed: ${(e as Error).message}`);
              }
            }
            await supabase
              .from("webhook_messages")
              .update({
                action_status: "empty_slots_escalated",
                action_error: `Regra 7: ${_emptyCount} negativas de horario consecutivas — transferido pra humano`,
              })
              .eq("id", messageId);
            return new Response(
              JSON.stringify({ status: "transferred", reason: "empty_slots_loop", count: _emptyCount }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        } catch (e) {
          // O `throw { _regra7Pula: true }` acima é desvio de fluxo, não falha:
          // sai do bloco sem transferir e sem poluir o log de erro.
          if (!(e as { _regra7Pula?: boolean })?._regra7Pula) {
            console.log(`[Regra7] empty-slots counter error (non-blocking): ${(e as Error).message}`);
          }
        }
      }

      // REGRA 8 (caso 26/08): a Julia pediu o MESMO dado 6 vezes seguidas.
      // A paciente marcava para o marido; o classificador tinha ordem explicita de
      // NUNCA extrair nome de terceiro, e o cadastro exigia esse nome. Ela mandou
      // "<paciente>" seis vezes, ouviu "tivemos uma pequena
      // instabilidade no sistema" (nao houve), esperou 45 minutos e a Laiz salvou
      // na mao. O prompt foi corrigido — este contador existe porque prompt falha.
      //
      // Conta pelo CAMPO pedido, lido de action_error (texto do codigo, fixo), e
      // nao pela frase enviada: o anti-duplicata compara texto e o LLM reescrevia
      // a pergunta a cada volta, entao o loop passou inteiro por baixo dele.
      if (conversationId && actionResult.status === "needs_info") {
        const _campo = campoPedidoNoCadastro(String(actionResult.error || ""));
        if (_campo) {
          try {
            const _since20 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
            const { data: _rowsCampo } = await supabase
              .from("webhook_messages")
              .select("action_error")
              .eq("conversation_id", conversationId)
              .eq("direction", "incoming")
              .eq("action_status", "needs_info")
              .gte("created_at", _since20)
              .limit(30);
            // o update logo acima ja gravou a ocorrencia ATUAL — >= 3 e' a terceira
            // vez pedindo a mesma coisa, e a terceira ja e' uma a mais do que devia.
            const _vezes = (_rowsCampo || []).filter(
              (r: any) => campoPedidoNoCadastro(String(r.action_error || "")) === _campo,
            ).length;
            if (_vezes >= 3) {
              console.log(`[Webhook] ⛔ REGRA 8: pedi "${_campo}" ${_vezes}x em 20min — parando e passando pra humano`);
              const _r8Msg =
                "Pra não te fazer repetir de novo, vou passar pra uma colega da equipe finalizar isso com você. 🙏 Só um instante!";
              if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
                try {
                  await sendAvanceaiReply(avanceaiBaseUrl, avanceaiApiId, avanceaiBearerToken, phone, _r8Msg, resolvedChannelId);
                } catch (e) {
                  console.error(`[Regra8] escalate reply failed: ${(e as Error).message}`);
                }
                try {
                  // sem alvo dirigido: vai para a fila de pendentes, como as demais
                  await transferTicketToHuman({
                    baseUrl: avanceaiBaseUrl,
                    apiId: avanceaiApiId,
                    bearerToken: avanceaiBearerToken,
                    phone,
                    channelId: resolvedChannelId,
                  });
                } catch (e) {
                  console.error(`[Regra8] escalate transfer failed: ${(e as Error).message}`);
                }
              }
              if (clinicTokenId) {
                await auditTransfer(supabase, {
                  clinicTokenId, conversationId, phone,
                  initiatedBy: "julia", trigger: "loop_cadastro",
                  reason: `pediu_${_campo}_${_vezes}x_em_20min`,
                  detail: (finalMessage || "").slice(0, 120),
                });
              }
              await supabase
                .from("webhook_messages")
                .update({
                  action_status: "registration_loop_escalated",
                  action_error: `Regra 8: campo "${_campo}" pedido ${_vezes}x em 20min — transferido pra humano`,
                })
                .eq("id", messageId);
              return new Response(
                JSON.stringify({ status: "transferred", reason: "registration_loop", campo: _campo, count: _vezes }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          } catch (e) {
            console.log(`[Regra8] contador de campo falhou (non-blocking): ${(e as Error).message}`);
          }
        }
      }

      // Auto-reply via WhatsApp using AI-generated response with dynamic script
      // In test mode, generate the response but skip sending via AvanceAI
      // Bonus (bug ReferenceError): verifiedScheduleFlag era declarado DENTRO do ramo
      // AvanceAI mas usado tambem no ramo isTestMode-sem-AvanceAI -> ReferenceError
      // (mascarado pelo @ts-nocheck). Declarado aqui, antes do fork, visivel aos dois.
      let verifiedScheduleFlag: boolean | null = null;
      if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
        let replyText: string;

        // For reset, use a direct clean message — don't call AI with old history
        if (classification.intent === "resetar_conversa") {
          const patientFirstName = identifiedPatient?.name?.split(" ")[0] || "";
          replyText = patientFirstName
            ? `Perfeito, ${patientFirstName}! Vamos começar do zero. 😊 Como posso te ajudar?`
            : `Perfeito! Vamos começar do zero. 😊 Como posso te ajudar?`;
          console.log("[Webhook] Reset: using direct reply (skipping AI generation)");
        } else if ((actionResult as any).bypassAiRewrite && actionResult.response) {
          // Direct path (e.g. widget CTA): preserve exact response text — no LLM rewrite
          replyText = actionResult.response;
          console.log("[Webhook] bypassAiRewrite=true — using actionResult.response directly");
        } else {
          try {
            replyText = await generateAIResponse(
              LOVABLE_API_KEY,
              dynamicScript,
              messageStr,
              classification.intent,
              actionResult,
              {
                date: classification.date,
                time: classification.time,
                doctor_name: classification.doctor_name,
                // Tema 4 (caso "Oi Bruna" — Amostra 5): so' trata o paciente pelo nome
                // quando ele veio do CADASTRO (identifiedPatient, com CPF) ou foi dito
                // explicitamente pelo paciente (patient_name). NUNCA usa o nome bruto do
                // perfil do WhatsApp (`name`), que e' auto-declarado e nao confiavel.
                caller_name: identifiedPatient
                  ? firstName(identifiedPatient.name)
                  : classification.patient_name || "",
                patient_name: classification.patient_name,
                patient_full_name: classification.patient_full_name,
                patient_auto_identified: identifiedPatient?.cpf ? "true" : "",
                is_outside_business_hours: isOutsideBusinessHours ? "true" : "",
                is_closed_day: isClosedDayToday ? "true" : "",
              },
              conversationHistory,
              clinicLocationInfo,
              clinicTokenId,
            );
          } catch (e) {
            console.error("[Webhook] AI response generation failed, using fallback:", e);
            replyText = generateResponseText(
              classification.intent,
              actionResult,
              {
                date: classification.date,
                time: classification.time,
                doctor_name: classification.doctor_name,
                patient_name: identifiedPatient ? firstName(identifiedPatient.name) : classification.patient_name,
                patient_full_name: classification.patient_full_name,
              },
              clinicLocationInfo,
            );
          }
        }

        // === ANTI-HALLUCINATION GUARD: block schedule terms not backed by real API data ===
        const _scheduleGuard = validateScheduleTerms(replyText, {
          intent: classification.intent,
          actionStatus: actionResult.status || "",
          verifiedSchedule: Boolean((actionResult as any).verifiedSchedule),
          bypassAiRewrite: Boolean((actionResult as any).bypassAiRewrite),
          actionErrorText: String(actionResult.error || ""),
          actionResponseText: String(actionResult.response || ""),
          // Caso Tathi 10/07: ecoar datas/horas que o paciente pediu não é alucinação
          patientMessageText: finalMessage || "",
        });
        // verifiedScheduleFlag (declarado antes do fork): persistido em
        // webhook_messages.verified_schedule
        // - true  → resposta com horários respaldados pela API real
        // - false → resposta foi BLOQUEADA pelo guard (alucinação)
        // - null  → resposta sem horários/datas (não aplicável)
        const _hadScheduleTokens = containsScheduleTerms(replyText).has;
        if (!_scheduleGuard.allowed) {
          // FIX (<paciente> <telefone-removido>): permitir tokens de horário quando o paciente está
          // CONFIRMANDO/CONSULTANDO um agendamento que acabou de ser criado com sucesso na
          // mesma conversa nos últimos 30 min. Sem isso, "Tá certo!" após booking gera
          // falso-positivo de alucinação e a IA responde "vou conferir..." num contexto
          // que já está agendado.
          let _bypassByRecentBooking = false;
          // SAFETY (caso Carina 03/06): o blacklist anterior (`!["agendar","reagendar","cancelar","cadastrar"]`)
          // tratava intent=unknown como elegível pra bypass. Combinado com tokens que aparecem
          // no histórico (ex: lista de slots do cadastrar success), liberava a IA pra inventar
          // "acabei de reservar" sem que houvesse POST real. Agora WHITELIST estrita: só intents
          // que LEGITIMAMENTE confirmam agendamento existente. unknown_intent NUNCA é bypass.
          // Normalizador de tokens compartilhado pelos bypasses ("8h"/"8:00"/"08:00" casam).
          // Hoisted do bypass recent-booking pra reuso no ECHO bypass abaixo.
          const _normalizeToken = (s: string): string[] => {
            const out: string[] = [s];
            const hhmm = s.match(/^(\d{1,2}):(\d{2})$/);
            if (hhmm) {
              const h = parseInt(hhmm[1], 10);
              const mm = hhmm[2];
              out.push(`${h}:${mm}`, `${String(h).padStart(2, "0")}:${mm}`, `${h}h${mm}`, `${h}h`);
              if (mm === "00") out.push(`${h}h`, `${String(h).padStart(2, "0")}h`);
            }
            const hForm = s.match(/^(\d{1,2})h(\d{2})?$/i);
            if (hForm) {
              const h = parseInt(hForm[1], 10);
              const mm = hForm[2] || "00";
              out.push(`${h}:${mm}`, `${String(h).padStart(2, "0")}:${mm}`);
            }
            const ddmm = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
            if (ddmm) {
              const d = parseInt(ddmm[1], 10);
              const m = parseInt(ddmm[2], 10);
              out.push(`${d}/${m}`, `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`);
            }
            return out.map((x) => x.toLowerCase());
          };
          const _confirmLike =
            ["confirmar", "consultar"].includes(classification.intent || "") &&
            actionResult.status !== "unknown_intent";
          if (_confirmLike && conversationId && _scheduleGuard.tokens.length > 0) {
            try {
              const { data: _recent } = await supabase
                .from("webhook_messages")
                .select("ai_entities, message_text, ai_response, created_at")
                .eq("conversation_id", conversationId)
                .eq("action_status", "success")
                .in("ai_intent", ["agendar", "reagendar", "cadastrar"])
                .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
                .order("created_at", { ascending: false })
                .limit(5);
              const _hay = (_recent || [])
                .map((r: any) => `${r.message_text || ""} ${r.ai_response || ""} ${JSON.stringify(r.ai_entities || {})}`)
                .join(" ")
                .toLowerCase();
              if (_hay) {
                const _allMatch = _scheduleGuard.tokens.every((t) =>
                  _normalizeToken(t).some((v) => _hay.includes(v)),
                );
                if (_allMatch) {
                  _bypassByRecentBooking = true;
                  console.log(`[AntiHallucination] ✅ bypass — tokens [${_scheduleGuard.tokens.join(",")}] match recent verified booking in conversation`);
                }
              }
            } catch (_e) { /* non-blocking */ }
          }
          // Additional bypass: if conversation_state has a verified slot/booking in context,
          // tokens that match its date/time are allowed. Reading from the authoritative state
          // machine instead of inferring from messages avoids loop-the-AI scenarios.
          if (!_bypassByRecentBooking && currentConvState) {
            const stateCtx = currentConvState.context || {};
            const stateOK = ["slot_chosen", "awaiting_cpf", "awaiting_confirmation", "booking_created"]
              .includes(currentConvState.current_state);
            if (stateOK && (stateCtx.date || stateCtx.time)) {
              const tokensLower = _scheduleGuard.tokens.map((t) => t.toLowerCase());
              const ctxStrings: string[] = [];
              if (stateCtx.date) {
                ctxStrings.push(String(stateCtx.date).toLowerCase());
                const m = String(stateCtx.date).match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (m) {
                  ctxStrings.push(`${m[3]}/${m[2]}`, `${parseInt(m[3])}/${parseInt(m[2])}`, `${m[3]}/${m[2]}/${m[1]}`);
                }
              }
              if (stateCtx.time) {
                const t = String(stateCtx.time).toLowerCase();
                ctxStrings.push(t);
                const hm = t.match(/^(\d{1,2}):(\d{2})/);
                if (hm) {
                  const h = parseInt(hm[1]);
                  const mm = hm[2];
                  ctxStrings.push(`${h}h`, `${h}h${mm}`, `${h}:${mm}`, `${String(h).padStart(2, "0")}:${mm}`);
                }
              }
              const hay = ctxStrings.join(" ");
              const allCovered = tokensLower.every((tok) => hay.includes(tok) || ctxStrings.some((c) => c.includes(tok)));
              if (allCovered) {
                _bypassByRecentBooking = true;
                console.log(`[AntiHallucination] ✅ bypass via conversation_state (${currentConvState.current_state}) — tokens [${_scheduleGuard.tokens.join(",")}] covered by state context`);
              }
            }
          }
          // S2C (relatorio 23/06 — 7 conversas com loop "Vou conferir os horarios reais"):
          // ultimo fallback de bypass — le DIRETO da tabela slot_locks. Se ha um slot
          // travado pra este paciente cujo (data,hora) casa com tokens da resposta,
          // libera. Nao depende de conversation_state estar populado (que falhava em
          // alguns casos onde a transicao nao foi gravada).
          if (!_bypassByRecentBooking && clinicTokenId && phone) {
            try {
              const phoneVariantsSlot = getPhoneVariants(phone);
              const { data: activeLocks } = await supabase
                .from("slot_locks")
                .select("doctor_id, slot_date, slot_time, expires_at")
                .eq("clinic_token_id", clinicTokenId)
                .in("phone", phoneVariantsSlot)
                .gt("expires_at", new Date().toISOString());
              if (Array.isArray(activeLocks) && activeLocks.length > 0) {
                const tokensLower = _scheduleGuard.tokens.map((t) => t.toLowerCase());
                const lockStrings: string[] = [];
                for (const lock of activeLocks) {
                  const d = String((lock as any).slot_date || "");
                  const t = String((lock as any).slot_time || "");
                  lockStrings.push(d.toLowerCase(), t.toLowerCase());
                  const md = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
                  if (md) {
                    lockStrings.push(`${md[3]}/${md[2]}`, `${parseInt(md[3])}/${parseInt(md[2])}`);
                  }
                  const mt = t.match(/^(\d{1,2}):(\d{2})/);
                  if (mt) {
                    const h = parseInt(mt[1]);
                    const mm = mt[2];
                    lockStrings.push(`${h}h`, `${h}h${mm}`, `${h}:${mm}`, `${String(h).padStart(2, "0")}:${mm}`);
                  }
                }
                const hay = lockStrings.join(" ");
                const allCovered = tokensLower.every((tok) => hay.includes(tok) || lockStrings.some((c) => c.includes(tok)));
                if (allCovered) {
                  _bypassByRecentBooking = true;
                  console.log(
                    `[AntiHallucination] ✅ bypass via slot_locks DIRECT — tokens [${_scheduleGuard.tokens.join(",")}] covered by ${activeLocks.length} active lock(s)`,
                  );
                }
              }
            } catch (e) {
              console.log(`[AntiHallucination] slot_locks bypass check error (non-blocking): ${(e as Error).message}`);
            }
          }
          // ECHO BYPASS (relatorios 29/06-01/07 — recorrencia nº1): paciente confirma
          // um horario que o PROPRIO bot ofereceu segundos antes ("16:40") e o guard
          // bloqueava, porque nesse turno nao houve fetch novo de slots (needs_info de
          // CPF etc). Se TODOS os tokens da resposta ja sairam em mensagens OUTGOING
          // desta conversa com verified_schedule=true nos ultimos 30 min, o bot ja
          // disse esses horarios com respaldo da API — repetir nao e' alucinacao.
          // Janela de 30min (nao 60) limita o risco de staleness em cadeia; o POST de
          // booking continua protegido por validateBookingDate + verify-booking.
          if (!_bypassByRecentBooking && conversationId && _scheduleGuard.tokens.length > 0) {
            try {
              const _since30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
              const { data: _verifiedOutgoing } = await supabase
                .from("webhook_messages")
                .select("message_text, created_at")
                .eq("conversation_id", conversationId)
                .eq("direction", "outgoing")
                .eq("verified_schedule", true)
                .gte("created_at", _since30)
                .order("created_at", { ascending: false })
                .limit(10);
              const _echoHay = (_verifiedOutgoing || [])
                .map((r: any) => String(r.message_text || ""))
                .join(" ")
                .toLowerCase();
              if (_echoHay) {
                const _allEchoed = _scheduleGuard.tokens.every((t) =>
                  _normalizeToken(t).some((v) => _echoHay.includes(v)),
                );
                if (_allEchoed) {
                  _bypassByRecentBooking = true;
                  console.log(
                    `[AntiHallucination] ✅ bypass via ECHO — tokens [${_scheduleGuard.tokens.join(",")}] ja enviados pelo bot com verified_schedule=true (30min)`,
                  );
                }
              }
            } catch (e) {
              console.log(`[AntiHallucination] echo bypass check error (non-blocking): ${(e as Error).message}`);
            }
          }
          if (_bypassByRecentBooking) {
            verifiedScheduleFlag = true;
          } else {
            console.log(`[AntiHallucination] blocked_unverified_schedule_terms — ${_scheduleGuard.reason}`);
            replyText = _scheduleGuard.cleaned;
            verifiedScheduleFlag = false;
            try {
              await supabase
                .from("webhook_messages")
                .update({
                  action_error: `[AntiHallucination] ${_scheduleGuard.reason}`,
                })
                .eq("id", messageId);
            } catch { /* non-blocking */ }

            // Loop guard: if this same fallback already went out 2+ times in the
            // last 15min on this conversation, the model is stuck. Stop sending
            // the same generic line forever and hand off to a human.
            if (conversationId) {
              try {
                const since15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
                // S2B: pega variacoes da frase, nao so' a canonica. O LLM as vezes
                // parafraseia ("vou confirmar a agenda", "verificar disponibilidade",
                // "antes de passar uma opcao") — todas indicam o mesmo loop.
                const { data: outgoingMessages } = await supabase
                  .from("webhook_messages")
                  .select("message_text")
                  .eq("conversation_id", conversationId)
                  .eq("direction", "outgoing")
                  .gte("created_at", since15)
                  .limit(20);
                const fallbackVariants = [
                  /horários\s+reais\s+da\s+agenda/i,
                  /vou\s+conferir\s+(os\s+)?horários/i,
                  /verificar\s+(a\s+)?(disponibilidade|agenda)/i,
                  /antes\s+de\s+(te\s+)?passar\s+uma?\s+opção/i,
                  /me\s+confirmar?\s+o\s+médico\s+e\s+a\s+(melhor\s+)?(data|periodo)/i,
                ];
                let fallbackCount = 0;
                for (const m of outgoingMessages || []) {
                  const txt = String((m as any).message_text || "");
                  if (fallbackVariants.some((re) => re.test(txt))) fallbackCount++;
                }
                // FIX (29/06 conv 79 — loop nunca escalava): o dedup guard suprime o 2º
                // envio identico E pula o insert do outgoing, entao o contador acima
                // nunca chegava a 2. Os BLOCKS ficam registrados no action_error dos
                // INCOMING (persistido acima, ANTES deste check — inclui o block atual).
                // 2 blocks em 15min = loop -> escala mesmo com envios suprimidos.
                let blockedCount = 0;
                try {
                  const { count: _bc } = await supabase
                    .from("webhook_messages")
                    .select("id", { count: "exact", head: true })
                    .eq("conversation_id", conversationId)
                    .eq("direction", "incoming")
                    .gte("created_at", since15)
                    .like("action_error", "[AntiHallucination]%");
                  blockedCount = _bc || 0;
                } catch { /* non-blocking */ }
                if ((fallbackCount || 0) >= 2 || blockedCount >= 2) {
                  console.log(
                    `[AntiHallucination] ⛔ FALLBACK_NO_SCHEDULE loop (sends=${fallbackCount}, blocks=${blockedCount}) em 15min — escalando pra humano`,
                  );
                  const escalateMsg =
                    "Vou pedir pra uma colega da equipe continuar com você daqui, pra agilizar e não te deixar esperando. 🙏";
                  if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
                    try {
                      await sendAvanceaiReply(
                        avanceaiBaseUrl,
                        avanceaiApiId,
                        avanceaiBearerToken,
                        phone,
                        escalateMsg,
                        resolvedChannelId,
                      );
                    } catch (e) {
                      console.error(`[AntiHallucination] escalate reply failed: ${(e as Error).message}`);
                    }
                    try {
                      await transferTicketToHuman({
                        baseUrl: avanceaiBaseUrl,
                        apiId: avanceaiApiId,
                        bearerToken: avanceaiBearerToken,
                        phone,
                        channelId: resolvedChannelId,
                      });
                    } catch (e) {
                      console.error(`[AntiHallucination] escalate transfer failed: ${(e as Error).message}`);
                    }
                  }
                  await supabase
                    .from("webhook_messages")
                    .update({
                      action_status: "fallback_loop_escalated",
                      action_error: `FALLBACK_NO_SCHEDULE saiu ${fallbackCount + 1}x em 15min — transferido para atendente`,
                    })
                    .eq("id", messageId);
                  await auditTransfer(supabase, {
                    clinicTokenId, conversationId, phone,
                    initiatedBy: "julia", trigger: "breaker_loop",
                    reason: "fallback_no_schedule_2x_15min",
                    detail: (finalMessage || "").slice(0, 120),
                  });
                  return new Response(
                    JSON.stringify({ status: "fallback_loop_escalated", count: (fallbackCount || 0) + 1 }),
                    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
                  );
                }
              } catch (e) {
                console.log(`[AntiHallucination] loop guard check error (non-blocking): ${(e as Error).message}`);
              }
            }
          }
        } else if (_hadScheduleTokens) {
          verifiedScheduleFlag = true;
        }


        // === GUARD DE CONVÊNIO: afirmar cobertura é PROIBIDO fora da tabela ===
        // Caso Rafael (26/08): "Convênio: Plano Bradesco Empresarial - Saúde Top"
        // e a Julia respondeu "confirmei sua consulta ... pelo seu convênio
        // Bradesco ✅". "Saúde Top" não é "Top Nacional". A regra já existia no
        // custom_notes; era prompt, e prompt falha. Mesma ideia do
        // anti-alucinação de horário: o texto sai e alguém determinístico confere.
        {
          // O plano aparece no que o PACIENTE escreveu, não no que a Julia gerou —
          // e nem sempre na mensagem atual. No caso Rafael ele mandou o plano às
          // 15:29:01 e a afirmação saiu às 15:30:16, depois de dois "Sim".
          // Passo 1 é de graça (mensagem atual); só quando ele reprova é que
          // vamos ao banco buscar o histórico, para não pagar SELECT em toda
          // resposta que menciona um convênio.
          let _vConv = validarAfirmacaoDeConvenio(replyText, finalMessage || "");
          if (!_vConv.ok && conversationId) {
            try {
              const { data: _histConv } = await supabase
                .from("webhook_messages")
                .select("message_text")
                .eq("conversation_id", conversationId)
                .eq("direction", "incoming")
                .order("created_at", { ascending: false })
                .limit(12);
              const _ctxConv = [finalMessage || "", ...(_histConv || []).map((r: any) => String(r.message_text || ""))]
                .join("\n");
              _vConv = validarAfirmacaoDeConvenio(replyText, _ctxConv);
            } catch (e) {
              // Fail-closed: sem histórico, a afirmação continua bloqueada. Mandar
              // o paciente para a equipe é o erro barato; dizer "seu convênio está
              // confirmado" sem poder checar é o caro.
              console.log(`[GuardConvenio] histórico indisponível (${(e as Error).message}) — mantendo o bloqueio`);
            }
          }
          if (!_vConv.ok) {
            console.log(
              `[GuardConvenio] ⛔ afirmação de cobertura bloqueada — convenio=${_vConv.convenio} motivo=${_vConv.motivo}`,
            );
            replyText = textoDeConvenioNaoConfirmado(_vConv);
            if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
              try {
                // sem alvo dirigido: fila de pendentes, como as demais
                await transferTicketToHuman({
                  baseUrl: avanceaiBaseUrl,
                  apiId: avanceaiApiId,
                  bearerToken: avanceaiBearerToken,
                  phone,
                  channelId: resolvedChannelId,
                });
              } catch (e) {
                console.error(`[GuardConvenio] transferência falhou: ${(e as Error).message}`);
              }
            }
            if (clinicTokenId) {
              await auditTransfer(supabase, {
                clinicTokenId, conversationId, phone,
                initiatedBy: "julia", trigger: "convenio_nao_confirmado",
                reason: `${_vConv.convenio}:${_vConv.motivo}`,
                detail: (finalMessage || "").slice(0, 120),
              });
            }
            try {
              await supabase
                .from("webhook_messages")
                .update({ action_error: `Guard de convênio: ${_vConv.convenio} (${_vConv.motivo}) — afirmação substituída` })
                .eq("id", messageId);
            } catch { /* non-blocking */ }
          }
        }

        // === SANITIZE REPLY: validate format before sending ===
        const sanitized = sanitizeReply(replyText);
        if (!sanitized.valid) {
          console.log(`[Webhook] ⚠️ sanitizeReply rejected reply — using fallback`);
          // Try to transfer to human when reply is malformed
          if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
            try {
              await transferTicketToHuman({
                baseUrl: avanceaiBaseUrl,
                apiId: avanceaiApiId,
                bearerToken: avanceaiBearerToken,
                phone,
                channelId: resolvedChannelId,
              });
            } catch {
              /* non-blocking */
            }
          }
        }
        replyText = sanitized.cleaned;

        // === REPETIÇÃO ÚTIL (relatorio 06/07 conversa 67, Déa) ===
        // Paciente insiste ("só fim do mês?", "antes não tem?") e o fluxo re-gera a
        // MESMA lista de horários. Repetir frustra e alimenta o breaker; responder
        // curto que aqueles são os primeiros horários resolve a pergunta de verdade.
        try {
          if (conversationId && /Horários disponíveis com/i.test(replyText)) {
            const _since30r = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const { data: _prevOffer } = await supabase
              .from("webhook_messages")
              .select("message_text")
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .eq("verified_schedule", true)
              .gte("created_at", _since30r)
              .order("created_at", { ascending: false })
              .limit(1);
            const _prevTxt = String(_prevOffer?.[0]?.message_text || "");
            if (_prevTxt && nearDuplicate(replyText, _prevTxt)) {
              const _docM = replyText.match(/Horários disponíveis com ([^\n(:]+)/i);
              const _docN = (_docM?.[1] || "o médico").trim();
              console.log(`[RepeatOffer] mesma lista de horários em 30min — respondendo "primeiros horários" em vez de repetir`);
              replyText = `Infelizmente esses que te passei são os primeiros horários disponíveis do(a) ${_docN} — não tenho nada antes disso. 🙏 Algum deles te atende?`;
              verifiedScheduleFlag = null;
            }
          }
        } catch (e) {
          console.log(`[RepeatOffer] check error (non-blocking): ${(e as Error).message}`);
        }

        // === CPF-ASK DEDUP (relatorio 06/07 conversa 75, Carla) ===
        // Duas mensagens processadas em corrida geravam DOIS pedidos de CPF quase
        // simultâneos (parafraseados — o dedup textual não pega). Se já pedimos CPF
        // nesta conversa há <2min, suprime o segundo pedido.
        try {
          // Caso Iago 14/07: o paciente RESPONDEU com um CPF (válido OU inválido) e a
          // resposta ("esse CPF não confere, confere os números?" / confirmação) foi
          // engolida por este dedup, deixando-o no vácuo. Se a mensagem atual já traz um
          // número com cara de CPF (11 dígitos isolados, formatado ou não), é a vez dele —
          // não é "pedido duplicado em corrida" (esse é o caso Carla, sem CPF na mensagem).
          const _patientRepliedWithCpf = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/.test(
            finalMessage || "",
          );
          if (
            conversationId &&
            !_patientRepliedWithCpf &&
            /\bCPF\b/i.test(replyText) &&
            replyText.includes("?")
          ) {
            const _since2m = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            const { data: _prevCpfAsk } = await supabase
              .from("webhook_messages")
              .select("id")
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .gte("created_at", _since2m)
              .ilike("message_text", "%cpf%")
              .limit(1);
            if (_prevCpfAsk && _prevCpfAsk.length > 0) {
              console.log(`[CpfAskDedup] 🔁 pedido de CPF já enviado há <2min — suprimindo repetição`);
              await supabase
                .from("webhook_messages")
                .update({
                  action_status: "duplicate_suppressed",
                  action_error: "Pedido de CPF repetido em <2min (corrida de mensagens) — suprimido",
                })
                .eq("id", messageId);
              return new Response(
                JSON.stringify({ status: "duplicate_suppressed", reason: "cpf_ask_repeated" }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          }
        } catch (e) {
          console.log(`[CpfAskDedup] check error (non-blocking): ${(e as Error).message}`);
        }

        // === TRANSIENT LOOP (relatorio 06/07 conversa 75) ===
        // 2º erro transiente na mesma conversa em 15min: parar de repetir "tente de
        // novo em instantes" e transferir para uma atendente concluir o atendimento.
        try {
          if (actionResult.status === "transient_error" && conversationId) {
            const _since15t = new Date(Date.now() - 15 * 60 * 1000).toISOString();
            const { count: _prevTransient } = await supabase
              .from("webhook_messages")
              .select("id", { count: "exact", head: true })
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .gte("created_at", _since15t)
              .ilike("message_text", "%instabilidade momentânea%");
            if ((_prevTransient || 0) >= 1) {
              console.log(`[TransientLoop] ⛔ 2º erro transiente em 15min — transferindo para atendente`);
              if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
                try {
                  await transferTicketToHuman({
                    baseUrl: avanceaiBaseUrl,
                    apiId: avanceaiApiId,
                    bearerToken: avanceaiBearerToken,
                    phone,
                    channelId: resolvedChannelId,
                  });
                } catch (te) {
                  console.error(`[TransientLoop] transfer failed: ${(te as Error).message}`);
                }
              }
              await auditTransfer(supabase, {
                clinicTokenId, conversationId, phone,
                initiatedBy: "julia", trigger: "breaker_loop",
                reason: "transient_error_2x_15min",
                detail: (finalMessage || "").slice(0, 120),
              });
              replyText =
                "Nosso sistema está instável neste momento e não quero te deixar tentando de novo. 🙏 Já te passei para uma atendente da equipe, que vai concluir o atendimento pra você, tá bom?";
              try {
                await supabase
                  .from("webhook_messages")
                  .update({ action_status: "transferred_transient_loop" })
                  .eq("id", messageId);
              } catch { /* non-blocking */ }
            }
          }
        } catch (e) {
          console.log(`[TransientLoop] check error (non-blocking): ${(e as Error).message}`);
        }

        // === OPÇÃO DE MARCAR SEMPRE (pedido 10/07) ===
        // Falha transiente do Amigo respondia só "tente de novo em instantes" — sem
        // NENHUM caminho pra marcar (caso Danielle 10/07 12:59). Anexa o link do
        // widget como alternativa sempre disponível. (Se o TransientLoop acima já
        // transformou a resposta em transferência, o marcador não está mais no texto.)
        try {
          if (
            actionResult.status === "transient_error" &&
            (replyText.includes("instabilidade momentânea") || replyText.includes("dificuldade técnica para acessar"))
          ) {
            const _altUrl = await getWidgetUrl(supabase, clinicTokenId);
            if (_altUrl) {
              replyText += `\n\nSe preferir não esperar, é só clicar aqui para agendar direto pelo nosso sistema 😊\n${_altUrl}`;
              console.log(`[AlwaysOfferBooking] link do widget anexado à mensagem de instabilidade`);
            }
          }
        } catch (e) {
          console.log(`[AlwaysOfferBooking] error (non-blocking): ${(e as Error).message}`);
        }

        // === GREETING REWRITE (P1 dos relatorios 15-19/06) ===
        // Defesa em profundidade — se o LLM gerou uma saudacao parafrasada que escapou
        // do greeting shortcut (ex: "assistente virtual da Clinica ortopedica com todas
        // as especialidades..."), substituir pelo texto oficial do clinic_info.greeting_template.
        try {
          const tpl = String(clinicRef?.greeting_template || "").trim();
          if (tpl.length > 10) {
            const looksLikeGreeting =
              /\b(eu\s+sou|sou\s+a|me\s+chamo)\b/i.test(replyText) &&
              /\b(julia|assistente|virtual)\b/i.test(replyText) &&
              /\b(ajud[aá]|agendamento|d[uú]vida)\b/i.test(replyText);
            if (looksLikeGreeting) {
              const tplWords = tpl
                .replace(/[^\w\sÀ-ÿ]/g, " ")
                .split(/\s+/)
                .filter((w) => w.length >= 5 && /[A-ZÀ-Ý]/.test(w[0]));
              const clinicMarker = tplWords.find((w) => /[A-ZÀ-Ý]{2,}/.test(w)) || "";
              const replyHasMarker = clinicMarker && replyText.includes(clinicMarker);
              if (!replyHasMarker) {
                console.log(
                  `[Webhook] 🔁 GREETING REWRITE — reply parafraseou saudacao, substituindo por greeting_template oficial (marker="${clinicMarker}")`,
                );
                replyText = tpl;
              }
            }
          }
        } catch (e) {
          console.log(`[Webhook] greeting rewrite error (non-blocking): ${(e as Error).message}`);
        }

        // === TRANSFER-PROMISE GUARD (11/08) ===
        // Uma auditoria de 55 agentes sobre o dia 10/08 achou 31 defeitos reais, e
        // QUATORZE deles eram o mesmo: a Julia diz que vai chamar alguém, e nenhum
        // código chama. Estão espalhados por caminhos diferentes — as três chaves de
        // circuito, o limite de atendimentos, o loop de erro transiente, o de
        // anti-alucinação, a Regra 7 de "sem horários", a confirmação de consulta, a
        // mídia recebida — e alguns são só texto do prompt, sem execução nenhuma
        // atrás. Remendar caso a caso deixaria o décimo quinto nascer amanhã.
        //
        // Esta é a rede única: se a resposta PROMETE gente e nenhuma transferência
        // real foi registrada para esta conversa nos últimos minutos, ou a promessa
        // vira verdade agora, ou o texto passa a dizer a verdade. Nunca as duas
        // coisas erradas juntas.
        //
        // A checagem é feita no BANCO (transfer_audit / pending_human_transfers), não
        // numa variável de turno: a mesma isolate atende várias conversas ao mesmo
        // tempo e um flag de módulo mentiria entre pacientes.
        try {
          if (PROMESSA_DE_HUMANO_RE.test(replyText) && conversationId) {
            const _desde = new Date(Date.now() - 3 * 60_000).toISOString();
            const [{ data: _audit }, { data: _pend }] = await Promise.all([
              supabase.from("transfer_audit").select("id")
                .eq("conversation_id", conversationId).gte("created_at", _desde).limit(1),
              supabase.from("pending_human_transfers").select("id")
                .eq("conversation_id", conversationId).gte("created_at", _desde).limit(1),
            ]);
            const _houveTransferencia =
              (_audit && _audit.length > 0) || (_pend && _pend.length > 0);
            if (!_houveTransferencia) {
              console.log(
                `[TransferPromiseGuard] resposta promete atendimento humano sem transferência registrada — tentando cumprir a promessa`,
              );
              let _cumpriu = { ok: false } as { ok: boolean; attendantName?: string };
              if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone && !isTestMode) {
                _cumpriu = await transferirComDono(supabase, {
                  clinicTokenId,
                  conversationId,
                  phone,
                  intent: "promessa_de_transferencia",
                  baseUrl: avanceaiBaseUrl,
                  apiId: avanceaiApiId,
                  bearerToken: avanceaiBearerToken,
                  channelId: resolvedChannelId,
                  currentMessageText: finalMessage || null,
                });
              }
              if (!_cumpriu.ok) {
                // Ninguém disponível: a resposta para de prometer e passa a dar ao
                // paciente algo que ele PODE fazer.
                replyText =
                  "Não consigo resolver isso sozinha por aqui. 🙏 Nossa equipe não está disponível neste momento — deixei seu caso registrado e te respondem assim que alguém entrar. Se for urgente, o telefone da clínica é o caminho mais rápido.";
                try {
                  await supabase.from("webhook_messages").update({
                    action_status: "promessa_sem_lastro_corrigida",
                    action_error: "Resposta prometia atendente sem transferência real; texto substituído por versão honesta",
                  }).eq("id", messageId);
                } catch { /* non-blocking */ }
              } else {
                console.log(`[TransferPromiseGuard] promessa cumprida — ticket com ${_cumpriu.attendantName}`);
              }
            }
          }
        } catch (e) {
          console.log(`[TransferPromiseGuard] check error (non-blocking): ${(e as Error).message}`);
        }

        // === FALSE-CONFIRMATION GUARD (caso Carina 03/06) ===
        // NUNCA podemos dizer "reservei" / "agendei" / "marquei" / "confirmei" se a action
        // não foi um booking real bem-sucedido. Mesmo que todos os outros guards falhem
        // por alguma razão, esse aqui é o último cinto-de-segurança: paciente ir à clínica
        // achando que tem consulta é o pior cenário possível.
        try {
          // CONFIRMAR e CANCELAR entram aqui (caso Camila 06/08). A lista tinha só os
          // intents de MARCAR, então quando a paciente pediu "gostaria de confirmar
          // minha consulta", mandou o CPF e o sistema CONFIRMOU DE VERDADE, a frase
          // verdadeira ("confirmei sua consulta") batia em claimsBooking, não achava
          // "confirmar" na lista e era trocada pelo texto de agendamento — a paciente
          // recebeu "me repita o médico, a data e o horário" sobre uma consulta que
          // ela já tinha marcada havia uma semana. O gate de segurança continua o
          // mesmo: só vale com status === "success", ou seja, com a ação REAL feita.
          const successfulBookingIntents = ["agendar", "reagendar", "cadastrar", "confirmar", "cancelar"];
          const claimsBooking =
            /\b(reservei|reservado|reservada|agendei|agendado|agendada|marquei|marcado|marcada|confirmei|confirmado|confirmada)\s+(o\s+)?(seu|sua|seu\s+hor[aá]rio|a\s+consulta|teu)\b/i.test(replyText) ||
            // ARTIGO no lugar do possessivo (caso 10/08). A Julia
            // escreveu "Já reservei O horário das 15:30 hoje com o Dr. Paulo
            // Romano para você" com action_status=unknown_intent — nada tinha
            // sido agendado, e a atendente teve que entrar e avisar que aquele
            // médico nem atendia naquele dia. O padrão acima exigia "seu/sua"
            // logo depois do verbo, então "reservei o horário" passava ileso.
            /\b(reservei|agendei|marquei|confirmei)\s+(aqui\s+)?(o|a|esse|este|essa|esta)\s+(hor[aá]rio|vaga|consulta|agendamento)\b/i.test(replyText) ||
            /\bacabei\s+de\s+(reservar|agendar|marcar|confirmar)\b/i.test(replyText) ||
            /\b(reserva|agendamento)\s+(feita|feito|garantida|garantido|conclu[ií]da|conclu[ií]do)\b/i.test(replyText) ||
            // Caso Rejane/Carol 13/07: "Combinei aqui com o Dr. Hugo para amanhã às 16:20"
            /\bcombinei\b[\s\S]{0,80}\b(dr|dra|doutor|doutora|consulta|retorno|amanh[aã]|\bdia\b|\d{1,2}\s*[:h])/i.test(replyText) ||
            // "seu retorno JÁ está agendado/marcado/confirmado"
            /\b(seu|sua)\s+(retorno|consulta|agendamento)\s+(j[aá]\s+)?(est[aá]|foi|ficou|fica)\s+(agendad|marcad|confirmad|reservad)/i.test(replyText) ||
            // Caso Andreia 10/07: "está tudo certinho ... para o seu retorno/consulta"
            // (NÃO casa "tudo certinho com o seu CADASTRO" — exige "para ... retorno/consulta/agendamento")
            /\b(est[aá]|ficou|foi|deixei)\s+tudo\s+cert\w*[\s\S]{0,25}\b(para|pro|pra)\s+(o\s+)?(seu|sua|a\s+sua)\s+(retorno|consulta|agendamento)/i.test(replyText) ||
            /\bdeixei\s+(agendad|marcad|reservad)/i.test(replyText) ||
            /\b(agendad[oa]|marcad[oa]|confirmad[oa]|reservad[oa])\s+(com\s+sucesso|para\s+(amanh[aã]|o\s+dia|hoje|segunda|ter[cç]a|quarta|quinta|sexta))/i.test(replyText) ||
            // === Caso Anderson 21/07 (aceite de lista de espera) ===
            // A Julia respondeu "Consegui confirmar sua antecipação ... Já reagendei
            // para você" com actionResult.status=needs_info — NADA foi remarcado, e o
            // paciente teve que pedir atendente. Passou ileso porque a guarda só
            // conhecia os verbos de agendamento NOVO (agendei/marquei/reservei) com
            // objeto "seu/sua/a consulta": faltavam (a) os verbos de REAGENDAMENTO,
            // (b) "consegui <verbo>" e (c) o objeto "para você".
            // Só 1ª pessoa no passado ou "foi/está <particípio>" — evita barrar
            // promessa futura legítima ("seu horário será remarcado").
            /\b(reagendei|remarquei|antecipei)\b/i.test(replyText) ||
            /\b(foi|est[aá]|ficou)\s+(reagendad[oa]|remarcad[oa]|antecipad[oa])\b/i.test(replyText) ||
            /\bconsegui\s+(agendar|marcar|reservar|confirmar|reagendar|remarcar|antecipar)\b/i.test(replyText) ||
            /\bantecipa[çc][ãa]o\s+(est[aá]|foi|ficou)\s+(confirmad|garantid|feit|conclu)/i.test(replyText) ||
            // (?![\p{L}]) no lugar de \b: "você" termina em acento, e \b do JS usa
            // alfabeto ASCII — "para você dia 30" NÃO casaria com \b depois do "ê".
            /\b(reservei|agendei|marquei|confirmei)\s+(para|pra)\s+(voc[êe]|ti)(?![\p{L}])/iu.test(replyText);
          // consultar REPORTA agendamentos existentes — não é booking novo. Se o retorno
          // traz ao menos um agendamento REAL e não-cancelado, dizer "sua consulta está
          // marcada para X" é VERDADE, não confirmação falsa (caso Sandra 16/07: a guarda
          // bloqueava a leitura de uma consulta que EXISTIA de fato e soltava o fallback
          // "Quase concluí seu agendamento", confundindo quem só perguntou o horário).
          // consultar devolve status=success MESMO com lista vazia, então exigimos
          // agendamento real no corpo — vazio/cancelado continua bloqueado (anti-fabricação).
          let _consultarHasRealAppt = false;
          if (classification.intent === "consultar" && actionResult.status === "success") {
            try {
              const _appts = JSON.parse((actionResult as any).response || "[]");
              _consultarHasRealAppt =
                Array.isArray(_appts) &&
                _appts.some((a: any) => {
                  if (!a || !(a.id || a.start_date)) return false;
                  // MESMA lógica de cancelamento dos outros 6 sites do arquivo: o Amigo
                  // codifica cancelamento de 4 formas. Só a checagem booleana deixaria
                  // passar status:"cancelled"/"cancelado" e canceled:"true" (string) —
                  // e a guarda confirmaria uma consulta CANCELADA como ativa.
                  const _st = String(a.status || "").toLowerCase();
                  const _cancelled =
                    _st === "cancelled" || _st === "cancelado" ||
                    a.canceled === true || a.canceled === "true";
                  return !_cancelled;
                });
            } catch { /* resposta não é lista de agendamentos → trata como vazio */ }
          }
          // RESERVA PROVISÓRIA é verdade, não mentira. Durante o cadastro a Julia
          // diz "já reservei esse horário" enquanto pede os dados — e isso é
          // honesto: existe uma trava real em `slot_locks` segurando a vaga. São
          // ~55 mensagens por mês nesse formato. O que separa isso do caso Ana é o
          // ESTADO: needs_info/needs_registration significam "ainda estou pedindo
          // algo"; unknown_intent/failed significam que não houve ação nenhuma.
          const _reservaProvisoria =
            actionResult.status === "needs_info" || actionResult.status === "needs_registration";
          const isLegitBookingSuccess =
            (successfulBookingIntents.includes(classification.intent || "") &&
              actionResult.status === "success") ||
            _consultarHasRealAppt ||
            _reservaProvisoria;
          if (claimsBooking && !isLegitBookingSuccess) {
            console.log(
              `[FalseConfirmGuard] ⛔ Reply claims booking but action did not confirm it. intent=${classification.intent} status=${actionResult.status} reply="${replyText.slice(0, 120)}"`,
            );
            // Já barramos esta MESMA conversa há pouco? (caso Camila 06/08)
            // O texto de segurança era uma CONSTANTE. Ele pede para o paciente
            // repetir os dados, o que leva de volta ao mesmo guard, que produz a
            // MESMA frase — e aí o dedup de 5 minutos engolia o segundo envio.
            // Resultado: a paciente respondeu e ficou no vácuo, sem nenhuma
            // mensagem. Na segunda vez seguida a saída passa a ser a atendente.
            let _fcgRepetido = false;
            try {
              const { data: _fcgAntes } = await supabase
                .from("webhook_messages")
                .select("id")
                .eq("conversation_id", conversationId)
                .eq("action_status", "false_confirmation_blocked")
                .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
                .limit(1);
              _fcgRepetido = !!(_fcgAntes && _fcgAntes.length > 0);
            } catch { /* na dúvida, trata como primeira vez */ }

            // Replace the lying reply with a safe redirect — no idioma do que o
            // paciente veio fazer. Mandar texto de agendamento para quem quer
            // CONFIRMAR ou CANCELAR só confunde e faz ele repetir dados à toa.
            const _fcgIntent = String(classification.intent || "");
            const safeReply = _fcgRepetido
              ? "Desculpa, não estou conseguindo concluir isso por aqui. 🙏 Me diga *atendente* que eu te transfiro agora para uma pessoa da equipe resolver com você."
              : _fcgIntent === "confirmar"
                ? "Deixa eu conferir sua consulta com calma pra não te passar informação errada. 🙏 Pode me mandar seu *CPF* (só os números)? Se preferir falar com uma pessoa da equipe, é só me dizer *atendente*."
                : _fcgIntent === "cancelar"
                  ? "Deixa eu conferir sua consulta antes de cancelar, pra não mexer na consulta errada. 🙏 Pode me mandar seu *CPF* (só os números)? Se preferir, me diga *atendente* que eu te transfiro."
                  : "Quase concluí seu agendamento! Pra eu garantir a reserva no sistema, preciso confirmar o médico, a data e o horário que você quer. Pode me repetir, por favor? 🙏";
            replyText = safeReply;
            try {
              await supabase
                .from("webhook_messages")
                .update({
                  action_status: "false_confirmation_blocked",
                  action_error: `Reply asserted booking but actionResult.status=${actionResult.status}, intent=${classification.intent}${_fcgRepetido ? " [2a vez em 10min — ofereci atendente]" : ""}`,
                })
                .eq("id", messageId);
            } catch { /* non-blocking */ }
          }
        } catch (e) {
          console.log(`[FalseConfirmGuard] check error (non-blocking): ${(e as Error).message}`);
        }

        // === LISTA DE ESPERA: convite pós-booking distante (06/07 v2) ===
        // Regra do usuário: entra na lista quem JÁ MARCOU uma consulta a 7+ dias.
        // Assim o aceite da vaga vira REAGENDAMENTO da consulta existente (nunca
        // duplica) e o horário antigo liberado pode servir ao próximo da fila.
        // O médico/data vêm da linha que o próprio booking acabou de inserir em
        // pending_booking_verifications (doctor_id/doctor_name/target_date exatos).
        try {
          if (
            classification.intent === "agendar" &&
            actionResult.status === "success" &&
            clinicTokenId && phone &&
            (await isWaitlistEnabled(supabase, clinicTokenId))
          ) {
            const _since5m = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            const { data: _pbv } = await supabase
              .from("pending_booking_verifications")
              .select("doctor_id, doctor_name, target_date")
              .eq("clinic_token_id", clinicTokenId)
              .in("phone", getPhoneVariants(phone))
              .gte("created_at", _since5m)
              .order("created_at", { ascending: false })
              .limit(1);
            const _pb = _pbv?.[0] as any;
            if (_pb?.doctor_id && _pb?.target_date) {
              const _inv = buildWaitlistInvite(
                String(_pb.target_date),
                getTodayISO_SP(),
                String(_pb.doctor_name || "o médico"),
              );
              if (_inv) {
                const { data: _already } = await supabase
                  .from("waitlist_entries")
                  .select("id")
                  .eq("clinic_token_id", clinicTokenId)
                  .eq("doctor_id", String(_pb.doctor_id))
                  .in("phone", getPhoneVariants(phone))
                  .in("status", ["waiting", "notified"])
                  .limit(1);
                if (!_already || _already.length === 0) {
                  replyText = replyText + _inv;
                  // Contexto auditável no outgoing: é daqui que a keyword
                  // "lista de espera" recupera o médico (24h).
                  (actionResult as any).schedulingContext = {
                    ...(((actionResult as any).schedulingContext as Record<string, unknown>) || {}),
                    waitlist_invite: {
                      doctor_id: String(_pb.doctor_id),
                      doctor_name: String(_pb.doctor_name || ""),
                      booked_date: String(_pb.target_date),
                    },
                  };
                  console.log(`[Waitlist] convite pós-booking anexado (${_pb.target_date}, ${_pb.doctor_name})`);
                }
              }
            }
          }
        } catch (e) {
          console.log(`[Waitlist] convite pós-booking error (non-blocking): ${(e as Error).message}`);
        }

        // === AVISO DE DIA FECHADO (feriados/emendas — 10/07) ===
        // Hoje é dia fechado cadastrado? Prefixa o aviso com a data de reabertura na
        // PRIMEIRA resposta do dia desta conversa (marcador "clínica está fechada").
        // Roda ANTES da saudação fria: o prefixo final fica saudação → aviso → resposta.
        try {
          if (conversationId && clinicTokenId) {
            const _cdNotice = await getClosedDayInfo(supabase, clinicTokenId);
            if (_cdNotice.closedToday && _cdNotice.reopenISO) {
              const _sinceToday = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
              const { data: _cdPrev } = await supabase
                .from("webhook_messages")
                .select("id")
                .eq("conversation_id", conversationId)
                .eq("direction", "outgoing")
                .gte("created_at", _sinceToday)
                .ilike("message_text", "%clínica está fechada%")
                .limit(1);
              if (!_cdPrev || _cdPrev.length === 0) {
                console.log(`[ClosedDays] dia fechado (${_cdNotice.reason || "sem motivo"}) — prefixando aviso com reabertura ${_cdNotice.reopenISO}`);
                replyText = buildClosedDayNotice(_cdNotice.reason, _cdNotice.reopenISO) + replyText;
              }
            }
          }
        } catch (e) {
          console.log(`[ClosedDays] notice error (non-blocking): ${(e as Error).message}`);
        }

        // === SAUDACAO DE PRIMEIRO CONTATO (avaliacao 06/07) ===
        // Paciente abria a conversa com "boa tarde, quero marcar com o Dr. X" e a
        // resposta deterministica ("Horários disponíveis com...") saia SECA. Se a
        // conversa esta FRIA (nenhuma resposta do bot em 12h) e a resposta final nao
        // comeca com saudacao propria, prefixa "Bom dia/Boa tarde! 👋 Eu sou a Julia..."
        // (apresentacao vem do greeting_template oficial). Roda DEPOIS de todos os
        // guards de conteudo (sanitize/greeting-rewrite/false-confirm) pra sobreviver
        // aos replaces deles; o slot-match parseia horarios por regex no corpo da
        // mensagem, entao o prefixo nao interfere.
        try {
          const _greetPrefix = buildColdOpenGreeting(
            getNowSPParts().hour,
            replyText,
            clinicRef?.greeting_template,
          );
          if (_greetPrefix && conversationId) {
            const _since12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            const { count: _recentOut } = await supabase
              .from("webhook_messages")
              .select("id", { count: "exact", head: true })
              .eq("conversation_id", conversationId)
              .eq("direction", "outgoing")
              .gte("created_at", _since12h);
            if ((_recentOut || 0) === 0) {
              console.log(`[ColdGreeting] conversa fria (0 outgoing em 12h) — prefixando saudacao contextual`);
              replyText = _greetPrefix + replyText;
            }
          }
        } catch (e) {
          console.log(`[ColdGreeting] check error (non-blocking): ${(e as Error).message}`);
        }

        // === SHADOW MODE: register conversation state transition based on outcome ===
        // This is observation only — the rest of the pipeline still infers state from
        // its own logic. Once we see this data is consistent, future commits will make
        // the guards CONSULT this state instead of re-inferring.
        if (clinicTokenId && phone) {
          try {
            const intent = classification.intent || "unknown";
            const stat = actionResult.status || "";
            let nextState: ConversationStateName | null = null;
            let trigger = `${intent}:${stat}`;
            const ctxPatch: Record<string, any> = {};
            if (classification.date) ctxPatch.date = classification.date;
            if (classification.time) ctxPatch.time = classification.time;
            if (classification.doctor_name) ctxPatch.doctor_name = classification.doctor_name;
            if (classification.insurance_choice) ctxPatch.insurance_choice = classification.insurance_choice;
            if (classification.attendance_id) ctxPatch.attendance_id = classification.attendance_id;

            if (stat === "transferred_infiltracao" || stat === "transferred_exame") {
              nextState = "transferred_human";
              // P3: marca o motivo do handoff. Isso impede o stale-cleanup de
              // fechar o estado e impede a IA de oferecer agenda em mensagens
              // futuras do mesmo paciente. Lidiane/Vania ficam donos da conversa
              // ate' efetivamente fecharem (que normalmente nao acontece pelo
              // webhook — fica ate' o paciente ou atendente encerrar).
              ctxPatch.handoff_reason = stat === "transferred_infiltracao" ? "infiltracao" : "exame";
              ctxPatch.handoff_at = new Date().toISOString();
            } else if (intent === "falar_com_atendente" && stat === "success") {
              nextState = "transferred_human";
              // Se a transferencia veio do keyword "cirurgia", marca handoff_reason
              // pra impedir IA de oferecer agenda comum em mensagens futuras
              // (mesma logica de solicitar_infiltracao).
              const kwHandoff = keywordForcedIntent?.handoff_reason;
              if (kwHandoff) {
                ctxPatch.handoff_reason = kwHandoff;
                ctxPatch.handoff_at = new Date().toISOString();
              }
              // Sem handoff_reason explicito — IA pode voltar a operar se
              // humano nao assumir, conforme stale-cleanup normal.
            } else if (intent === "agendar" && stat === "success") {
              nextState = "booking_created";
            } else if (intent === "agendar" && stat === "needs_info") {
              // already transitioned inside executeAction for the awaiting_cpf case;
              // here we register slot_search for the case the AI is showing available slots.
              const errText = String(actionResult.error || "");
              if (errText.includes("Horários disponíveis") || errText.includes("horários disponíveis") || errText.includes("Próximas datas")) {
                nextState = "slot_search";
              }
            } else if (intent === "reagendar" && stat === "needs_info") {
              nextState = "reschedule_search";
            } else if (intent === "cancelar" && stat === "needs_info") {
              nextState = "cancel_pending";
            } else if (intent === "cadastrar" && stat === "needs_info") {
              nextState = "awaiting_registration";
            } else if (intent === "unknown" && /^(ol[aá]|oi|bom dia|boa tarde|boa noite)/i.test((messageStr || "").trim())) {
              nextState = "greeting";
            } else if (["consultar_valores", "consultar_convenios", "consultar_endereco"].includes(intent)) {
              nextState = "info_question";
            } else if (intent === "resetar_conversa") {
              nextState = "idle";
            }
            if (nextState) {
              await transitionConversationState(supabase, {
                clinicTokenId,
                conversationId: conversationId || null,
                phone,
                toState: nextState,
                trigger,
                contextPatch: ctxPatch,
                messageId: messageId || null,
              });
            }
          } catch (e) {
            console.log(`[ConversationState shadow] register error (non-blocking): ${(e as Error).message}`);
          }
        }

        if (isTestMode) {
          // Test mode: save the reply but don't send via WhatsApp
          console.log(`[Webhook] Test mode: skipping WhatsApp delivery. Reply: ${replyText.substring(0, 80)}...`);
          await supabase.from("webhook_messages").insert({
            user_id: userId,
            webhook_id: webhook.id,
            clinic_token_id: clinicTokenId,
            sender_phone: phone,
            sender_name: name,
            message_text: replyText,
            direction: "outgoing",
            conversation_id: conversationId,
            action_status: actionResult.status || "success",
            ai_intent: (actionResult as any).intentOverride || classification.intent,
            ai_entities: (actionResult as any).schedulingContext || null,
            verified_schedule: verifiedScheduleFlag,
          });

          await upsertConversation(supabase, userId, clinicTokenId, phone, name, replyText, "outgoing");
          console.log("[Webhook] Test mode: reply saved to DB without WhatsApp delivery");
        } else {
          // ── REVALIDATE TICKET before sending AI reply ──
          if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
            const replyTicketCheck = await checkTicketIsHumanOwned(
              avanceaiBaseUrl,
              avanceaiApiId,
              avanceaiBearerToken,
              phone,
              resolvedChannelId,
            );
            if (replyTicketCheck.isHumanOwned) {
              console.log(
                `[Webhook] ⛔ Ticket became "open" (agent="${replyTicketCheck.userName}") before sending reply — suppressing AI response`,
              );
              await supabase
                .from("webhook_messages")
                .update({
                  action_status: "skipped",
                  action_error: `Ticket open (agent=${replyTicketCheck.userName}) antes do envio — resposta IA suprimida`,
                })
                .eq("id", messageId);
              return new Response(JSON.stringify({ status: "success", action: "human_agent_active_before_reply" }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }
          // === ANTI-"RESPONSO" (caso Marcos 07/07) — resposta obsoleta ===
          // O paciente manda uma rajada de mensagens e cada uma virava uma resposta. Uma
          // mensagem sai de "pending" logo após executeAction (bem antes do envio, que sob
          // carga demora), então as mensagens da rajada que chegam durante a geração não são
          // coalescidas pelo batch e cada uma responde. Aqui, ANTES de enviar: se o paciente
          // já mandou uma mensagem MAIS NOVA (que vai/já respondeu com o contexto completo),
          // esta resposta conversacional está velha — não envia. Colapsa a rajada em UMA
          // resposta. Deadlock-free: esta msg já não está "pending", então a mais nova
          // sempre responde. NUNCA suprime confirmações (success) nem transferências.
          const _isConversationalReply =
            actionResult.status === "needs_info" || actionResult.status === "unknown_intent";
          if (_isConversationalReply && conversationId && (msgRecord as any)?.created_at) {
            try {
              const _since90 = new Date(Date.now() - 90 * 1000).toISOString();
              const { data: _newerIncoming } = await supabase
                .from("webhook_messages")
                .select("id")
                .eq("conversation_id", conversationId)
                .eq("direction", "incoming")
                .gt("created_at", (msgRecord as any).created_at)
                .gte("created_at", _since90)
                .not("action_status", "in", "(batched,stale,abandoned,skipped,duplicate_suppressed,superseded_by_newer)")
                .limit(1);
              if (_newerIncoming && _newerIncoming.length > 0) {
                console.log(
                  `[AntiResponso] paciente mandou msg mais nova — suprimindo resposta obsoleta desta (${messageId}) para não dar "responso"`,
                );
                await supabase
                  .from("webhook_messages")
                  .update({
                    action_status: "superseded_by_newer",
                    action_error: "Resposta suprimida: paciente enviou mensagem mais nova (anti-responso)",
                  })
                  .eq("id", messageId);
                return new Response(
                  JSON.stringify({ status: "superseded_by_newer", reason: "patient_sent_newer_message" }),
                  { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
                );
              }
            } catch (e) {
              console.log(`[AntiResponso] check error (non-blocking): ${(e as Error).message}`);
            }
          }

          // Dedup guard: suppress sending if this reply is near-identical to one we
          // already sent in the last 5 min. Stop the message AND skip the DB insert
          // so it doesn't double-count toward any breaker.
          const dupCheck = await isDuplicateReply(supabase, conversationId, replyText, 300);
          // CORRIDA x VÁCUO (caso Camila 06/08). O dedup nasceu para o caso de duas
          // mensagens processadas quase ao mesmo tempo gerarem dois envios iguais —
          // aí suprimir é certo. Mas ele suprimia TAMBÉM quando o paciente escrevia
          // de novo um minuto depois e o sistema produzia a mesma frase: a paciente
          // respondeu "Dr Felipe Angelini dia 06/08 as 15:40h" e **não recebeu nada**.
          // Ficar mudo com alguém esperando é pior do que repetir. A idade da
          // mensagem anterior separa os dois casos.
          const _JANELA_CORRIDA_S = 120;
          const _idadeDup = dupCheck.matchedAgeSec ?? 0;
          if (dupCheck.duplicate && _idadeDup <= _JANELA_CORRIDA_S) {
            console.log(
              `[Webhook] 🔁 Duplicate reply suppressed for ${phone} (${_idadeDup}s — corrida). Candidate: "${replyText.substring(0, 80)}..." matched recent: "${(dupCheck.matchedText || "").substring(0, 80)}..."`,
            );
            await supabase
              .from("webhook_messages")
              .update({
                action_status: "duplicate_suppressed",
                action_error: `Reply near-identical to outgoing message from ${_idadeDup}s ago (janela de corrida)`,
              })
              .eq("id", messageId);
            return new Response(
              JSON.stringify({ status: "duplicate_suppressed", reason: "near_identical_recent_reply" }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          if (dupCheck.duplicate) {
            // Mais de 2 min: o paciente falou de novo e nós íamos repetir a mesma
            // frase. É sinal de que estamos rodando em círculo — a saída é a equipe,
            // e o texto é DIFERENTE de propósito, senão o próximo ciclo cai aqui de
            // novo e vira silêncio outra vez.
            console.log(
              `[Webhook] 🔁 Resposta repetida após ${_idadeDup}s — oferecendo atendente em vez de ficar mudo (${phone})`,
            );
            replyText =
              "Acho que não estou conseguindo te ajudar direito por aqui. 🙏 Me diga *atendente* que eu passo agora para uma pessoa da equipe — ou, se preferir, me conte de novo com suas palavras o que você precisa.";
            await supabase
              .from("webhook_messages")
              .update({
                action_status: "duplicate_loop_escalated",
                action_error: `Resposta seria idêntica à de ${_idadeDup}s atrás — ofereci atendente em vez de silêncio`,
              })
              .eq("id", messageId);
          }
          console.log(`[Webhook] Sending auto-reply to ${phone}: ${replyText.substring(0, 80)}...`);
          const sent = await sendAvanceaiReply(
            avanceaiBaseUrl,
            avanceaiApiId,
            avanceaiBearerToken,
            phone,
            replyText,
            resolvedChannelId,
          );

          if (sent) {
            await supabase.from("webhook_messages").insert({
              user_id: userId,
              webhook_id: webhook.id,
              clinic_token_id: clinicTokenId,
              sender_phone: phone,
              sender_name: name,
              message_text: replyText,
              direction: "outgoing",
              conversation_id: conversationId,
              action_status: actionResult.status || "success",
              ai_intent: (actionResult as any).intentOverride || classification.intent,
              ai_entities: (actionResult as any).schedulingContext || null,
              verified_schedule: verifiedScheduleFlag,
            });

            await upsertConversation(supabase, userId, clinicTokenId, phone, name, replyText, "outgoing");

            console.log("[Webhook] Auto-reply saved and conversation updated");

            // Lista de espera: booking bem-sucedido dá baixa na oferta pendente.
            // Auditoria 10/07: a baixa era cega (qualquer booking marcava booked).
            // Agora, quando a data do booking é conhecida, só baixa a entry cuja
            // vaga OFERTADA bate com a data agendada; sem data (raro), mantém amplo.
            if (
              (classification.intent === "agendar" || classification.intent === "reagendar") &&
              actionResult.status === "success" &&
              clinicTokenId && phone
            ) {
              try {
                let _bkQuery = supabase
                  .from("waitlist_entries")
                  .update({ status: "booked", updated_at: new Date().toISOString() })
                  .eq("clinic_token_id", clinicTokenId)
                  .in("phone", getPhoneVariants(phone))
                  // 'accepted' (aceitou mas a 1ª efetivação falhou) também baixa
                  // quando o reagendamento finalmente sai (equipe ou nova tentativa)
                  .in("status", ["notified", "accepted"]);
                const _bkDate = normalizeDateToISO(classification.date || "");
                if (_bkDate) _bkQuery = _bkQuery.contains("offered_slot", { date: _bkDate });
                const { data: _bkRows } = await _bkQuery.select("id, doctor_name, conversation_id, patient_name, phone, offered_slot, clinic_token_id");
                for (const r of (_bkRows || []) as any[]) {
                  const _bkSlot = (r.offered_slot && r.offered_slot.date)
                    ? ` para ${ddmmWH(String(r.offered_slot.date))}${r.offered_slot.time ? ` às ${r.offered_slot.time}` : ""}`
                    : "";
                  await logWaitlistEventWH(supabase, {
                    clinic_token_id: r.clinic_token_id, entry_id: r.id, conversation_id: r.conversation_id,
                    phone: r.phone, patient_name: r.patient_name, doctor_name: r.doctor_name,
                    event_type: "antecipou",
                    detail: `${r.patient_name || "Paciente"} aceitou a vaga e ANTECIPOU a consulta com ${r.doctor_name}${_bkSlot}. ✅`,
                  });
                }

                // Achado 20/07 ("às vezes não está tirando a pessoa da lista"): quem
                // estava WAITING e marcou/remarcou com o MESMO médico pelo bot ficava
                // na fila pra sempre — a baixa acima só via notified/accepted. O médico
                // vem da linha que este booking inseriu em pending_booking_verifications.
                // Se a nova data ficou 7+ dias, o convite pós-booking re-oferece entrar
                // de novo (com requested_date fresco) — a fila não fica obsoleta.
                const _sinceBk = new Date(Date.now() - 5 * 60 * 1000).toISOString();
                const { data: _bkPbv } = await supabase
                  .from("pending_booking_verifications")
                  .select("doctor_id")
                  .eq("clinic_token_id", clinicTokenId)
                  .in("phone", getPhoneVariants(phone))
                  .gte("created_at", _sinceBk)
                  .order("created_at", { ascending: false })
                  .limit(1);
                const _bkDoc = (_bkPbv?.[0] as any)?.doctor_id;
                if (_bkDoc) {
                  await supabase
                    .from("waitlist_entries")
                    .update({ status: "booked", updated_at: new Date().toISOString() })
                    .eq("clinic_token_id", clinicTokenId)
                    .eq("doctor_id", String(_bkDoc))
                    .in("phone", getPhoneVariants(phone))
                    .eq("status", "waiting");
                  console.log(`[Waitlist] baixa waiting: booking com o mesmo médico (${_bkDoc}) fecha a entry em espera`);
                }
              } catch (e) {
                console.log(`[Waitlist] baixa booked falhou (non-blocking): ${(e as Error).message}`);
              }
            }
            // GAP fechado (caso Felipe 19/07): paciente ACEITOU a vaga e o reagendar
            // FALHOU (Amigo instável) → a entry não pode continuar 'notified', senão
            // o cron expira a oferta de quem aceitou ("o tempo passou" — cruel) e
            // re-oferta a MESMA vaga a um 3º paciente. Vira 'accepted': sai do ciclo
            // de expiração/re-oferta, o painel mostra "efetivação pendente" e a baixa
            // p/ booked acontece quando a equipe (ou nova tentativa) concluir.
            if (
              (classification.intent === "agendar" || classification.intent === "reagendar") &&
              ["failed", "transient_error"].includes(String(actionResult.status)) &&
              clinicTokenId && phone
            ) {
              try {
                await supabase
                  .from("waitlist_entries")
                  .update({ status: "accepted", updated_at: new Date().toISOString() })
                  .eq("clinic_token_id", clinicTokenId)
                  .in("phone", getPhoneVariants(phone))
                  .eq("status", "notified");
              } catch (e) {
                console.log(`[Waitlist] marca accepted falhou (non-blocking): ${(e as Error).message}`);
              }
            }
            // Auditoria 10/07: CANCELAR a consulta-base quebra a premissa da lista
            // (o aceite REAGENDA a consulta existente). Entry órfã levaria a beco sem
            // saída na futura oferta — limpa a fila do paciente ao cancelar.
            if (classification.intent === "cancelar" && actionResult.status === "success" && clinicTokenId && phone) {
              try {
                await supabase
                  .from("waitlist_entries")
                  .update({ status: "cancelled", cancelled_reason: "consulta_base_cancelada", updated_at: new Date().toISOString() })
                  .eq("clinic_token_id", clinicTokenId)
                  .in("phone", getPhoneVariants(phone))
                  .in("status", ["waiting", "notified", "accepted"]);
              } catch (e) {
                console.log(`[Waitlist] limpeza pós-cancelamento falhou (non-blocking): ${(e as Error).message}`);
              }
            }

            // Schedule ticket resolution after successful booking (3 min delay)
            if (
              classification.intent === "agendar" &&
              actionResult.status === "success" &&
              avanceaiBaseUrl &&
              avanceaiApiId &&
              avanceaiBearerToken
            ) {
              try {
                const executeAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
                await supabase.from("pending_ticket_resolutions").insert({
                  phone,
                  base_url: avanceaiBaseUrl,
                  api_id: avanceaiApiId,
                  bearer_token: avanceaiBearerToken,
                  channel_id: resolvedChannelId || null,
                  clinic_token_id: clinicTokenId,
                  user_id: userId,
                  execute_at: executeAt,
                });
                console.log(`[Webhook] Scheduled ticket resolution for ${phone} at ${executeAt}`);
              } catch (ticketErr) {
                console.error("[Webhook] Failed to schedule ticket resolution:", ticketErr);
              }
            }

            // === FECHAMENTO PÓS-AGRADECIMENTO (caso 06/07) ===
            // Paciente com booking/confirmação nas últimas 24h (via bot OU widget)
            // agradece e encerra ("obrigada!") — resolve o ticket em vez de deixá-lo
            // pendente na fila das atendentes. Reusa a fila do resolve-ticket (cron).
            try {
              if (
                isClosingThanks(finalMessage || "") &&
                conversationId && clinicTokenId && phone &&
                avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken
              ) {
                const _since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const { data: _recentBooked } = await supabase
                  .from("webhook_messages")
                  .select("id")
                  .eq("conversation_id", conversationId)
                  .gte("created_at", _since24h)
                  .or(
                    "and(ai_intent.in.(agendar,reagendar,cadastrar,confirmar),action_status.eq.success),booking_source.eq.widget",
                  )
                  .limit(1);
                if (_recentBooked && _recentBooked.length > 0) {
                  const _closeAt = new Date(Date.now() + 90 * 1000).toISOString();
                  await supabase.from("pending_ticket_resolutions").insert({
                    phone,
                    base_url: avanceaiBaseUrl,
                    api_id: avanceaiApiId,
                    bearer_token: avanceaiBearerToken,
                    channel_id: resolvedChannelId || null,
                    clinic_token_id: clinicTokenId,
                    user_id: userId,
                    execute_at: _closeAt,
                  });
                  console.log(`[TicketClose] agradecimento pós-booking — resolução do ticket agendada para ${_closeAt}`);
                }
              }
            } catch (e) {
              console.log(`[TicketClose] check error (non-blocking): ${(e as Error).message}`);
            }
          } else {
            console.error("[Webhook] Failed to send auto-reply via AvanceAI");
            await supabase
              .from("webhook_messages")
              .update({ action_error: `Falha no envio da resposta via AvanceAI` })
              .eq("id", messageId);
          }
        }
      } else if (isTestMode) {
        // Test mode without AvanceAI configured: still generate and save reply
        console.log("[Webhook] Test mode without AvanceAI: generating reply anyway");
        let replyText: string;
        if (classification.intent === "resetar_conversa") {
          const patientFirstName = identifiedPatient?.name?.split(" ")[0] || "";
          replyText = patientFirstName
            ? `Perfeito, ${patientFirstName}! Vamos começar do zero. 😊 Como posso te ajudar?`
            : `Perfeito! Vamos começar do zero. 😊 Como posso te ajudar?`;
        } else if ((actionResult as any).bypassAiRewrite && actionResult.response) {
          replyText = actionResult.response;
          console.log("[Webhook] (testMode) bypassAiRewrite=true — using actionResult.response directly");
        } else {
          try {
            replyText = await generateAIResponse(
              LOVABLE_API_KEY,
              dynamicScript,
              messageStr,
              classification.intent,
              actionResult,
              {
                date: classification.date,
                time: classification.time,
                doctor_name: classification.doctor_name,
                patient_name: identifiedPatient?.name || classification.patient_name,
                patient_full_name: classification.patient_full_name,
              },
              conversationHistory,
              clinicLocationInfo,
              clinicTokenId,
            );
          } catch (e) {
            console.error("[Webhook] AI response generation failed, using fallback:", e);
            replyText = generateResponseText(
              classification.intent,
              actionResult,
              {
                date: classification.date,
                time: classification.time,
                doctor_name: classification.doctor_name,
                patient_name: identifiedPatient?.name || classification.patient_name,
                patient_full_name: classification.patient_full_name,
              },
              clinicLocationInfo,
            );
          }
        }

        await supabase.from("webhook_messages").insert({
          user_id: userId,
          webhook_id: webhook.id,
          clinic_token_id: clinicTokenId,
          sender_phone: phone,
          sender_name: name,
          message_text: replyText,
          direction: "outgoing",
          conversation_id: conversationId,
          action_status: actionResult.status || "success",
          ai_intent: (actionResult as any).intentOverride || classification.intent,
          ai_entities: (actionResult as any).schedulingContext || null,
          verified_schedule: verifiedScheduleFlag,
        });

        await upsertConversation(supabase, userId, clinicTokenId, phone, name, replyText, "outgoing");
        console.log("[Webhook] Test mode: reply generated and saved without AvanceAI");
      } else {
        console.log("[Webhook] No AvanceAI configured - skipping auto-reply");
      }

      return new Response(
        JSON.stringify({
          status: actionResult.status,
          intent: classification.intent,
          message: actionResult.response || actionResult.error,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (pipelineError: any) {
      // === RELIABILITY: Mark THIS message as failed so it doesn't stay pending forever ===
      console.error(`[Webhook] Pipeline error for message ${messageId}:`, pipelineError);
      try {
        await supabase
          .from("webhook_messages")
          .update({
            action_status: "failed",
            action_error: `Pipeline error: ${pipelineError.message || String(pipelineError)}`,
          })
          .eq("id", messageId);

        // Also mark any sibling pending messages in the same conversation as stale
        // so they don't block future batches
        if (conversationId) {
          const { data: stuckSiblings } = await supabase
            .from("webhook_messages")
            .update({ action_status: "stale", action_error: `Stale: leader ${messageId} failed` })
            .eq("conversation_id", conversationId)
            .eq("direction", "incoming")
            .eq("action_status", "pending")
            .neq("id", messageId)
            .select("id");
          if (stuckSiblings && stuckSiblings.length > 0) {
            console.log(
              `[Webhook] Marked ${stuckSiblings.length} sibling pending messages as stale after leader failure`,
            );
          }
        }

        // === FALLBACK: Transfer to human instead of asking patient to resend ===
        if (!isTestMode && avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken && phone) {
          try {
            // ── REVALIDATE TICKET before fallback ──
            const fallbackTicketCheck = await checkTicketIsHumanOwned(
              avanceaiBaseUrl,
              avanceaiApiId,
              avanceaiBearerToken,
              phone,
              resolvedChannelId,
            );
            if (fallbackTicketCheck.isHumanOwned) {
              console.log(
                `[Webhook] ⛔ Ticket open (agent="${fallbackTicketCheck.userName}") — suppressing fallback message`,
              );
            } else {
              // Check if there were recent pipeline errors in this conversation (last 10 min)
              let recentErrors = 0;
              if (conversationId) {
                const cutoff10min = new Date(Date.now() - 10 * 60 * 1000).toISOString();
                const { data: recentFails } = await supabase
                  .from("webhook_messages")
                  .select("id")
                  .eq("conversation_id", conversationId)
                  .eq("action_status", "failed")
                  .gte("created_at", cutoff10min);
                recentErrors = recentFails?.length || 0;
              }

              if (recentErrors >= 2) {
                // 2nd+ error in 10 min — transfer immediately
                console.log(`[Webhook] ⚡ ${recentErrors} recent errors — transferring to human immediately`);
                const fallbackText =
                  "Desculpe, estou com uma instabilidade técnica. Vou transferir você para um atendente agora. 🙏";
                await sendAvanceaiReply(
                  avanceaiBaseUrl,
                  avanceaiApiId,
                  avanceaiBearerToken,
                  phone,
                  fallbackText,
                  resolvedChannelId,
                );
                try {
                  // Find any online agent to transfer to
                  const listUsersUrl = `${avanceaiBaseUrl}/v2/api/external/${avanceaiApiId}/listUsers`;
                  const usersRes = await fetch(listUsersUrl, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${avanceaiBearerToken}` },
                  });
                  const onlineUsers = usersRes.ok ? await usersRes.json() : [];
                  const onlineAgent = (Array.isArray(onlineUsers) ? onlineUsers : []).find((u: any) => u.online === true);
                  if (onlineAgent) {
                    await transferTicketToHuman({
                      baseUrl: avanceaiBaseUrl,
                      apiId: avanceaiApiId,
                      bearerToken: avanceaiBearerToken,
                      phone,
                      userId: onlineAgent.id,
                      channelId: resolvedChannelId,
                    });
                    console.log(`[Webhook] Fallback transfer to ${onlineAgent.name} successful`);
                  }
                } catch (transferErr) {
                  console.error("[Webhook] Fallback transfer failed:", transferErr);
                }
              } else {
                // 1st error — send empathetic message
                const fallbackText =
                  "Desculpe, tive uma falha técnica momentânea. Pode reenviar sua mensagem, por favor? 🙏";
                await sendAvanceaiReply(
                  avanceaiBaseUrl,
                  avanceaiApiId,
                  avanceaiBearerToken,
                  phone,
                  fallbackText,
                  resolvedChannelId,
                );
                console.log("[Webhook] Sent fallback contingency reply to patient (1st error)");
              }
            }
          } catch (fallbackErr) {
            console.error("[Webhook] Even fallback reply failed:", fallbackErr);
          }
        }
      } catch (cleanupErr) {
        console.error("[Webhook] Error during failure cleanup:", cleanupErr);
      }

      return new Response(JSON.stringify({ status: "error", message: pipelineError.message || "Pipeline error" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (e) {
    console.error("[Webhook] Unhandled error:", e);
    return new Response(JSON.stringify({ error: e.message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
