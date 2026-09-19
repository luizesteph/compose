// guards.ts — Modularizacao M4 (04/07).
// As PROTECOES CLINICAS do bot vivem aqui: sanitizacao de resposta (JSON/
// [object Object]/repeticao patologica -> FALLBACK), guard anti-alucinacao de
// horarios (tokens de agenda so saem com respaldo verificado), pre-book guard
// (fim de semana / fora do expediente) e dedup de respostas quase-identicas.
// Extraido byte a byte do index.ts — comportamento identico. Sem @ts-nocheck.
import { stripAccents, PROMESSA_DE_HUMANO_RE } from "./helpers.ts";
import { FRASE_ENCERRAMENTO, pertoDoEncerramento, expedienteAberto, fraseForaDoExpediente } from "../_shared/atendimento.ts";

export function normalizeForSimilarity(s: string): string {
  return stripAccents(String(s || "").toLowerCase())
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

export function nearDuplicate(a: string, b: string): boolean {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (Math.abs(na.length - nb.length) > Math.max(na.length, nb.length) * 0.25) return false;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return shorter / longer >= 0.8;
  }
  // Token-level Jaccard for short replies (~< 200 chars)
  if (Math.max(na.length, nb.length) > 400) return false;
  const ta = new Set(na.split(" ").filter((t) => t.length > 2));
  const tb = new Set(nb.split(" ").filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.85;
}

export async function isDuplicateReply(
  supabase: any,
  conversationId: string | null | undefined,
  text: string,
  windowSec = 300,
): Promise<{ duplicate: boolean; matchedText?: string; matchedAgeSec?: number }> {
  if (!supabase || !conversationId || !text) return { duplicate: false };
  try {
    const cutoff = new Date(Date.now() - windowSec * 1000).toISOString();
    const { data } = await supabase
      .from("webhook_messages")
      .select("message_text, created_at")
      .eq("conversation_id", conversationId)
      .eq("direction", "outgoing")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(3);
    for (const row of data || []) {
      const prev = String((row as any).message_text || "");
      if (nearDuplicate(prev, text)) {
        // A IDADE separa dois casos que exigem respostas opostas (caso Camila
        // 06/08): duas mensagens processadas em CORRIDA (segundos de diferença —
        // suprimir é certo) e o paciente que escreveu de novo um minuto depois e
        // recebeu a mesma frase (aí suprimir deixa ele no VÁCUO, sem resposta
        // nenhuma). Quem chama decide; aqui só entregamos o dado.
        const t = Date.parse(String((row as any).created_at || ""));
        const idade = Number.isFinite(t) ? Math.round((Date.now() - t) / 1000) : undefined;
        return { duplicate: true, matchedText: prev, matchedAgeSec: idade };
      }
    }
  } catch (e) {
    console.warn(`[isDuplicateReply] error: ${(e as Error).message}`);
  }
  return { duplicate: false };
}

export function sanitizeReply(text: unknown): { valid: boolean; cleaned: string } {
  const FALLBACK = "Desculpe, tive uma dificuldade técnica. Vou transferir você para nossa equipe de atendimento. 🙏";

  // Not a string at all
  if (typeof text !== "string") {
    console.log(`[sanitizeReply] ❌ Not a string: ${typeof text}`);
    return { valid: false, cleaned: FALLBACK };
  }

  let t = text.trim();

  // Empty or too short
  if (t.length < 5) {
    console.log(`[sanitizeReply] ❌ Too short (${t.length} chars)`);
    return { valid: false, cleaned: FALLBACK };
  }

  // === P5: REPETIÇÃO PATOLÓGICA ===
  // Caso Conv. 38 (18/06): LLM gerou centenas de repeticoes de "gợi ý"
  // (vietnamita = "sugestao"). Falha no token de parada do Gemini. Resposta
  // virou texto sem sentido pro paciente, gerou ruido enorme.
  //
  // Heuristica: pega palavras com >= 3 chars (e nao "and"/"the" comuns) e
  // conta ocorrencias. Se a palavra mais frequente aparece > 15x E representa
  // > 30% do texto, considera patologico.
  // Limiar conservador pra nao bloquear listas legitimas tipo "08:00, 08:20,
  // 08:40, 09:00, 09:20" (slots tem numeros, nao palavras repetidas).
  try {
    const words = t
      .toLowerCase()
      .replace(/[\d:.\-,;!?(){}\[\]"'`*_]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    if (words.length > 20) {
      const counts = new Map<string, number>();
      for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
      let topWord = "";
      let topCount = 0;
      for (const [w, c] of counts) {
        if (c > topCount) { topWord = w; topCount = c; }
      }
      const ratio = topCount / words.length;
      if (topCount >= 15 && ratio > 0.30) {
        console.log(
          `[sanitizeReply] ❌ Pathological repetition: "${topWord}" x${topCount} (${Math.round(ratio * 100)}% of ${words.length} words)`,
        );
        return { valid: false, cleaned: FALLBACK };
      }
    }
    // Variacao do mesmo problema: substring CURTA (3-20 chars) que se repete
    // muitas vezes seguidas. Pega casos como "ababab..." ou "gợi ý gợi ý gợi ý".
    const seqRepeatMatch = t.match(/(\S.{2,19}?\S)(?:\s*\1){9,}/);
    if (seqRepeatMatch) {
      console.log(
        `[sanitizeReply] ❌ Repeated substring: "${seqRepeatMatch[1].slice(0, 30)}" 10+ times in sequence`,
      );
      return { valid: false, cleaned: FALLBACK };
    }
  } catch (e) {
    console.log(`[sanitizeReply] repetition check error (non-blocking): ${(e as Error).message}`);
  }

  // Contains [object Object] or raw JSON artifacts
  if (t.includes("[object Object]") || t.includes("[object object]")) {
    console.log(`[sanitizeReply] ❌ Contains [object Object]`);
    return { valid: false, cleaned: FALLBACK };
  }

  // Entire message is JSON (starts with { or [)
  if (/^\s*[\[{]/.test(t) && /[\]}]\s*$/.test(t)) {
    try {
      JSON.parse(t);
      console.log(`[sanitizeReply] ❌ Entire message is valid JSON — not human-readable`);
      return { valid: false, cleaned: FALLBACK };
    } catch {
      /* not valid JSON, probably OK */
    }
  }

  // Too long (> 3000 chars) — truncate
  if (t.length > 3000) {
    console.log(`[sanitizeReply] ⚠️ Truncating from ${t.length} to 3000 chars`);
    t = t.substring(0, 2997) + "...";
  }

  // Remove stray unrendered curly/square brackets patterns like {key: value} or {"key":"value"}
  const jsonSnippetPattern = /\{[^}]*"[^"]*"\s*:\s*[^}]*\}/g;
  if (jsonSnippetPattern.test(t)) {
    console.log(`[sanitizeReply] ⚠️ Removing embedded JSON snippets`);
    t = t
      .replace(jsonSnippetPattern, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (t.length < 5) return { valid: false, cleaned: FALLBACK };
  }

  // Detect leaked technical terms that should never reach the patient.
  // NOTA: códigos HTTP nus (404/500/502/503) FORAM REMOVIDOS daqui — como substring
  // solta, "500" barrava o VALOR da consulta (R$ 500!) e a Julia respondia
  // "dificuldade técnica" a TODA pergunta de valor (caso Nara 18/07 + os
  // "valores → dificuldade técnica" dos relatórios). Passaram para o check
  // contextual httpErrorLeak abaixo, que só dispara em contexto de erro.
  const technicalTerms = [
    "error",
    "undefined",
    "exception",
    "Route Not Found",
    "lockPresentedSlots",
    "stack trace",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "TypeError",
    "ReferenceError",
    "SyntaxError",
    "fetch failed",
    "network error",
    "status code",
  ];
  const tLower = t.toLowerCase();
  for (const term of technicalTerms) {
    if (tLower.includes(term.toLowerCase())) {
      console.log(`[sanitizeReply] ❌ Technical term leaked: "${term}"`);
      return { valid: false, cleaned: FALLBACK };
    }
  }

  // Códigos HTTP (404/500/502/503/504) só contam como vazamento em CONTEXTO DE ERRO —
  // precedidos de "erro/status/http/gateway…" OU seguidos de "Bad Gateway/Not Found…".
  // Assim "R$ 500", "500 reais", "consulta 500,00 à vista" passam normalmente.
  const httpErrorLeak =
    /\b(?:erro|error|status|http|c[oó]digo|gateway|response|falha|retornou|devolveu)\W{0,4}\b(?:404|500|502|503|504)\b/i.test(t) ||
    /\b(?:404|500|502|503|504)\b\s*[-—:]?\s*(?:bad\s*gateway|internal\s*server|not\s*found|service\s*unavailable|gateway\s*time?out|server\s*error)/i.test(t);
  if (httpErrorLeak) {
    console.log(`[sanitizeReply] ❌ HTTP error code leaked (contexto de erro)`);
    return { valid: false, cleaned: FALLBACK };
  }

  return { valid: true, cleaned: t };
}

export function containsScheduleTerms(text: string): { has: boolean; tokens: string[] } {
  const tokens: string[] = [];
  if (!text) return { has: false, tokens };
  // HH:MM (08:00, 14:30) — most common slot format
  const hhmm = text.match(/\b\d{1,2}:\d{2}\b/g);
  if (hhmm) tokens.push(...hhmm);
  // 8h, 14h30, 14h
  const hForm = text.match(/\b\d{1,2}h(?:\d{2})?\b/gi);
  if (hForm) tokens.push(...hForm);
  // explicit date references (DD/MM, dia 28/04)
  const ddmm = text.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g);
  if (ddmm) tokens.push(...ddmm);
  return { has: tokens.length > 0, tokens };
}

// Um token de agenda da resposta ECOA a mensagem do paciente? (caso Tathi 10/07)
// Datas expandem para o dia isolado ("22/07" casa "dias 22, 23 e 24"); horas
// casam em formatos equivalentes (14:30 = 14h30 = 14h), mas NUNCA por hora nua
// (para uma hora só ser eco quando o paciente realmente a digitou).
export function scheduleTokenEchoedInText(token: string, patientText: string): boolean {
  const pm = stripAccents(String(patientText || "").toLowerCase());
  if (!pm) return false;
  const ddmm = token.match(/^(\d{1,2})\/(\d{1,2})/);
  if (ddmm) {
    const d = parseInt(ddmm[1], 10);
    const m = parseInt(ddmm[2], 10);
    if (pm.includes(`${d}/${m}`) || pm.includes(token.toLowerCase())) return true;
    return new RegExp(`\\b${d}\\b`).test(pm); // dia isolado
  }
  const hhmm = token.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10);
    const mm = hhmm[2];
    const forms = [`${h}:${mm}`, `${h}h${mm}`];
    if (mm === "00") forms.push(`${h}h`);
    return forms.some((f) => pm.includes(f));
  }
  const hForm = token.match(/^(\d{1,2})h(\d{2})?$/i);
  if (hForm) {
    const h = parseInt(hForm[1], 10);
    const mm = hForm[2] || "";
    const forms = [`${h}h${mm}`, `${h}h`, mm ? `${h}:${mm}` : `${h}:00`];
    return forms.some((f) => pm.includes(f));
  }
  return false;
}

// Horas citadas num texto, normalizadas para "HH:MM". Aceita o que aparece dos dois
// lados: "10:40" e "10:40:00" (JSON da API), "10h40", "10h" e "às 10 horas" (texto da
// Julia). Usado para conferir se o horário que a Julia escreveu EXISTE no dado da API
// (caso Renan 31/07 — ela disse 07:40 para uma consulta de 10:40).
export function extrairHoras(texto: string): string[] {
  const t = String(texto || "");
  const achadas = new Set<string>();
  // HH:MM (pega também o HH:MM de "HH:MM:SS")
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    const h = Number(m[1]);
    if (h <= 23) achadas.add(`${String(h).padStart(2, "0")}:${m[2]}`);
  }
  // HHhMM e HHh
  for (const m of t.matchAll(/\b(\d{1,2})\s*h(?:oras?)?\s*(\d{2})?\b/gi)) {
    const h = Number(m[1]);
    if (h <= 23) achadas.add(`${String(h).padStart(2, "0")}:${m[2] ?? "00"}`);
  }
  return [...achadas];
}

export function validateScheduleTerms(
  reply: string,
  ctx: {
    intent: string;
    actionStatus: string;
    verifiedSchedule: boolean;
    bypassAiRewrite: boolean;
    actionErrorText: string;
    actionResponseText: string;
    patientMessageText?: string;
  },
): { allowed: boolean; reason?: string; cleaned: string; tokens: string[] } {
  const FALLBACK_NO_SCHEDULE =
    "Vou conferir os horários reais da agenda antes de te passar uma opção, para não te informar nada incorreto. Pode me confirmar o médico e a melhor data ou período pra você?";

  // Bypass paths that send literal pre-built text (widget link, masked CPF, real slot lists)
  if (ctx.bypassAiRewrite) return { allowed: true, cleaned: reply, tokens: [] };

  const det = containsScheduleTerms(reply);
  if (!det.has) return { allowed: true, cleaned: reply, tokens: [] };

  // Real successful API actions are allowed to mention the booked time/date
  const isRealSuccess = ctx.actionStatus === "success";
  if (isRealSuccess) {
    // CASO RENAN (31/07): o `consultar` achou a consulta (status=success) e o guard
    // liberava QUALQUER horário sem conferir. O paciente estava marcado às 10:40 e a
    // Julia afirmou "às 07:40" — três horas antes, e num horário que NEM EXISTE (a
    // clínica abre às 08:00). O modelo tratou o horário da API como se fosse UTC e
    // converteu. Ele repetiu o erro na mensagem seguinte, e o paciente quase foi no
    // dia errado. "Sucesso da ação" prova que a consulta EXISTE — não prova que o
    // horário que o modelo escreveu é o horário dela.
    //
    // Regra: quando a resposta da ação traz agendamento (tem start_date), TODO
    // horário citado na resposta precisa existir nesse dado. Escopo estreito de
    // propósito — só horas, e só quando há agendamento no payload:
    //   • datas continuam livres (a API manda "2026-08-05", a Julia escreve "05/08");
    //   • texto sem agendamento (ex.: horário de funcionamento) não passa por aqui.
    const temAgendamento = /"?start_date"?\s*[:=]/i.test(ctx.actionResponseText || "");
    if (temAgendamento) {
      const horasDitas = extrairHoras(reply);
      if (horasDitas.length > 0) {
        const horasReais = new Set(extrairHoras(ctx.actionResponseText || ""));
        const inventadas = horasDitas.filter((h) => !horasReais.has(h));
        if (inventadas.length > 0) {
          return {
            allowed: false,
            reason: `horario_nao_confere_com_api:${inventadas.join(",")}|api:${[...horasReais].join(",")}`,
            cleaned: FALLBACK_NO_SCHEDULE,
            tokens: det.tokens,
          };
        }
      }
    }
    return { allowed: true, cleaned: reply, tokens: det.tokens };
  }

  // Action explicitly verified slots from live calendar
  if (ctx.verifiedSchedule) {
    // CASO CAIO MUNIZ (11/08). `verifiedSchedule` era passe livre para QUALQUER
    // horário. A ação tinha verificado apenas a DATA ("as datas disponíveis
    // começam a partir do dia 22/08") e o modelo completou o resto de cabeça:
    // "os primeiros horários disponíveis (...) são às 08:30, 09:10 e 10:20" —
    // num SÁBADO, dia em que a clínica não abre. O paciente escolheu 09:10 e
    // ouviu de volta que aquele dia não tinha horário nenhum. Foi daí que veio
    // toda a sequência de contradições da conversa.
    //
    // A ação ter verificado a data não prova nada sobre a HORA. Escopo estreito,
    // igual ao do caso Renan: DATAS continuam livres (a API manda "2026-08-22" e
    // a Julia escreve "22/08"); toda HORA citada precisa existir no texto
    // verificado da ação — ou ter saído da boca do próprio paciente.
    const horasDitas = extrairHoras(reply);
    if (horasDitas.length > 0) {
      const horasComRespaldo = new Set([
        ...extrairHoras(`${ctx.actionErrorText}\n${ctx.actionResponseText}`),
        ...extrairHoras(ctx.patientMessageText || ""),
      ]);
      const inventadas = horasDitas.filter((h) => !horasComRespaldo.has(h));
      if (inventadas.length > 0) {
        return {
          allowed: false,
          reason: `hora_sem_respaldo_apesar_de_verifiedSchedule:${inventadas.join(",")}|respaldadas:${[...horasComRespaldo].join(",")}`,
          cleaned: fallbackSemAgenda(ctx.patientMessageText),
          tokens: det.tokens,
        };
      }
    }
    return { allowed: true, cleaned: reply, tokens: det.tokens };
  }

  // Otherwise: every schedule token MUST appear literally in the action's
  // verified text (error/response from executeAction). If not, treat as hallucination.
  const haystack = `${ctx.actionErrorText}\n${ctx.actionResponseText}`.toLowerCase();
  const allTokensVerified = det.tokens.every((t) => haystack.includes(t.toLowerCase()));
  if (allTokensVerified) {
    return { allowed: true, cleaned: reply, tokens: det.tokens };
  }

  // Relatorio 06/07 conversas 91/92: "na sexta a clinica funciona?" — a resposta
  // fala do HORARIO DE FUNCIONAMENTO (dado estatico do clinic_info, nao agenda
  // medica) e era bloqueada como alucinacao, gerando o fallback "vou conferir os
  // horarios reais" fora de contexto. Bypass ESTREITO: a resposta trata de
  // funcionamento E nao oferece consulta/medico nem lista de slots (3+ horarios).
  const _funcionamento =
    /\b(funciona\w*|funcionamento|expediente|atendemos|abrimos|abre|fecham?o?s?|aberta?o?s?)\b/i.test(reply);
  const _ofereceAgenda =
    /\b(consulta|agendar|marcar|remarcar|reagendar|vaga|encaixe|dispon[ií]ve)\b/i.test(reply) ||
    /\bdr[a]?\.?\s+[a-zà-ú]/i.test(reply) ||
    /\d{1,2}:\d{2}[\s\S]*\d{1,2}:\d{2}[\s\S]*\d{1,2}:\d{2}/.test(reply);
  if (_funcionamento && !_ofereceAgenda) {
    return { allowed: true, cleaned: reply, tokens: det.tokens };
  }

  // ECHO BYPASS (caso Tathi 10/07): a resposta apenas ECOA as datas/horas que o
  // PACIENTE pediu ("vou verificar os dias 22, 23 e 24") SEM afirmar
  // disponibilidade. Ecoar o que o paciente digitou não é alucinação —
  // alucinação é ASSERIR que existe vaga/horário. Bypass ESTREITO: (1) TODOS os
  // tokens estão na mensagem do paciente E (2) a resposta não afirma
  // disponibilidade/reserva nem oferece uma hora específica ("às 14h").
  if (ctx.patientMessageText) {
    const _allEchoed = det.tokens.every((t) => scheduleTokenEchoedInText(t, ctx.patientMessageText!));
    const _assertsAvail =
      /\b(dispon[ií]ve\w*|livres?|vagas?|encaixe|temos|abert[oa]s?)\b/i.test(reply) ||
      /\b(reserv\w+|agend(ei|ado|amos|ou|ada)|marqu(ei|ado|ou|ada)|confirm(ei|ado|ou|ada)|garant\w+)\b/i.test(reply) ||
      /\b[aà]s\s+\d{1,2}\s*[:h]/i.test(reply);
    if (_allEchoed && !_assertsAvail) {
      return { allowed: true, reason: "echo_of_patient_dates", cleaned: reply, tokens: det.tokens };
    }
  }

  // Unknown / unknown_intent: never allow schedule terms
  // needs_info / failed without verified schedule: block
  return {
    allowed: false,
    reason: `unverified_schedule_terms intent=${ctx.intent} status=${ctx.actionStatus} tokens=[${det.tokens.join(",")}]`,
    cleaned: fallbackSemAgenda(ctx.patientMessageText),
    tokens: det.tokens,
  };
}

// CASO RENAN (31/07): o paciente escreveu "Doutor Guilherme Fonseca, no período da
// tarde" e a Julia respondeu "Pode me confirmar o médico e a melhor data ou período
// pra você?" — pedindo EXATAMENTE o que ele acabou de dizer. Ele não respondeu de
// novo; a conversa morreu e o breaker transferiu.
//
// O texto agora pergunta só o que FALTA. Quando já temos médico e data/período, faz
// uma pergunta que o paciente consegue responder com "sim" — e que RE-DISPARA o
// fluxo. De propósito NÃO promete "já te retorno": nada no sistema volta sozinho, e
// promessa não cumprida é o erro que mais custou caro aqui.
export function fallbackSemAgenda(mensagemDoPaciente?: string): string {
  const t = String(mensagemDoPaciente || "");
  const temMedico = /\b(dr\.?|dra\.?|doutor|doutora)\s*[a-zà-ú]/i.test(t);
  // (?![\p{L}]) em vez de \b no fim: "manhã", "amanhã" e "terça" terminam em letra
  // acentuada e o \b do JS é ASCII — com \b, "amanhã" NÃO casava (mesmo tropeço do
  // "você" no FalseConfirmGuard).
  const temPeriodo = /\b(manh[aã]|tarde|noite)(?![\p{L}])/iu.test(t);
  const temData =
    /\b\d{1,2}\s*[\/-]\s*\d{1,2}\b/.test(t) ||
    /\b(hoje|amanh[aã]|depois\s+de\s+amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(?![\p{L}])/iu.test(t);

  const base = "Vou conferir os horários reais da agenda antes de te passar uma opção, para não te informar nada incorreto.";
  if (temMedico && (temPeriodo || temData)) {
    return `${base} Quer que eu veja as próximas datas disponíveis?`;
  }
  const falta: string[] = [];
  if (!temMedico) falta.push("o médico");
  if (!temPeriodo && !temData) falta.push("a melhor data ou período pra você");
  return `${base} Pode me confirmar ${falta.join(" e ")}?`;
}

// ─────────────────────────────────────────────────────────────────────────────
// O TEXTO DA PRÓPRIA AÇÃO VALE MAIS QUE O TEXTO GENÉRICO (19/09)
// ─────────────────────────────────────────────────────────────────────────────
// Quando o guard barra a resposta do modelo, o que saía era o `fallbackSemAgenda`
// ("Vou conferir os horários reais da agenda... me confirma o médico e a data?").
// Só que em 19 dos 28 bloqueios de 04 a 18/09 a ação JÁ tinha uma pergunta pronta
// para o paciente — "Encontrei sua consulta com X no dia 16/09. É essa que deseja
// reagendar?", a lista real de horários, "preciso do seu CPF" — e o modelo
// reescrevia acrescentando a hora que o paciente pediu. O texto da ação vem da
// API, não do modelo: é ele que deve sair. Só `needs_info` tem texto voltado ao
// paciente; `needs_registration` descreve o caso em terceira pessoa ("O paciente
// solicitou infiltração mas não está cadastrado") e fica de fora.
export function textoDaAcaoParaOPaciente(
  acao: { status?: unknown; response?: unknown; error?: unknown } | null | undefined,
): string {
  if (!acao || String(acao.status || "") !== "needs_info") return "";
  for (const bruto of [acao.response, acao.error]) {
    const t = String(bruto || "").trim();
    if (!t) continue;
    if (t.startsWith("[")) continue;                                  // "[PreBookGuard] ..." é marcador interno
    if (/^o\s+paciente\b/i.test(t)) continue;                         // fala DO paciente, não COM ele
    if (/\{"|\[object Object\]|\bundefined\b|\bnull\b/.test(t)) continue;
    return t;
  }
  return "";
}

export function validateBookingDate(
  startDate: string, // canonical "YYYY-MM-DD HH:mm"
  opts?: { businessOpenHour?: number; businessCloseHour?: number },
): { allowed: boolean; reason?: string; patientMessage?: string } {
  const openH = opts?.businessOpenHour ?? 8;
  const closeH = opts?.businessCloseHour ?? 18;
  if (!startDate || !/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/.test(startDate)) {
    return { allowed: true }; // can't parse — let downstream handle it
  }
  const [datePart, timePart] = startDate.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  // Construct in São Paulo TZ (Brazil): use UTC date constructor to avoid local TZ skew
  // Day-of-week: 0=Sunday, 6=Saturday
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  if (dow === 0 || dow === 6) {
    return {
      allowed: false,
      reason: "blocked_weekend_booking",
      patientMessage:
        "Não fazemos atendimento aos sábados e domingos. Pode me passar uma data em dia útil (segunda a sexta) que eu confiro a agenda real pra você?",
    };
  }
  if (hh < openH || hh >= closeH) {
    return {
      allowed: false,
      reason: `blocked_outside_business_hours (${hh}h fora de ${openH}h-${closeH}h)`,
      patientMessage:
        `Nosso horário de atendimento é das ${openH}h às ${closeH}h. Pode me sugerir um horário dentro dessa faixa que eu confiro a agenda?`,
    };
  }
  return { allowed: true };
}

// As regras de atendimento humano moraram aqui por um tempo; foram para
// _shared/atendimento.ts quando o cron human-transfer-timeout passou a precisar
// das mesmas funções. Re-exportadas para não quebrar quem já importava daqui.
export { exigeRespostaDaAtendente, prazoDeRespostaEmMinutos, pertoDoEncerramento, FRASE_ENCERRAMENTO } from "../_shared/atendimento.ts";

// ─────────────────────────────────────────────────────────────────────────────
// COMBUSTÍVEL DO DISJUNTOR: só conta o que foi FALHA DE VERDADE (auditoria 01/09)
// ─────────────────────────────────────────────────────────────────────────────
// O disjuntor #1 conta toda saída rotulada 'unknown' (3 em 10min → transfere).
// Mas o classificador rotula 'unknown' tanto o que ele não entendeu quanto a
// resposta contextual perfeita a uma pergunta que a própria Julia fez. Resultado
// medido: 5 disparos em 7 dias, 5 falsos positivos.
//
// O caso Yvo (31/08), linha por linha — as cinco respostas antes do disparo:
//   15:40  "Boa tarde, Yvo! 👋 Eu sou a Julia..."
//   15:41  "Aqui na CBT Ortopedia somos uma clínica especializada..."
//   15:42  "De nada! Se precisar de qualquer suporte..."
//   15:43  "Entendo perfeitamente, Yvo! Uma pena não termos encaixe para amanhã..."
//   15:44  "Por nada, Yvo! Se precisar de algo, estamos por aqui."
//   15:44  DISPAROU — e engoliu "Se houver desistência amanhã, me chame, quem sabe?"
// Cinco respostas boas viraram combustível, e o pedido de lista de espera morreu.
//
// A separação é o TEXTO que saiu: se a Julia respondeu de verdade, não houve
// falha para acumular. Só conta quando ela disse, de uma forma ou de outra, que
// não conseguiu ajudar.
//
// A mensagem do PRÓPRIO disjuntor entra na lista de propósito: ela é persistida
// como 'unknown' para manter o contador armado e evitar o dente-de-serra do caso
// Alessandra (176 mensagens). Tirá-la daqui desarmaria essa trava em silêncio.
const FALHA_DE_VERDADE_RE = [
  /dificuldade\s+pra\s+te\s+ajudar/i,        // a mensagem do próprio disjuntor
  /dificuldade\s+t[ée]cnica/i,               // FALLBACK do sanitizeReply e do helpers
  /n[ãa]o\s+(consegui|entendi)\s+(entender|te\s+ajudar|o\s+que)/i,
  /pode\s+repetir\s+(por\s+favor|de\s+outro\s+jeito)/i,
  /n[ãa]o\s+tenho\s+essa\s+informa[çc][ãa]o/i,
];

/**
 * Esta resposta da Julia é uma FALHA (combustível do disjuntor) ou foi uma
 * resposta de verdade que só ficou mal rotulada?
 *
 * `true`  → a Julia disse que não conseguiu ajudar. Conta.
 * `false` → respondeu com conteúdo. Não conta, por mais que o rótulo diga unknown.
 */
export function respostaFoiFalha(texto: unknown): boolean {
  const t = String(texto || "");
  if (!t.trim()) return true; // saída vazia é falha, e das piores
  return FALHA_DE_VERDADE_RE.some((re) => re.test(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// LINK DO GOOGLE MAPS SEMPRE O CADASTRADO (15/09)
// ─────────────────────────────────────────────────────────────────────────────
// A resposta ao paciente passou para o GPT-5.6 Luna. No teste de 13/09, com o
// prompt no tamanho real da produção, ele copiou o link do mapa com o ÚLTIMO
// CARACTERE a menos em 7 de 12 respostas: `…JW5b7` virou `…JW5b` — link quebrado
// para quem está tentando chegar à clínica. O link chegava inteiro na entrada;
// o erro é de cópia do modelo, e só aparece com contexto grande (com prompt curto
// acertou 6 de 6).
//
// Não dá para pedir ao modelo que copie direito. Dá para não depender dele: todo
// link curto do Maps que aparecer na resposta vira o link cadastrado da clínica.
// A clínica tem um endereço só, então não há link "certo" diferente do oficial.

/**
 * Troca qualquer link curto do Google Maps no texto pelo link oficial da clínica.
 * Sem link oficial válido, devolve o texto intacto.
 */
export function corrigirLinkDoMapa(texto: string, linkOficial?: string | null): string {
  if (typeof texto !== "string" || !texto) return texto;
  const oficial = String(linkOficial || "").trim();
  if (!/^https?:\/\/\S+$/.test(oficial)) return texto;
  return texto.replace(
    /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9_-]*/g,
    (achado) => (achado === oficial ? achado : oficial),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A PARTIR DAS 17H30, A PROMESSA DE ATENDENTE VIRA A FRASE DO DONO (15/09)
// ─────────────────────────────────────────────────────────────────────────────
// Ver FRASE_ENCERRAMENTO em _shared/atendimento.ts. Aqui é o texto: o TRECHO que
// promete gente ("vou te transferir", "já passei para a Lidiane", "em instantes
// nossa equipe já vai te atender") vira a frase do dono, e o "Só um instante!"
// que vinha junto sai — ele só existia para a promessa.
//
// Troca o trecho, não a mensagem: o que vem ANTES na mesma frase fica ("Como se
// trata de infiltração, vou tentar passar para a Lidiane..."), e o que vem depois
// de um travessão também ("... antes do encerramento do atendimento — se você
// quiser remarcar, é só me dizer"). Se a promessa citava uma atendente, o nome
// fica: quem cuida de infiltração e cirurgia é informação útil para o paciente.
//
// Ensaiado nas 115 mensagens reais da Julia nessa janela em 21 dias. A primeira
// versão quebrava "Dr. Hugo" como fim de frase ("...do atendimento. Hugo para o
// dia 18/09.") e deixava passar "ela vai te responder por aqui" logo depois da
// troca — os dois viraram teste.
//
// Não mexe em: oferecimento ("se preferir falar com um atendente, é só me pedir"
// não é promessa); frase sem gente do outro lado ("vou te passar os horários",
// "já vou transferir sua consulta para o dia 14"); mensagem que já diz quando a
// equipe responde ("encerra às", "equipe volta em", "amanhã de manhã").
//
// FORA DO EXPEDIENTE (15/09, caso Cristiano): da noite até 7h30 e no fim de
// semana, a mesma troca usa fraseForaDoExpediente — "Vou deixar seu caso com a
// nossa equipe — o atendimento de hoje já encerrou, então te respondem amanhã de
// manhã." Durante o expediente (7h30–17h30) nada muda.

// "ela" só conta como gente quando vem com verbo de promessa ("já estou
// encaminhando sua mensagem para ela", Fabio 08/09); "dela" não é "ela".
const ALVO_HUMANO_RE = /(atendente|equipe|colega|recep[çc][ãa]o|pessoa|humano|algu[ée]m|lidiane|v[âa]nia|glaucia|la[ií]z|mardila|(?<![\p{L}])elas?(?![\p{L}]))/iu;
// Promessa de resposta que não começa por "eu": "em instantes nossa equipe já vai
// te atender", "ela vai te responder por aqui". PROMESSA_DE_HUMANO_RE não cobre.
const PROMESSA_DE_RESPOSTA_RE = /em\s+instantes|j[áa]\s+j[áa]|(equipe|atendentes?|colegas?|ela|elas)\s+(j[áa]\s+)?(vai|v[ãa]o|ir[áa])\s+(te\s+)?(atender|responder|retornar|continuar)(?![\p{L}])|(equipe|atendentes?|colegas?|ela|elas)\s+(j[áa]\s+)?(entra|entram|vai\s+entrar|v[ãa]o\s+entrar|entrar[áa])\s+em\s+contato/iu;
const SO_ESPERA_RE = /^[\s\p{Extended_Pictographic}️]*(s[óo]\s+)?(aguardar\s+)?(um|uns)\s+(instante|momento|minutinho)s?(,?\s*por\s+favor)?[\s!.…\p{Extended_Pictographic}️]*$/iu;
// Fim de frase — menos depois de abreviação ("Dr. Hugo", "Sra. Keiko").
const FIM_DE_FRASE_RE = /((?<=[.!?…])(?<!\b(?:Dr|Dra|Sr|Sra|Srta|Prof|Profa|Av)\.)\s+)/u;
const NOMES_NA_PROMESSA: Array<[string, string]> = [
  ["lidiane", "Lidiane"], ["vania", "Vânia"], ["glaucia", "Glaucia"], ["laiz", "Laiz"], ["mardila", "Mardila"],
];

/** Onde começa a promessa de gente neste trecho, ou -1. */
function inicioDaPromessa(trecho: string): number {
  if (!ALVO_HUMANO_RE.test(trecho)) return -1;
  const a = PROMESSA_DE_HUMANO_RE.exec(trecho);
  const b = PROMESSA_DE_RESPOSTA_RE.exec(trecho);
  const ids = [a?.index, b?.index].filter((x): x is number => typeof x === "number");
  return ids.length ? Math.min(...ids) : -1;
}

/** Quebra mantendo o separador que seguia cada pedaço. */
function emPedacos(texto: string, sep: RegExp): Array<{ t: string; sep: string }> {
  const partes = texto.split(sep);
  const out: Array<{ t: string; sep: string }> = [];
  for (let i = 0; i < partes.length; i += 2) out.push({ t: partes[i], sep: partes[i + 1] ?? "" });
  return out;
}

/**
 * Das 17h30 às 18h15 (seg–sex), troca a promessa de atendimento humano pela frase
 * do dono; fora do expediente, pela versão da noite. Das 7h30 às 17h30, ou sem
 * promessa, devolve o texto intacto.
 */
export function avisoDeEncerramento(
  texto: string,
  agora: { diaDaSemana: number; hora: number; minuto: number },
): string {
  if (typeof texto !== "string" || !texto.trim()) return texto;
  const noturno = !expedienteAberto(agora);
  if (!noturno && !pertoDoEncerramento(agora)) return texto;
  // Já diz quando a equipe responde: não repetir. "Como estamos fora do horário
  // comercial, assim que a equipe iniciar o expediente pela manhã eles te
  // responderão" (27/08 01h13) virava a frase da noite MAIS a frase original.
  if (/encerramento do atendimento|encerra às|equipe volta em|assim que voltarmos|amanh[ãa] de manh[ãa]|segunda-feira de manh[ãa]|hoje de manh[ãa]|pr[óo]ximo dia [úu]til|fora do hor[áa]rio|pela manh[ãa]|in[íi]cio do expediente|iniciar o expediente/i.test(texto)) {
    return texto;
  }

  const estado = { trocou: false, maos: false };
  const frasesSaida: Array<{ t: string; sep: string }> = [];

  for (const frase of emPedacos(texto, FIM_DE_FRASE_RE)) {
    const trechosSaida: Array<{ t: string; sep: string; dono?: boolean }> = [];
    for (const tr of emPedacos(frase.t, /(\s+[—–]\s+|;\s+)/)) {
      const ini = inicioDaPromessa(tr.t);
      if (ini >= 0) {
        if (tr.t.includes("🙏")) estado.maos = true;
        if (!estado.trocou) {
          estado.trocou = true;
          // Nome no próprio trecho; se o trecho só diz "para ela", o nome está antes
          // na mensagem ("...agendamento específico com a Lidiane. Já estou
          // encaminhando sua mensagem para ela").
          const acha = (x: string) => NOMES_NA_PROMESSA.find(([chave]) => stripAccents(x.toLowerCase()).includes(chave));
          const nome = acha(tr.t) || (/(?<![\p{L}])elas?(?![\p{L}])/iu.test(tr.t) ? acha(texto) : undefined);
          let dono = noturno
            ? fraseForaDoExpediente(agora, nome?.[1] ?? null)
            : nome ? FRASE_ENCERRAMENTO.replace("para um atendente", `para a ${nome[1]}`) : FRASE_ENCERRAMENTO;
          const antes = tr.t.slice(0, ini);
          if (/^[\s\p{Extended_Pictographic}\uFE0F]+$/u.test(antes)) {
            // só emoji antes ("😊 Já avisei a Vânia"): o emoji fica
            dono = antes + dono;
          } else if (/(,|\se)\s*$/u.test(antes) && antes.trim().length >= 3) {
            // o motivo ou o "recebi seu pedido e" ficam: "Recebi seu pedido e vou deixar..."
            dono = antes + dono.charAt(0).toLowerCase() + dono.slice(1);
          }
          trechosSaida.push({ t: dono, sep: tr.sep, dono: true });
        }
        continue;   // promessa repetida depois da troca: sai
      }
      if (estado.trocou && SO_ESPERA_RE.test(tr.t)) {
        if (tr.t.includes("🙏")) estado.maos = true;
        continue;
      }
      trechosSaida.push(tr);
    }
    if (!trechosSaida.length) continue;
    const t = trechosSaida
      .map((x, i) => {
        const ultimo = i === trechosSaida.length - 1;
        // a frase do dono termina em ponto; seguida de outro trecho, o ponto sai
        const corpo = !ultimo && x.dono && x.t.endsWith(".") ? x.t.slice(0, -1) : x.t;
        return corpo + (ultimo ? "" : (x.sep || " — "));
      })
      .join("");
    frasesSaida.push({ t, sep: frase.sep });
  }
  if (!estado.trocou) return texto;

  let r = frasesSaida.map((f, i) => f.t + (i < frasesSaida.length - 1 ? (f.sep || " ") : "")).join("").trim();
  if (estado.maos && !r.includes("🙏")) r += " 🙏";
  return r;
}
