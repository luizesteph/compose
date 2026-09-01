// helpers.ts — Modularizacao M1 (04/07).
// Funcoes PURAS extraidas do monolito index.ts, byte a byte (comportamento
// identico). Este modulo NAO tem @ts-nocheck: e' 100% checado pelo tsc no
// preflight (npm run check) e importavel diretamente pelos testes do vitest.
// Regra: nada aqui pode tocar Deno.env, Supabase, ou estado global — puras.

// PEDIDO DE ENCAIXE NÃO É EMERGÊNCIA (26/08).
// Este padrão fica DENTRO de URGENCY_PATTERNS de propósito — quem pede encaixe
// precisa de gente, porque a agenda online já não tem vaga. O que ele não pode
// é levar junto o texto do pronto-socorro. Em 26/08 as 3 únicas urgências do dia
// foram exatamente isto ("será que conseguiria um encaixe?", "prefiro encaixe
// com dr. Luiz Gustavo", "Encaixe"), e uma paciente teve que responder "não é
// urgente". Nome próprio em vez de índice: a lista cresce, e um `i === 8`
// quebraria em silêncio na próxima inserção.
export const URGENCIA_AGENDA_RE = /\b(encaix(e|ar|amento)|hoje\s+(mesmo|ainda)|agora\s+mesmo)\b/i;

export const URGENCY_PATTERNS: RegExp[] = [
  /\b(emerg[eê]nc[íi]a|urg[eê]ncia|urgente)\b/i,
  /\b(p[\s.]*s[\s.]*|pronto[\s-]?socorro)\b/i,
  // FIX (pego pela suite de testes 04/07): o caso original do Fabiano era "crise
  // NA lombar" — a regex so aceitava "crise lombar"/"crise de lombar".
  /\b(crise|crises)\s+((de|na|no|em)\s+)?(lombar|coluna|ci[aá]tica|nervo|dor|enxaqueca|p[aâ]nico)/i,
  /\b(muita|forte|aguda|aguda?|insuport[aá]vel|terr[ií]vel|imensa)\s+dor\b/i,
  /\bdor\s+(muito\s+)?(forte|aguda?|insuport[aá]vel|terr[ií]vel|imensa)\b/i,
  /\bn[aã]o\s+(consigo|aguento|aguent[oa]|t[oô]\s+aguentando)\b/i,
  /\b(fratur(a|ei|ou)|quebr(ei|ou|ada?)|machuqu(ei|ou)|trinc(ou|ada?))\b/i,
  /\b(lux(ei|ou|ada?)|deslocou|tor(ci|ceu)|fissura(d[oa])?)\b/i,
  URGENCIA_AGENDA_RE,
  /\bn[aã]o\s+(consigo|posso)\s+(andar|caminhar|levantar|mexer|dobrar)\b/i,
  /\b(travou|travado|paralisad[oa])\b/i,
  // Tema 5 (Amostra 3 — alagamento): impossibilidade de deslocamento
  /\b(alagad[oa]|alagamento|enchente|inundad[oa]|enchent)\b/i,
  /\bn[aã]o\s+(consigo|posso|tem\s+como)\s+(chegar|ir|sair|me?\s+deslocar|locomover)\b/i,
  // Relatorio 08/07 (caso Zeila): intercorrencia clinica pos-operatoria ("picos
  // de febre", infeccao) foi IGNORADA — a conversa chegou a ser resetada. Regra
  // da clinica: febre/infeccao/secrecao/problema na cicatriz = prioridade maxima,
  // transferir para humano imediatamente. "pus" exige contexto (e' tambem verbo:
  // "pus gelo") — so' casa como secrecao.
  /\b(febre|febril)\b/i,
  /\b(infec[cç][aã]o|infeccionad[oa]|infecto|secre[cç][aã]o|supura\w*|inflamad[oa])\b/i,
  /\b(saindo|vazando|com|tem|t[aá])\s+pus\b/i,
  /\b(cicatriz|curativo|ponto[s]?)\b[\s\S]{0,30}\b(abriu|abriram|aberta|estourou|vermelh\w*|inchad[oa]|vazando|sangrando)\b/i,
];

export const TRANSIENT_API_MESSAGE =
  "Estou com uma instabilidade momentânea no sistema para consultar seus dados. 🙏 Pode tentar de novo em alguns instantes? Se persistir, já peço pra nossa equipe te ajudar.";

export const AMIGO_AUTH_MESSAGE =
  "Estou com uma dificuldade técnica para acessar o sistema agora. 🙏 Já avisei nossa equipe — se preferir, me diga o que precisa que eles te retornam em breve.";

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function stripAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function getWeekday(isoDate: string): number {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getDay();
}

// CASO CAIO MUNIZ (11/08): a Julia ofereceu "22/08, que é um sábado" com horários.
// A clínica não abre sábado nem domingo — `validateBookingDate` recusa a marcação
// no fim do fluxo, então oferecer esse dia é sempre beco sem saída: o paciente
// escolhe um horário e leva um "não" na sequência. Data de fim de semana não é
// oferta, é armadilha.
export function isWeekendISO(isoDate: string): boolean {
  const wd = getWeekday(isoDate);
  return wd === 0 || wd === 6;
}

export function formatDateLabel(isoDate: string): string {
  const weekDays = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const p = String(isoDate).split("-");
  if (p.length < 3) return String(isoDate);
  return `${String(p[2]).padStart(2, "0")}/${String(p[1]).padStart(2, "0")} (${weekDays[getWeekday(isoDate)]})`;
}

// Saudacao de primeiro contato (avaliacao 06/07): quando o paciente abre a
// conversa ("bom dia, quero marcar com o Dr. X") e a resposta e' um template
// deterministico ("Horários disponíveis com..."), a Julia atropelava a saudacao
// e ia direto aos horarios. Esta funcao monta o PREFIXO de saudacao para
// conversas frias. Retorna null quando a resposta ja abre com saudacao propria
// (nao duplicar "Oi!"). A apresentacao ("Eu sou a Julia, assistente virtual da
// CBT Ortopedia") e' extraida do greeting_template oficial da clinica — segue o
// script configurado, sem hardcode de nome de clinica (multi-clinica).
export function buildColdOpenGreeting(
  hourSP: number,
  reply: string,
  greetingTemplate?: string | null,
): string | null {
  const text = String(reply || "").trim();
  if (!text) return null;
  // Ja abre com saudacao? (pula emoji/pontuacao/asteriscos iniciais). Lookahead
  // em vez de \b: o \b do JS e' ASCII-only e falharia apos "olá" (á nao e' word
  // char); e sem guarda nenhuma, "Oitava..." casaria como "oi".
  const stripped = text.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
  if (
    /^(oi+|ol[aá]|opa|tudo\s+bem|bom\s+dia|boa\s+tarde|boa\s+noite)(?![\p{L}\p{N}])/u.test(stripped) ||
    /^bem[\s-]?vind/u.test(stripped)
  ) {
    return null;
  }
  const saud =
    hourSP >= 5 && hourSP < 12 ? "Bom dia" : hourSP >= 12 && hourSP < 18 ? "Boa tarde" : "Boa noite";
  // "Eu sou a Julia, assistente virtual da CBT Ortopedia" (para no 1o ponto/!/?)
  const m = String(greetingTemplate || "").match(/[Ee]u sou [^.!?\n]{2,90}/);
  const intro = m ? ` ${m[0].trim().replace(/^eu /, "Eu ")}.` : "";
  return `${saud}! 👋${intro}\n\n`;
}

// ─── Lista de espera (06/07, v2: entrada exige consulta marcada) ────────────
// Convite anexado à CONFIRMAÇÃO do booking quando a consulta marcada ficou a
// 7+ dias. O paciente garante o horário distante E entra na fila; a vaga que
// abrir vira REAGENDAMENTO da consulta existente (nunca consulta duplicada).
// As regexes de keyword/aceite/recusa vivem aqui para serem testáveis.
export const WAITLIST_INVITE_THRESHOLD_DAYS = 7;

export function daysFromTodayISO(dateISO: string, todayISO: string): number {
  const [y1, m1, d1] = todayISO.split("-").map(Number);
  const [y2, m2, d2] = dateISO.split("-").map(Number);
  return Math.round((Date.UTC(y2, (m2 || 1) - 1, d2 || 1) - Date.UTC(y1, (m1 || 1) - 1, d1 || 1)) / 86400000);
}

export function buildWaitlistInvite(
  bookedISO: string,
  todayISO: string,
  doctorName: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookedISO) || !/^\d{4}-\d{2}-\d{2}$/.test(todayISO)) return null;
  const dias = daysFromTodayISO(bookedISO, todayISO);
  if (dias < WAITLIST_INVITE_THRESHOLD_DAYS) return null;
  return (
    `\n\n💡 Como sua consulta ficou para daqui a ${dias} dias, se quiser eu te coloco na ` +
    `*lista de espera* do(a) ${doctorName}: se abrir uma vaga antes, te aviso por aqui ` +
    `e a gente antecipa. É só responder *lista de espera*.`
  );
}

// Período preferido para antecipação (pedido 10/07): resposta à pergunta
// "qual período você prefere — manhã, tarde ou qualquer horário?".
// Retorna 'manha' | 'tarde' | 'qualquer' | null (não entendi).
export function parseWaitlistPeriod(text: string): "manha" | "tarde" | "qualquer" | null {
  const t = stripAccents(String(text || "").toLowerCase()).trim();
  if (!t || t.length > 80) return null;
  const manha = /\bmanha\b|\bcedo\b|\bmatutin/.test(t);
  const tarde = /\btarde\b|\bvespertin|\bdepois\s+do\s+almoco\b/.test(t);
  if (manha && tarde) return "qualquer";
  if (manha) return "manha";
  if (tarde) return "tarde";
  if (/\bqualquer\b|\btanto\s+faz\b|\bos\s+dois\b|\bambos\b|\bnao\s+tenho\s+preferencia\b|\bindiferente\b|\bqualquer\s+um\b/.test(t)) {
    return "qualquer";
  }
  return null;
}

export const WAITLIST_KEYWORD_RE = /\blista\s+d?e?\s*espera\b/i;
export const WAITLIST_LEAVE_RE =
  /\b(sair?|saia|remover?|retirar?|tirar?|cancelar?)\b[\s\S]{0,30}?\blista\s+d?e?\s*espera\b|\blista\s+d?e?\s*espera\b[\s\S]{0,20}?\b(sair|remover|cancelar|tirar)\b/i;
// Aceite/recusa da OFERTA de vaga. Recusa testa PRIMEIRO ("não quero" contém
// "quero"). Aceite: curto e sem dígitos — "quero marcar com Dr. X às 15h" tem
// outra intenção e segue o fluxo normal de classificação.
export const WAITLIST_ACCEPT_RE =
  /^\s*[^\p{L}\p{N}]*\s*(sim+|quero+|aceito|pode\s+ser|confirmo|confirmar|fechado|fechou|bora|vamos|claro|com\s+certeza|perfeito|[óo]timo|top|s)(?![\p{L}\p{N}])/iu;
export const WAITLIST_DECLINE_RE =
  /^\s*[^\p{L}\p{N}]*\s*(n[aã]o+(\s+(posso|quero|consigo|d[aá]|vai\s+dar|rola))?|infelizmente|n)(?![\p{L}\p{N}])/iu;

// Fechamento de ticket pós-agradecimento (caso 06/07): paciente
// com booking/confirmação recente agradece e encerra — o ticket deve ser
// RESOLVIDO, não ficar pendente na fila das atendentes. Detecta agradecimento/
// despedida curto SEM pergunta nem nova demanda. "Não, obrigado" (recusa) e
// "obrigada, mas..." (continua) NÃO fecham.
export function isClosingThanks(text: string): boolean {
  const t = String(text || "").trim();
  if (!t || t.length > 60 || t.includes("?")) return false;
  const norm = stripAccents(t.toLowerCase());
  if (!/\b(obrigad[oa]s?|brigad[ao]u?|valeu|agradec\w*|gratidao)\b/.test(norm)) return false;
  return !/\b(mas|porem|quando|onde|como|qual|quero|queria|preciso|pode|poderia|consigo|ainda|nao|cancelar|remarcar|mudar)\b/.test(norm);
}

// ─── Feriados / dias fechados (10/07) ───────────────────────────────────────
// A clínica cadastra os dias fechados (feriado, emenda) no painel; a Julia avisa
// o fechamento com a data de reabertura. Reabertura = próximo dia que NÃO está
// na lista de fechados e NÃO é fim de semana (a clínica não abre sáb/dom).
export function addDaysToISO(iso: string, days: number): string {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + days));
  return dt.toISOString().slice(0, 10);
}

export function nextOpenDayISO(todayISO: string, closedDates: string[]): string {
  const closed = new Set((closedDates || []).map((d) => String(d).slice(0, 10)));
  let candidate = todayISO;
  for (let i = 0; i < 30; i++) {
    candidate = addDaysToISO(candidate, 1);
    const wd = getWeekday(candidate);
    if (wd === 0 || wd === 6) continue; // fim de semana
    if (closed.has(candidate)) continue; // outro dia fechado (emenda)
    return candidate;
  }
  return candidate;
}

// Aviso prefixado à primeira resposta do dia quando a clínica está fechada.
export function buildClosedDayNotice(reason: string | null | undefined, reopenISO: string): string {
  const motivo = String(reason || "").trim();
  return (
    `⚠️ Hoje a nossa clínica está fechada${motivo ? ` (${motivo})` : ""}. ` +
    `Voltamos a funcionar em ${formatDateLabel(reopenISO)}. ` +
    `Mas eu posso te ajudar por aqui normalmente — agendar, remarcar ou tirar dúvidas! 😊\n\n`
  );
}

// Resposta quando o paciente pede ATENDENTE num dia fechado (1º aviso; se
// insistir, o fluxo transfere e o ticket fica na fila para o retorno).
export function buildClosedDayHandoffMessage(reason: string | null | undefined, reopenISO: string): string {
  const motivo = String(reason || "").trim();
  return (
    `Nossa clínica está fechada hoje${motivo ? ` (${motivo})` : ""} e a equipe volta em ` +
    `${formatDateLabel(reopenISO)}. 🙏\n\n` +
    `Você prefere que eu deixe sua solicitação registrada para uma atendente te retornar ` +
    `quando voltarmos, ou quer resolver comigo agora mesmo? Eu consigo *agendar, remarcar ou ` +
    `cancelar consultas* normalmente por aqui! É só me dizer. 😊`
  );
}

// Aceitação da oferta "deixar registrado / falar com atendente" (10/07, teste do
// usuário): a Julia oferecia registrar a solicitação (dia fechado / fim de dia),
// o paciente aceitava ("pode deixar registrado") e NADA acontecia — o classificador
// não devolvia falar_com_atendente. Regex determinística da aceitação; "continua
// você me ajudando" NÃO casa (segue o fluxo normal da IA).
export const HANDOFF_OFFER_ACCEPT_RE =
  /(deixa|deixe|pode\s+deixar|quero\s+deixar|prefiro\s+deixar)[\s\S]{0,24}(registrad|recado)|\bregistr(a|e|ar)\b|\bdeixa\s+(o\s+)?recado\b|\b(prefiro|quero)\b[\s\S]{0,16}\batendente\b|\batendente\s*(mesmo|,?\s*por\s+favor)?[\s!.]*$/i;

// Guarda de fim de dia para transferência a humano (07/07). Perto/depois do
// encerramento do atendimento humano (~18h), transferir para um balcão vazio deixa
// o paciente sem resposta. Retorna a mensagem que avisa + oferece a IA quando é
// tarde; null quando ainda dá tempo (segue transferência normal). Janela: dos 30min
// antes do fecho até a meia-noite (madrugada tem outro tratamento).
export function buildLateHandoffMessage(
  hourSP: number,
  minuteSP: number,
  closeHour: number = 18,
): string | null {
  const nowMin = hourSP * 60 + minuteSP;
  const warnFrom = closeHour * 60 - 30;
  if (nowMin < warnFrom) return null;
  return (
    `Já é fim do dia por aqui e nosso atendimento com atendente encerra às ${closeHour}h — ` +
    `pode ser que não consigam te responder ainda hoje. 🙏\n\n` +
    `Você prefere que eu deixe sua solicitação registrada para uma atendente te retornar ` +
    `(provavelmente amanhã), ou quer que eu continue te ajudando por aqui agora mesmo? ` +
    `Eu consigo *agendar, remarcar ou cancelar consultas* normalmente! É só me dizer. 😊`
  );
}

export function pickEventForBooking(
  events: Array<Record<string, unknown>>,
  opts?: { newPatient?: boolean },
): Record<string, unknown> {
  if (!Array.isArray(events) || events.length === 0) return events?.[0];
  const norm = (e: Record<string, unknown>) =>
    stripAccents(String((e as any).name || (e as any).nome || "").toLowerCase());
  // FIX (auditoria 04/07): os tipos reais da CBT sao "CONSULTA 1° VEZ" e
  // "CONSULTA" — o "1°" usa SIMBOLO DE GRAU (\u00B0), que o regex antigo
  // (primeir|1a|1ª) nao pegava, entao "1° VEZ" era tratado como consulta
  // normal. Cobre: primeira, 1a/1ª/1º/1° (ordinais e grau), e "1 vez"/"vez".
  const isPrimeira = (e: Record<string, unknown>) =>
    /primeir|1\s*[\u00AA\u00BA\u00B0ao]?\s*vez|1\s*[\u00AA\u00BA\u00B0]|\b1a\b/.test(norm(e));
  const isConsulta = (e: Record<string, unknown>) => /consulta/.test(norm(e));
  let chosen: Record<string, unknown> | undefined;
  if (opts?.newPatient) {
    chosen = events.find(isPrimeira) || events.find(isConsulta) || events[0];
  } else {
    chosen = events.find((e) => isConsulta(e) && !isPrimeira(e)) || events.find((e) => !isPrimeira(e)) || events[0];
  }
  console.log(
    `[pickEvent] newPatient=${!!opts?.newPatient} -> "${String((chosen as any)?.name || (chosen as any)?.nome || "?")}" (id=${(chosen as any)?.id}) de ${events.length} eventos`,
  );
  return chosen;
}

// Caso Renan (31/07): o paciente escreveu "Esse horário eu não consigo" e depois
// "Não é urgente não, só quero mudar o horário" — e as DUAS mensagens foram
// transferidas como URGÊNCIA (Regra 4). Ele estava só pedindo outro horário; a
// segunda mensagem NEGAVA a urgência de forma explícita e mesmo assim disparou,
// porque a palavra "urgente" estava lá.
//
// As duas exceções abaixo são cirúrgicas e SÓ neutralizam o padrão que gerou o
// falso positivo. Qualquer outro sinal (dor forte, febre, fratura, alagamento…)
// continua valendo — inclusive na mesma frase: "não é urgente mas estou com muita
// dor" segue sendo urgência, porque quem dispara ali é o padrão de dor.
const URGENCIA_NEGADA_RE =
  /\b(n[aã]o\s+(é|e|eh)?\s*(nada\s+|t[aã]o\s+)?(urgente|urg[eê]ncia|emerg[eê]ncia)|sem\s+(urg[eê]ncia|pressa)|nada\s+urgente)\b/i;
// "não consigo" falando de HORÁRIO/DIA é restrição de agenda, não quadro clínico.
// (As formas clínicas continuam cobertas: "não consigo andar/levantar/mexer" e
// "não consigo chegar/ir/sair" têm padrões próprios na lista.)
const NAO_CONSIGO_DE_AGENDA_RE =
  /\bn[aã]o\s+consigo\b(?![\s\S]{0,20}\b(andar|caminhar|levantar|mexer|dobrar|chegar|ir|sair|dormir|respirar)\b)/i;
const AGENDA_CONTEXTO_RE =
  /\b(hor[aá]rio|hora|dia|data|semana|manh[aã]|tarde|noite|agenda|remarcar|reagendar|mudar|trocar|outro)\b/i;

// Um único lugar decide se o padrão i realmente dispara — detectUrgency e
// classificarUrgencia PRECISAM concordar, senão a mensagem diria uma coisa e o
// roteamento faria outra.
function padraoDeUrgenciaDispara(p: RegExp, i: number, t: string): boolean {
  if (!p.test(t)) return false;
  // i === 0 é o padrão da palavra "urgente/urgência/emergência"
  if (i === 0 && URGENCIA_NEGADA_RE.test(t)) return false;
  // o padrão "não consigo/aguento" só vale se NÃO for sobre agenda
  if (p.source.includes("consigo|aguento") && NAO_CONSIGO_DE_AGENDA_RE.test(t) && AGENDA_CONTEXTO_RE.test(t)) {
    // "não aguento" continua urgente mesmo falando de horário — é dor, não agenda
    if (!/\baguent/i.test(t)) return false;
  }
  return true;
}

// QUAL DADO O CADASTRO ESTA PEDINDO (26/08) ─────────────────────────────────
// Casa com as frases GERADAS PELO CODIGO em action_error — não com o texto que
// sai para o paciente. É essa a diferença que faz este contador funcionar onde o
// anti-duplicata falhou: em 26/08 a Julia pediu o mesmo nome 6 vezes, e as 6
// perguntas chegaram ao paciente reescritas pelo LLM ("me confirme mais uma
// vez", "poderia enviar novamente", "para eu conseguir validar")... o guard
// compara texto, o texto mudava, e o loop passou batido. action_error é fixo.
export function campoPedidoNoCadastro(texto: unknown): "nome" | "cpf" | "nascimento" | null {
  const t = String(texto ?? "").toLowerCase();
  if (!t) return null;
  if (/nome\s+completo/.test(t)) return "nome";
  if (/data\s+de\s+nascimento|nascimento/.test(t)) return "nascimento";
  if (/\bcpf\b/.test(t)) return "cpf";
  return null;
}

// FISIOTERAPIA: AGENDAR SESSAO x PEDIDO MEDICO (26/08) ──────────────────────
// A palavra "fisio" forcava o script comercial (R$ 180 / R$ 1.500) — a INTENCAO
// nao era olhada. Em 26/08 os TRES disparos do dia estavam errados, e nenhum
// queria comprar fisioterapia:
//
//   "Poderia me passar o contato do Andrew? dúvida ... sobre os exercícios"
//   "a fisioterapeuta pediu para fazer mais sessoes mas precisaria o pedido medico"
//   "Poderiam pedir ao Dr. Luiz Gustavo mais 10 sessões de fisioterapia"
//
// Os dois ultimos queriam GUIA do ortopedista, para fazer fisio em outro lugar.
// Mandar tabela de preco para quem pede receita e' vender o que ninguem pediu.
export type IntencaoFisio = "agendar" | "pedido_medico" | "falar_com_fisio" | "sessao_em_curso";

const FISIO_PEDIDO_MEDICO_RE =
  /\b(pedido\s+(m[ée]dic[oa]|do\s+m[ée]dico)|guia|solicita[çc][ãa]o\s+(m[ée]dica|do\s+m[ée]dico)|receita|encaminhamento|renova(r|[çc][ãa]o)|relat[óo]rio|laudo)\b/i;
// "mais 10 sessões", "mais sessoes" — quem ja faz fisio e precisa de mais sessoes
// esta pedindo autorizacao, nao comprando pacote.
const FISIO_MAIS_SESSOES_RE = /\bmais\s+(\d+\s+)?sess[õo]es?\b/i;
// "pedir ao Dr. X", "solicitar para o doutor"
const FISIO_PEDIR_AO_MEDICO_RE = /\b(pedir|solicitar|pede)\b[\s\S]{0,20}\b(ao|para\s+o|pro|com\s+o)\s+(dr\.?|doutor|m[ée]dic[oa])/i;
// duvida sobre exercicio, ou querer falar com a propria fisioterapeuta
const FISIO_FALAR_RE =
  /\bexerc[íi]cios?\b|\b(falar|conversar|d[úu]vida|contato)\b[\s\S]{0,45}\b(fisio\w*|fisioterapeut[ao])/i;

// QUARTA CATEGORIA (28/08): QUEM JA FAZ FISIO AQUI.
// "Posso ir a sessão as 9 de fisioterapia?" recebeu a tabela de preco. A paciente
// nao estava comprando nada — ela ja faz fisio na casa e perguntou da sessao DELA.
// O sinal e a referencia DEFINIDA a uma sessao que ja existe ("a sessao das 9",
// "minha sessao", "a sessao de hoje") junto de um verbo de comparecimento. Nao
// pode casar "quero marcar uma sessao", que e agendamento de verdade.
const FISIO_SESSAO_MINHA_RE =
  /\b(minha|meu)\s+(sess[ãa]o|hor[áa]rio|fisio)\b|\ba\s+sess[ãa]o\s+(d[aeo]s?\s+)?(hoje|amanh[ãa]|\d{1,2}\s*(h|:|hs)?\d{0,2})\b/i;
const FISIO_COMPARECIMENTO_RE =
  /\b(posso\s+ir|vou\s+(me\s+)?atrasar|vou\s+chegar|consigo\s+chegar|vou\s+faltar|n[ãa]o\s+vou\s+poder\s+ir|remarcar\s+(a|minha)\s+sess[ãa]o|cancelar\s+(a|minha)\s+sess[ãa]o|que\s+horas?\s+[ée]\s+(a\s+)?(minha|a)\s+sess[ãa]o)\b/i;

export function classificarPedidoDeFisioterapia(texto: unknown): IntencaoFisio {
  const t = String(texto ?? "");
  if (!t) return "agendar";
  // vem ANTES do pedido medico: "remarcar minha sessão" nao e pedido de guia.
  if (FISIO_COMPARECIMENTO_RE.test(t) || FISIO_SESSAO_MINHA_RE.test(t)) return "sessao_em_curso";
  if (FISIO_PEDIDO_MEDICO_RE.test(t) || FISIO_MAIS_SESSOES_RE.test(t) || FISIO_PEDIR_AO_MEDICO_RE.test(t)) {
    return "pedido_medico";
  }
  if (FISIO_FALAR_RE.test(t)) return "falar_com_fisio";
  return "agendar";
}

// "ATENDENTE", SOZINHO, E UM PEDIDO (26/08) ──────────────────────────────────
// A saudacao da Julia termina com "se preferir falar com um atendente, e so me
// pedir a qualquer momento". Em 26/08 um paciente escreveu exatamente
// "Atendente" e a mensagem caiu em unknown_intent: os padroes de frustracao
// exigem uma segunda palavra ("atendente humano", "atendente agora") e o LLM
// tambem nao pegou.
//
// Deliberadamente ESTREITO. "a atendente me disse", "falei com a atendente
// ontem" NAO podem virar transferencia — por isso a forma curta exige que a
// mensagem seja praticamente so' a palavra. Texto ja vem sem acento (stripAccents).
export const PEDIDO_DE_ATENDENTE_RE =
  /^\s*(atendente|atendimento humano|humano|pessoa de verdade)[\s!.?]*$/i;

// NEGATIVA DE HORARIO — A REGRA 7 PROCURAVA UMA FRASE QUE NAO EXISTE (28/08) ──
// A Regra 7 nasceu para o caso do paciente que tentou 6 datas, ouviu 6 negativas
// e nunca foi transferido. Ela conta `action_error` procurando "nao tem/encontrei
// horarios disponiveis" — mas o codigo escreve "Sem horarios com X em DD/MM".
// As duas nunca casaram, entao a Regra 7 estava MORTA.
//
// Caso 28/08 15:48-15:51: paciente nova, cadastrada, pediu "4a feira da semana
// que vem" -> sem horarios; "ok, veja as datas disponiveis" -> a MESMA data de
// novo; "tanto faz o dia, preferencia apos as 11" -> a mesma data outra vez. O
// contador devia ter escalado na segunda. Quem salvou foi a Mardila, na mao, com
// um horario que existia (09/09 11h20).
//
// Casar por frase e fragil — foi o que quebrou. Estas tres formas sao as que o
// executeAction realmente produz, e a suite compara com o fonte para nao
// deixar a lista envelhecer de novo.
export function ehNegativaDeHorario(texto: unknown): boolean {
  const t = String(texto ?? "");
  if (!t) return false;
  return (
    /\bsem\s+hor[aá]rios?\b/i.test(t) ||
    /n[aã]o\s+(tem|h[aá]|encontrei|foram\s+encontrados)\s+hor[aá]rios/i.test(t)
  );
}

// "TANTO FAZ O DIA" APAGA A DATA (28/08) ────────────────────────────────────
// No mesmo caso: a paciente disse "veja as datas disponiveis" e depois "tanto
// faz o dia", e a Julia continuou procurando em 02/09 — a data que ela mesma
// tinha extraido duas mensagens antes. Data grudada vira negativa repetida numa
// agenda que TEM vaga.
export function pedeQualquerData(texto: unknown): boolean {
  const t = String(texto ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!t) return false;
  return (
    /\btanto\s+faz\b/.test(t) ||
    /\bqualquer\s+(dia|data|hor[a]?rio)\b/.test(t) ||
    /\b(ve|veja|vejo|mostra|me\s+passa|quais|que)\b[\s\S]{0,25}\b(datas?|dias?|hor[a]?rios?)\s+(disponive|livre|que\s+tem|dispon)/.test(t) ||
    /\bo\s+(mais\s+)?(rapido|proximo|cedo)\b/.test(t) ||
    /\bprimeira\s+(data|vaga)\b/.test(t) ||
    // 01/09: as frases reais que a Regra 7 estava punindo. O paciente pedindo
    // MAIS datas é o contrário de paciente desistindo — era ele que levava
    // "vou te passar pra uma colega" na cara.
    //   30/08 09:55  "Me fala as datas disponíveis para o Lucas"
    //   31/08 07:43  "Sim, qual a proxima data q ele tem horario?"
    //   01/09 09:07  "Pra frente"
    /\b(me\s+)?fal[ae]\b[\s\S]{0,20}\b(datas?|dias?|hor[a]?rios?)\b/.test(t) ||
    /\bqual\s+(e\s+)?(a\s+)?proxima\s+(data|vaga|hor[a]?rio)\b/.test(t) ||
    /\bquando\s+(ele|ela|o\s+dr|a\s+dra)\b[\s\S]{0,20}\btem\b/.test(t) ||
    /\bpra\s+frente\b/.test(t) ||
    /\bmais\s+(datas?|dias?|opcoes|horarios?)\b/.test(t)
  );
}

export function detectUrgency(text: string): boolean {
  const t = text || "";
  return URGENCY_PATTERNS.some((p, i) => padraoDeUrgenciaDispara(p, i, t));
}

// "clinica" | "agenda" | null — o ROTEAMENTO é o mesmo para os dois primeiros
// (vai para humano na hora); o que muda é o texto que o paciente recebe.
// Qualquer sinal clínico vence a agenda na mesma frase: "preciso de um encaixe,
// estou com muita dor" é clínico.
export function classificarUrgencia(text: string): "clinica" | "agenda" | null {
  const t = text || "";
  let agenda = false;
  for (let i = 0; i < URGENCY_PATTERNS.length; i++) {
    const p = URGENCY_PATTERNS[i];
    if (!padraoDeUrgenciaDispara(p, i, t)) continue;
    if (p === URGENCIA_AGENDA_RE) { agenda = true; continue; }
    return "clinica";
  }
  return agenda ? "agenda" : null;
}

// Validação real de CPF (dígitos verificadores mod-11). É o que distingue um CPF
// de um telefone celular BR — que também tem 11 dígitos e passaria num teste de
// "só comprimento". OBRIGATÓRIO antes de tratar qualquer número de 11 dígitos
// como CPF (bug Juarez 07/07).
export function isValidCpf(raw: string): boolean {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(d[i], 10) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === parseInt(d[9], 10) && calc(10) === parseInt(d[10], 10);
}

// Extrai UM CPF válido do texto: aceita formatado (123.456.789-09) ou 11 dígitos
// isolados (fronteiras \D impedem casar 11 dígitos no meio de um telefone de
// 12/13). Retorna null se houver zero ou MAIS DE UM CPF distinto (ambiguidade
// "meu CPF é X e o dela é Y" → deixa o fluxo pedir). opts.excludeDigits ignora
// um número específico (ex.: o próprio telefone do remetente).
export function extractCpfFromText(
  text: string,
  opts?: { excludeDigits?: string },
): string | null {
  if (!text) return null;
  const exclude = String(opts?.excludeDigits || "").replace(/\D/g, "");
  const re = /(?<!\d)(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1].replace(/\D/g, "");
    if (digits.length !== 11 || !isValidCpf(digits)) continue;
    if (exclude && (digits === exclude || exclude.endsWith(digits))) continue;
    found.add(digits);
  }
  return found.size === 1 ? [...found][0] : null;
}

export function isTransientApiFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 0 || status >= 500;
}

// "502" do Amigo quase nunca é um 502 DE VERDADE: quando todas as URLs falham, o
// tryFetch (amigoApi.ts) SINTETIZA `status: 502` e guarda a causa real dentro de
// `data.error` — "TIMEOUT: ...", "NETWORK: ..." ou um 5xx autêntico. Como só o 502
// ia para o action_error, era impossível saber, olhando o banco, se o Amigo caiu
// ou se fomos nós que desistimos no timeout (auditoria 27/07: 6 incidentes, todos
// com ~55s de duração — assinatura do nosso ladder de retry, não de erro do Amigo).
// Esta função extrai a causa para o log ficar auto-explicativo.
export function amigoFailReason(data: unknown): string {
  const raw = (data as { error?: unknown } | null)?.error;
  if (typeof raw !== "string" || !raw) return "sem detalhe";
  // formato: "Todas as URLs da API falharam após N tentativas: <causa>"
  const m = raw.match(/tentativas:\s*([\s\S]+)$/);
  return (m ? m[1] : raw).trim().slice(0, 90);
}

export function isAuthApiFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export function amigoAuthAlert(status: number, where: string): string {
  const alertMsg = `🚨 TOKEN AMIGO REJEITADO (${status}) em ${where} — renovar token de integração em clinic_tokens!`;
  console.error(`[AmigoAuth] ${alertMsg}`);
  return alertMsg;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token JWT inválido");
  let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return JSON.parse(atob(base64));
}

export function getPhoneVariants(p: string | null | undefined): string[] {
  const clean = String(p || "").replace(/\D/g, "");
  if (!clean) return [];
  const set = new Set<string>();
  set.add(clean);
  // toggle 55 prefix
  if (clean.startsWith("55")) set.add(clean.slice(2));
  else set.add(`55${clean}`);
  // toggle Brazilian 9th digit on mobile: DDD + 9 + 8 digits vs DDD + 8 digits
  // Only attempt if length matches a mobile pattern.
  const tryToggle9 = (digits: string) => {
    // 13 chars: 55 DD 9 XXXXXXXX  →  55 DD XXXXXXXX (12 chars)
    if (digits.length === 13 && digits[4] === "9") set.add(digits.slice(0, 4) + digits.slice(5));
    // 12 chars: 55 DD XXXXXXXX  →  55 DD 9 XXXXXXXX (13 chars)
    if (digits.length === 12) set.add(digits.slice(0, 4) + "9" + digits.slice(4));
    // 11 chars: DD 9 XXXXXXXX  →  DD XXXXXXXX
    if (digits.length === 11 && digits[2] === "9") set.add(digits.slice(0, 2) + digits.slice(3));
    // 10 chars: DD XXXXXXXX  →  DD 9 XXXXXXXX
    if (digits.length === 10) set.add(digits.slice(0, 2) + "9" + digits.slice(2));
  };
  tryToggle9(clean);
  if (clean.startsWith("55")) tryToggle9(clean.slice(2));
  else tryToggle9(`55${clean}`);
  return Array.from(set);
}

export function normalizeApiResponse(result: { data: unknown; status: number }): unknown {
  let responseData = result.data;
  if (result.status >= 200 && result.status < 300) {
    if (responseData && typeof responseData === "object" && !Array.isArray(responseData)) {
      const obj = responseData as Record<string, unknown>;
      if ("data" in obj) {
        responseData = obj.data;
      }
    }
  }
  return responseData;
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// A resposta PROMETE que uma pessoa vai atender? (rede TransferPromiseGuard, 11/08)
//
// Exige ação em PRIMEIRA PESSOA já tomada ou iminente ("vou te transferir",
// "já avisei a equipe", "uma colega vai continuar com você"). O que NÃO pode
// casar é o OFERECIMENTO — "se preferir falar com um atendente, é só me pedir"
// aparece no rodapé de quase toda saudação, e tratar isso como promessa faria
// a rede disparar em conversa normal.
//
// `(?![\p{L}])` no lugar de `\b`: "você" e "atendê-la" terminam em letra
// acentuada e o `\b` do JS usa alfabeto ASCII — armadilha que já mordeu este
// projeto três vezes.
export const PROMESSA_DE_HUMANO_RE =
  /(vou|estou|irei|já\s+(vou|estou))\s+(te\s+)?(transferir|transferindo|passar|passando|encaminhar|encaminhando|chamar|chamando|acionar|acionando|avisar|avisando|pedir)(?![\p{L}])|j[áa]\s+(te\s+)?(avisei|acionei|pedi|passei|chamei|transferi|notifiquei|encaminhei)(?![\p{L}])|(foi|foram)\s+(acionad|notificad|avisad)[oa]s?(?![\p{L}])|(uma\s+)?(atendente|colega|pessoa\s+da\s+equipe)\s+(vai|ir[áa])\s+(te\s+)?(atender|responder|continuar|ajudar|falar)(?![\p{L}])|nossa\s+equipe\s+(vai|ir[áa])\s+(te\s+)?(atender|responder|entrar\s+em\s+contato|continuar)(?![\p{L}])/iu;

// ─── CONVÊNIO NO TEXTO (17/08) ──────────────────────────────────────────────
// Pedido do dono: "você continua marcando as consultas como particular. As
// meninas não sabem checar a questão do convênio. Se a pessoa fala o convênio,
// você marca de acordo com ele."
//
// Por que estava marcando particular: o convênio dependia de o classificador
// preencher `insurance_choice`, um campo OPCIONAL do schema (required é só
// intent e confidence). Medido em 10 dias: 1 de 74 mensagens de cadastro tiveram
// o campo preenchido. No caso Gabriela (17/08) a paciente escreveu literalmente
// "SulAmérica, Especial 100" e o classificador devolveu o objeto SEM a chave.
// E o cache não salva: só 61 das 1.430 linhas de local_patients (4,3%) têm
// insurance_id. Sem nenhuma das fontes, o pedido ia sem convênio — e o Amigo
// grava como particular.
//
// Esta função não depende do modelo: compara o texto do paciente com a lista
// REAL de convênios da clínica. Determinística, testável, e funciona mesmo
// quando o classificador devolve o objeto vazio.
export function normalizarParaConvenio(s: string): string {
  return stripAccents(String(s || "").toLowerCase()).replace(/[^a-z0-9]/g, "");
}

export function casarConvenioNoTexto(
  texto: string,
  grupos: Array<{ id: unknown; name: unknown }>,
): { id: string; name: string } | null {
  const alvo = normalizarParaConvenio(texto);
  if (!alvo) return null;
  // "particular"/"reembolso" NÃO é convênio — vira id inválido e o paciente ouve
  // que o convênio "particular" não está na lista. Já aconteceu em produção.
  if (/\b(particular|reembolso|nao tenho convenio|sem convenio)\b/.test(
    stripAccents(String(texto || "").toLowerCase()),
  )) {
    return null;
  }
  // do nome mais longo para o mais curto: "SUL AMERICA" ganha de "SUL", e um
  // nome de 2 letras nunca casa por acidente dentro de outra palavra.
  const ordenados = [...(grupos || [])]
    .map((g) => ({ id: String(g?.id ?? ""), name: String(g?.name ?? "") }))
    .filter((g) => g.id && normalizarParaConvenio(g.name).length >= 3)
    .sort((a, b) => normalizarParaConvenio(b.name).length - normalizarParaConvenio(a.name).length);
  for (const g of ordenados) {
    if (alvo.includes(normalizarParaConvenio(g.name))) return g;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// A DATA DA CONSULTA VELHA GRUDA NO REAGENDAR (auditoria 01/09)
// ─────────────────────────────────────────────────────────────────────────────
// No reagendar, `entities.date` preenchido faz a busca olhar SÓ aquela data. E o
// classificador copia para lá a data da consulta encontrada ("sua consulta é
// 31/08"). Resultado medido:
//
//   30/08 12:54  "Tem.data disponível na quarta?"
//                -> "não encontrei horários com LUCAS MIOTTO em quartas em 2026-08-31"
//                   (31/08 era segunda-feira)
//   31/08 14:47  Alvaro, consulta em 31/08, pediu tarde/4ª
//                -> buscas presas em 31/08, depois um único 02/09 -> escalado
//
// Negativa atrás de negativa numa agenda que TEM vaga — e cada negativa alimenta
// a Regra 7, que transfere. Conversão do reagendar: 4 de 15 conversas.
//
// A saída NÃO é "descartar a data quando for igual à da consulta original": o
// próprio Alvaro pediu "tem algum horário hoje mais tarde?" com a consulta no
// mesmo dia — ali as datas coincidem e o pedido é legítimo. Quem decide é o TURNO
// ATUAL: se o paciente acabou de falar de um dia, a data vale; se não falou, ela
// foi herdada do contexto e não pode estreitar a busca.

/** O paciente falou de um DIA nesta mensagem? ("hoje", "amanhã", "dia 12", "05/09") */
export function mensagemFalaDeDia(texto: unknown): boolean {
  const t = stripAccents(String(texto || "").toLowerCase());
  return (
    /\b(hoje|amanha|depois de amanha|ainda esta semana|essa semana|semana que vem|proxima semana)\b/.test(t) ||
    /\b\d{1,2}\s*\/\s*\d{1,2}\b/.test(t) ||          // 05/09
    /\bdia\s+\d{1,2}\b/.test(t) ||                    // dia 12
    /\b\d{1,2}\s+de\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/.test(t)
  );
}

/**
 * Dia da semana pedido NA MENSAGEM, 0=domingo. Lido do texto e não da entidade
 * porque foi exatamente aqui que o classificador falhou: "Tem.data disponível na
 * quarta?" virou busca por quartas DENTRO de 31/08, uma segunda-feira.
 */
export function diaDaSemanaPedido(texto: unknown): number | null {
  const t = stripAccents(String(texto || "").toLowerCase());
  const mapa: Array<[RegExp, number]> = [
    [/\bdomingo\b/, 0],
    [/\b(segunda|segundas|2\s*a\s*feira|2a)\b/, 1],
    [/\b(terca|tercas|3\s*a\s*feira|3a)\b/, 2],
    [/\b(quarta|quartas|4\s*a\s*feira|4a|4f)\b/, 3],
    [/\b(quinta|quintas|5\s*a\s*feira|5a|5f)\b/, 4],
    [/\b(sexta|sextas|6\s*a\s*feira|6a|6f)\b/, 5],
    [/\b(sabado|sabados)\b/, 6],
  ];
  for (const [re, dia] of mapa) if (re.test(t)) return dia;
  return null;
}
