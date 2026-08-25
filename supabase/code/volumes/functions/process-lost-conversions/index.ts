// process-lost-conversions — cron (10 min): recuperação de agendamentos perdidos.
// Pedido 19/07: fazer follow-up de todo mundo que dá pra monitorar pelo banco:
//   A) 'falha_agendamento' — tentou marcar e deu erro (failed/transient_error em
//      agendar/reagendar/cadastrar) ou a confirmação falsa foi bloqueada
//      (false_confirmation_blocked). Follow-up 3h depois.
//   B) 'pergunta_preco'   — perguntou valor/preço e sumiu sem marcar. Follow-up 4h.
// Se a ATENDENTE assumiu (manual_reply depois do evento), NÃO manda nada — só
// registra como skipped_human (não temos como saber se ela resolveu).
// UMA mensagem por caso (UNIQUE conversation_id+category), com re-checagens na
// hora do envio: já marcou? atendente entrou? conversa ativa? follow-up de outro
// sistema nas últimas 24h? ticket com humano? — qualquer um cancela/adia.
// Envio no MESMO contrato que funciona: channelId+whatsappId+externalKey+isClosed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const DETECT_LOOKBACK_H = 24;   // só olha eventos das últimas 24h (não ressuscita histórico antigo)
const STALE_SEND_H = 36;        // caso detectado há 36h+ sem conseguir enviar → não envia mais ("mais cedo" ficaria estranho)
const DELAY_FAIL_MIN = 180;     // falha técnica: follow-up 3h depois
const DELAY_PRICE_MIN = 240;    // pergunta de preço: follow-up 4h depois
const QUIET_HOUR_START = 20;    // sem mensagens 20h–7h (SP) — só a fase de ENVIO respeita
const QUIET_HOUR_END = 7;
const ACTIVE_CONV_MIN = 120;    // conversa com incoming < 2h → adia (não interromper)

function getNowSPHour(): number {
  const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false });
  return Number(fmt.format(new Date()));
}

// Variantes BR completas: com/sem 55 E com/sem o 9º dígito (CLAUDE.md: telefones
// chegam nas 3 formas). Sem isso, um booking gravado sem o 9º dígito escaparia do
// hasBookingSince e mandaríamos follow-up pra quem JÁ marcou (revisão 19/07).
function phoneVariants(raw: string): string[] {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return [];
  const local = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
  const locals = new Set<string>([local]);
  if (local.length === 11 && local[2] === "9") locals.add(local.slice(0, 2) + local.slice(3)); // tira o 9º
  if (local.length === 10) locals.add(local.slice(0, 2) + "9" + local.slice(2)); // insere o 9º
  const out = new Set<string>();
  for (const l of locals) {
    out.add(l);
    out.add(`55${l}`);
  }
  return [...out];
}

// ── Resolução de canal + credenciais (validado ao vivo 19/07) ────────────────
// avanceai_active_channel é um ARRAY JSON de canais e CADA canal tem credenciais
// PRÓPRIAS ({id, apiId, baseUrl, bearerToken, enabled}). Enviar com as credenciais
// "planas" da clínica deu ERR_API_REQUIRES_SESSION (sessão morta — provavelmente o
// canal 164, desligado de propósito). O caminho que FUNCIONA (webhook) usa as
// credenciais DO CANAL DO PACIENTE (raw_payload da mensagem recebida) e ignora
// canais enabled===false. Espelhamos isso aqui.
type ChannelCfg = { id?: unknown; apiId?: string; baseUrl?: string; bearerToken?: string; enabled?: boolean };
type SendCreds = { avanceai_base_url: string; avanceai_api_id: string; avanceai_bearer_token: string };

function parseEnabledChannels(raw: unknown): ChannelCfg[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed.filter((c: ChannelCfg) => c && c.apiId && c.baseUrl && c.enabled !== false);
    }
  } catch { /* ignore */ }
  return [];
}

// Canal em que o paciente realmente conversa: raw_payload das últimas mensagens
// incoming (mesmos campos que o webhook lê: ticket.whatsappId ?? msg.whatsappId ?? whatsappId).
async function getPatientChannelId(supabase: any, clinicId: string, phone: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("webhook_messages")
      .select("raw_payload")
      .eq("clinic_token_id", clinicId)
      .in("sender_phone", phoneVariants(phone))
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

// Prioridade (paridade com o webhook): canal do paciente com credenciais DELE →
// único canal habilitado → credenciais planas SÓ se não existe config por canal →
// multi-canal sem canal resolvido = null (não chuta canal errado).
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
      if (String(channels[i].id) === patientChan) {
        return { creds: fromCfg(channels[i]), channelId: patientChan };
      }
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
  return null; // multi-canal e não sabemos o canal do paciente: não enviar errado
}

function firstName(n: string | null | undefined): string {
  return String(n || "").trim().split(/\s+/)[0] || "";
}

async function sendWhats(
  creds: { avanceai_base_url: string; avanceai_api_id: string; avanceai_bearer_token: string },
  phone: string,
  msg: string,
  channelId: string | null,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const clean = phone.replace(/\D/g, "");
    const full = clean.length <= 11 ? `55${clean}` : clean;
    const payload: Record<string, unknown> = {
      number: full, body: msg, externalKey: crypto.randomUUID(), isClosed: false,
    };
    if (channelId) {
      payload.channelId = Number(channelId);
      payload.whatsappId = Number(channelId);
    }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${creds.avanceai_base_url}/v2/api/external/${creds.avanceai_api_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.avanceai_bearer_token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);
    const detail = res.ok ? "" : `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
    return { ok: res.ok, detail };
  } catch (e) {
    return { ok: false, detail: `exceção: ${(e as Error).message.slice(0, 120)}` };
  }
}

// Ticket open COM agente humano real (paridade com process-waitlist/avanceai.ts).
async function isTicketHumanActive(baseUrl: string, apiId: string, bearerToken: string, phone: string): Promise<boolean> {
  try {
    const clean = phone.replace(/\D/g, "");
    const full = clean.length <= 11 ? `55${clean}` : clean;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}/showticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ number: full }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const status = String(data?.status || "");
      const userId = Number(data?.userId ?? data?.user?.id ?? 0);
      const userName = String(data?.user?.name || "").trim();
      return status === "open" && (userId > 0 || userName.length > 0);
    }
  } catch (_) { /* fail-safe: não bloquear por falha do showticket */ }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const cronSecret = req.headers.get("x-cron-secret");
  const expectedSecret = Deno.env.get("CRON_SECRET");
  const hasApiKey = !!(req.headers.get("apikey") || req.headers.get("authorization"));
  if (!(cronSecret && expectedSecret && cronSecret === expectedSecret) && !hasApiKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const nowIso = new Date().toISOString();
  const lookback = new Date(Date.now() - DETECT_LOOKBACK_H * 3600_000).toISOString();
  let detected = 0, sent = 0, resolvedBooked = 0, errors = 0;
  const errorsDetail: string[] = [];

  // Um caso "resolveu sozinho" quando existe booking success do telefone depois do evento
  // (pelo chat: agendar/reagendar success; pelo widget: linha "Agendamento via widget").
  async function hasBookingSince(clinicId: string, phone: string, sinceIso: string, conversationId?: string | null): Promise<boolean> {
    const isBooking = (r: any) =>
      ["agendar", "reagendar"].includes(String(r.ai_intent || "")) ||
      String(r.message_text || "").startsWith("Agendamento via widget");
    const variants = phoneVariants(phone);
    if (variants.length > 0) {
      const { data } = await supabase
        .from("webhook_messages")
        .select("id, ai_intent, action_status, message_text")
        .eq("clinic_token_id", clinicId)
        .in("sender_phone", variants)
        .eq("action_status", "success")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(30);
      if ((data || []).some(isBooking)) return true;
    }
    // Fallback por CONVERSA (revisão 19/07): o booking via widget pode gravar o
    // telefone formatado/diferente do cadastro Amigo — mas resolve conversation_id.
    if (conversationId) {
      const { data } = await supabase
        .from("webhook_messages")
        .select("id, ai_intent, action_status, message_text")
        .eq("conversation_id", conversationId)
        .eq("action_status", "success")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(30);
      if ((data || []).some(isBooking)) return true;
    }
    return false;
  }

  // Devolve o NOME da atendente que assumiu (prefixo "*Nome*:" do manual_reply) —
  // pedido 21/07: a página Recuperação mostra "Atendente assumiu (Lidiane)".
  // null = nenhum humano respondeu desde sinceIso.
  async function manualReplyAuthorSince(conversationId: string | null, clinicId: string, phone: string, sinceIso: string): Promise<string | null> {
    let q = supabase
      .from("webhook_messages")
      .select("message_text")
      .eq("direction", "outgoing")
      .eq("ai_intent", "manual_reply")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(3);
    if (conversationId) q = q.eq("conversation_id", conversationId);
    else q = q.eq("clinic_token_id", clinicId).in("sender_phone", phoneVariants(phone));
    const { data } = await q;
    for (const r of (data || []) as Array<{ message_text: string }>) {
      const m = String(r.message_text || "").match(/^\*([^*\n]{2,40})\*:/);
      if (m && m[1].trim()) return m[1].trim();
    }
    return data && data.length > 0 ? "(atendente)" : null;
  }

  // ── 1) DETECÇÃO (roda sempre; não envia nada) ──────────────────────────────
  try {
    // A) Falha no agendamento — duas queries simples (sem or() aninhado do PostgREST)
    const { data: failsBlocked } = await supabase
      .from("webhook_messages")
      .select("conversation_id, sender_phone, sender_name, clinic_token_id, user_id, created_at, ai_intent, action_status, message_text")
      .eq("direction", "incoming")
      .gte("created_at", lookback)
      .eq("action_status", "false_confirmation_blocked")
      .order("created_at", { ascending: false })
      .limit(60);
    const { data: failsErr } = await supabase
      .from("webhook_messages")
      .select("conversation_id, sender_phone, sender_name, clinic_token_id, user_id, created_at, ai_intent, action_status, message_text")
      .eq("direction", "incoming")
      .gte("created_at", lookback)
      .in("action_status", ["failed", "transient_error"])
      .in("ai_intent", ["agendar", "reagendar", "cadastrar"])
      .order("created_at", { ascending: false })
      .limit(60);
    const fails = [...(failsBlocked || []), ...(failsErr || [])];
    // B) Pergunta de preço
    const { data: prices } = await supabase
      .from("webhook_messages")
      .select("conversation_id, sender_phone, sender_name, clinic_token_id, user_id, created_at, message_text")
      .eq("direction", "incoming")
      .gte("created_at", lookback)
      .or("message_text.ilike.%valor%,message_text.ilike.%preço%,message_text.ilike.%preco%,message_text.ilike.%quanto custa%,message_text.ilike.%quanto sai%,message_text.ilike.%quanto fica%")
      .order("created_at", { ascending: false })
      .limit(120);

    type Cand = { conversation_id: string | null; sender_phone: string; sender_name: string | null; clinic_token_id: string; user_id: string | null; created_at: string; message_text: string };
    const seen = new Set<string>();
    const candidates: Array<Cand & { category: string; delayMin: number }> = [];
    for (const r of (fails || []) as Cand[]) {
      const key = `${r.conversation_id}|falha_agendamento`;
      if (!r.conversation_id || !r.sender_phone || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...r, category: "falha_agendamento", delayMin: DELAY_FAIL_MIN });
    }
    for (const r of (prices || []) as Cand[]) {
      const key = `${r.conversation_id}|pergunta_preco`;
      if (!r.conversation_id || !r.sender_phone || seen.has(key)) continue;
      // se a MESMA conversa já é caso de falha, o caso de falha cobre (não duplicar pessoa)
      if (seen.has(`${r.conversation_id}|falha_agendamento`)) continue;
      seen.add(key);
      candidates.push({ ...r, category: "pergunta_preco", delayMin: DELAY_PRICE_MIN });
    }

    for (const c of candidates) {
      try {
        // Dedup por CONVERSA em QUALQUER categoria (revisão 19/07): uma jornada
        // frustrada rende no máximo UM follow-up — falha e preço na mesma conversa
        // não podem virar duas mensagens em dias diferentes.
        const { data: existing } = await supabase
          .from("lost_conversions")
          .select("id")
          .eq("conversation_id", c.conversation_id)
          .limit(1);
        if (existing && existing.length > 0) continue; // conversa já tem caso
        if (await hasBookingSince(c.clinic_token_id, c.sender_phone, c.created_at, c.conversation_id)) continue; // já marcou — nada a fazer
        const human = await manualReplyAuthorSince(c.conversation_id, c.clinic_token_id, c.sender_phone, c.created_at);
        const due = new Date(new Date(c.created_at).getTime() + c.delayMin * 60_000).toISOString();
        const { error: insErr } = await supabase.from("lost_conversions").insert({
          clinic_token_id: c.clinic_token_id,
          user_id: c.user_id,
          conversation_id: c.conversation_id,
          phone: c.sender_phone.replace(/\D/g, ""),
          patient_name: c.sender_name || null,
          category: c.category,
          evidence: String(c.message_text || "").slice(0, 200),
          detected_at: c.created_at,
          followup_due_at: due,
          status: human ? "skipped_human" : "pending", // atendente assumiu → só registra
          human_attendant: human || null, // QUEM assumiu (pedido 21/07)
        });
        if (insErr) {
          // corrida com outra execução (UNIQUE) é esperada; outros erros contam
          if (!String(insErr.message || "").toLowerCase().includes("duplicate")) {
            errors++;
            errorsDetail.push(`insert ${c.category}: ${insErr.message}`.slice(0, 160));
          }
          continue;
        }
        detected++;
      } catch (e) {
        errors++;
        errorsDetail.push(`detect: ${(e as Error).message}`.slice(0, 160));
      }
    }
  } catch (e) {
    errors++;
    errorsDetail.push(`detect fase: ${(e as Error).message}`.slice(0, 160));
  }

  // ── 2) RESOLUÇÃO: sent/pending que marcaram depois viram 'booked' ──────────
  try {
    const { data: open } = await supabase
      .from("lost_conversions")
      .select("id, clinic_token_id, conversation_id, phone, detected_at, status")
      .in("status", ["pending", "sent"])
      .limit(60);
    for (const r of (open || []) as any[]) {
      if (await hasBookingSince(r.clinic_token_id, r.phone, r.detected_at, r.conversation_id)) {
        await supabase.from("lost_conversions")
          .update({ status: "booked", updated_at: nowIso })
          .eq("id", r.id)
          .in("status", ["pending", "sent"]);
        resolvedBooked++;
      }
    }
  } catch (e) {
    errorsDetail.push(`resolve fase: ${(e as Error).message}`.slice(0, 160));
  }

  // ── 3) ENVIO (só fora da janela de silêncio) ───────────────────────────────
  const hourSP = getNowSPHour();
  if (hourSP >= QUIET_HOUR_START || hourSP < QUIET_HOUR_END) {
    return new Response(
      JSON.stringify({ detected, sent: 0, booked: resolvedBooked, skipped: "quiet_hours", errors, errors_detail: errorsDetail.slice(0, 5) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { data: dueRows } = await supabase
    .from("lost_conversions")
    .select("id, clinic_token_id, conversation_id, phone, patient_name, category, detected_at, clinic_tokens:clinic_token_id (avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, user_id, lost_recovery_enabled)")
    .eq("status", "pending")
    .lte("followup_due_at", nowIso)
    .order("followup_due_at", { ascending: true }) // FIFO: linha presa não afoga as demais
    .limit(25);

  const widgetUrlCache = new Map<string, string>();
  async function getWidgetUrl(clinicId: string): Promise<string> {
    if (widgetUrlCache.has(clinicId)) return widgetUrlCache.get(clinicId)!;
    let url = "";
    try {
      const { data } = await supabase
        .from("booking_widgets")
        .select("widget_key, widget_config")
        .eq("clinic_token_id", clinicId)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      const cfg = (data as any)?.widget_config as Record<string, unknown> | null;
      url = data
        ? cfg?.custom_url
          ? String(cfg.custom_url)
          : `https://schedulo-migo.lovable.app/agendar/${(data as any).widget_key}`
        : "";
    } catch { /* sem link, mensagem sai sem ele */ }
    widgetUrlCache.set(clinicId, url);
    return url;
  }

  for (const r of (dueRows || []) as any[]) {
    try {
      // Caso velho demais (36h+ sem conseguir enviar — adiamentos/janela/1º deploy):
      // "mais cedo tivemos um problema" não faz mais sentido; não envia. Roda ANTES
      // do check de credenciais pra linha sem creds não ocupar a janela pra sempre.
      if (new Date(r.detected_at).getTime() < Date.now() - STALE_SEND_H * 3600_000) {
        await supabase.from("lost_conversions").update({ status: "skipped_stale", updated_at: nowIso }).eq("id", r.id);
        continue;
      }
      const creds = r.clinic_tokens;
      if (!creds?.avanceai_base_url || !creds?.avanceai_api_id || !creds?.avanceai_bearer_token) continue;
      // Interruptor por clínica (revisão 19/07): desligar = UPDATE clinic_tokens
      // SET lost_recovery_enabled = false. Detecção continua (painel), envio para.
      if (creds.lost_recovery_enabled === false) continue;

      // Re-checagens frescas na hora do envio:
      if (await hasBookingSince(r.clinic_token_id, r.phone, r.detected_at, r.conversation_id)) {
        await supabase.from("lost_conversions").update({ status: "booked", updated_at: nowIso }).eq("id", r.id);
        resolvedBooked++;
        continue;
      }
      const _humanAuthor = await manualReplyAuthorSince(r.conversation_id, r.clinic_token_id, r.phone, r.detected_at);
      if (_humanAuthor) {
        await supabase.from("lost_conversions")
          .update({ status: "skipped_human", human_attendant: _humanAuthor, updated_at: nowIso })
          .eq("id", r.id);
        continue;
      }
      // conversa ativa (incoming < 2h) → adia pro próximo ciclo (não interromper)
      const activeCut = new Date(Date.now() - ACTIVE_CONV_MIN * 60_000).toISOString();
      const { data: recentIn } = await supabase
        .from("webhook_messages")
        .select("id")
        .eq("clinic_token_id", r.clinic_token_id)
        .in("sender_phone", phoneVariants(r.phone))
        .eq("direction", "incoming")
        .gte("created_at", activeCut)
        .limit(1);
      if (recentIn && recentIn.length > 0) continue;
      // outro follow-up (widget/recovery/este) nas últimas 24h → não empilhar mensagens
      const day = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data: recentFu } = await supabase
        .from("webhook_messages")
        .select("id")
        .eq("clinic_token_id", r.clinic_token_id)
        .in("sender_phone", phoneVariants(r.phone))
        .eq("direction", "outgoing")
        .in("ai_intent", ["widget_followup", "widget_followup_nudge", "widget_followup_thanks", "lost_conversion_followup", "waitlist_offer", "waitlist_nudge", "waitlist_expired"])
        .gte("created_at", day)
        .limit(1);
      if (recentFu && recentFu.length > 0) {
        await supabase.from("lost_conversions").update({ status: "skipped_recent", updated_at: nowIso }).eq("id", r.id);
        continue;
      }
      // credenciais/canal certos (ERR_API_REQUIRES_SESSION 19/07: as credenciais
      // planas apontam pra sessão morta; usar as do canal do paciente)
      const target = await resolveSendTarget(supabase, r.clinic_token_id, r.phone, creds);
      if (!target) {
        errorsDetail.push(`sem canal resolvível p/ ...${String(r.phone).slice(-4)} (multi-canal sem canal do paciente)`.slice(0, 160));
        await supabase.from("lost_conversions").update({ status: "send_failed", updated_at: nowIso }).eq("id", r.id);
        continue;
      }
      // ticket com atendente humano AGORA → adia
      if (await isTicketHumanActive(target.creds.avanceai_base_url, target.creds.avanceai_api_id, target.creds.avanceai_bearer_token, r.phone)) continue;

      // CLAIM (compare-and-swap): marca 'sent' só se ainda pending — execução
      // sobreposta pega 0 linhas e não duplica a mensagem.
      const { data: claim } = await supabase
        .from("lost_conversions")
        .update({ status: "sent", followup_sent_at: nowIso, updated_at: nowIso })
        .eq("id", r.id)
        .eq("status", "pending")
        .select("id");
      if (!claim || claim.length === 0) continue;

      const nome = firstName(r.patient_name);
      const widgetUrl = await getWidgetUrl(r.clinic_token_id);
      const linkLine = widgetUrl ? `\n\nSe preferir, é só clicar aqui para agendar online:\n${widgetUrl}` : "";
      // Sem instrução de responder/confirmar com a afirmativa (orphan-ACK a
      // silenciaria como confirmação externa) e sem datas/horários (anti-alucinação).
      const msg = r.category === "falha_agendamento"
        ? `Oi${nome ? `, ${nome}` : ""}! 👋 Mais cedo tivemos uma instabilidade aqui e não consegui concluir seu agendamento — me desculpe! 🙏 Já normalizou: quer que eu verifique os horários pra você agora? Me diga o médico ou o que você está sentindo.${linkLine}`
        : `Oi${nome ? `, ${nome}` : ""}! 👋 Vi que você perguntou sobre valores mais cedo. Posso ajudar em mais alguma coisa? Se quiser marcar uma consulta, me diga o médico ou o que você está sentindo que eu já verifico os horários.${linkLine}`;

      const send = await sendWhats(target.creds, r.phone, msg, target.channelId);
      if (!send.ok) {
        errors++;
        errorsDetail.push(`envio ${r.category} ...${String(r.phone).slice(-4)} [${send.detail}]`.slice(0, 160));
        await supabase.from("lost_conversions")
          .update({ status: "send_failed", updated_at: nowIso })
          .eq("id", r.id);
        continue;
      }
      await supabase.from("webhook_messages").insert({
        clinic_token_id: r.clinic_token_id, user_id: creds.user_id || null,
        sender_phone: r.phone, sender_name: r.patient_name || null,
        message_text: msg, direction: "outgoing",
        ai_intent: "lost_conversion_followup", action_status: "success",
        conversation_id: r.conversation_id,
      });
      sent++;
    } catch (e) {
      errors++;
      errorsDetail.push(`envio: ${(e as Error).message}`.slice(0, 160));
    }
  }

  return new Response(
    JSON.stringify({ detected, sent, booked: resolvedBooked, errors, errors_detail: errorsDetail.slice(0, 5) }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
