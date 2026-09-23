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
// "hoje ainda" só é pedido de encaixe quando é PEDIDO ("dá para hoje ainda?"):
// "Hoje ainda é dia 21/09" e "hoje ainda não recebi" (21/09) casavam e viravam
// "Recebi seu pedido de encaixe!" — por isso a exceção depois do "ainda".
export const URGENCIA_AGENDA_RE = /\b(encaix(e|ar|amento)|hoje\s+ainda(?!\s+(?:[ée]|eh|est[áa]|era|foi|n[ãa]o|estou)(?![\p{L}]))|hoje\s+mesmo|agora\s+mesmo)\b/iu;

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
  weekdaySP?: number,
): string | null {
  const nowMin = hourSP * 60 + minuteSP;
  const warnFrom = closeHour * 60 - 30;
  if (nowMin < warnFrom) return null;
  // DEPOIS DO FECHAMENTO (15/09, pedido do dono): às 23h04 de 03/09 esta mensagem
  // dizia "pode ser que não consigam te responder ainda hoje" — à noite não há
  // "pode ser": a equipe responde amanhã de manhã, ou na segunda se for sexta à
  // noite ou fim de semana. 15 min de folga no fechamento, como no resto do
  // projeto (as meninas respondem até ~18h10). O marcador "encerra às" continua
  // no texto: é por ele que o fluxo sabe que o aviso já foi dado.
  const fechou = nowMin >= closeHour * 60 + 15;
  const fimDeSemana = weekdaySP === 0 || weekdaySP === 6 || (weekdaySP === 5 && fechou);
  if (fechou || fimDeSemana) {
    const quando = fimDeSemana ? "na segunda-feira de manhã" : "amanhã de manhã";
    return (
      `Nosso atendimento com atendente encerra às ${closeHour}h e já terminou por hoje — ` +
      `a equipe te responde ${quando}. 🙏\n\n` +
      `Você prefere que eu deixe sua solicitação registrada para uma atendente te retornar, ` +
      `ou quer que eu continue te ajudando por aqui agora mesmo? ` +
      `Eu consigo *agendar, remarcar ou cancelar consultas* normalmente! É só me dizer. 😊`
    );
  }
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
// "não consigo" SEM verbo clínico não é quadro clínico — é agenda, telefone,
// site, o que for ("Não consigo nem quarta nem quinta", 21/09, mandou a Maira
// procurar um pronto-socorro). Até 22/09 a exceção ainda exigia uma palavra de
// agenda na frase (horário, dia, semana...) — e "quarta"/"quinta" não estavam
// nela. Em 45 dias, o único disparo de "não consigo" solto foi esse; as formas
// clínicas ("não consigo andar/pisar/mexer/dormir/chegar") têm o verbo e seguem
// urgência, e "não aguento" é dor sempre.
const NAO_CONSIGO_DE_AGENDA_RE =
  /\bn[aã]o\s+consigo\b(?![\s\S]{0,24}\b(andar|caminhar|levantar|mexer|mover|dobrar|chegar|ir|sair|dormir|respirar|pisar|apoiar|sentar|deitar|esticar|firmar|ficar\s+em\s+p[ée]|colocar\s+o\s+p[ée])(?![\p{L}]))/iu;

// Um único lugar decide se o padrão i realmente dispara — detectUrgency e
// classificarUrgencia PRECISAM concordar, senão a mensagem diria uma coisa e o
// roteamento faria outra.
function padraoDeUrgenciaDispara(p: RegExp, i: number, t: string): boolean {
  if (!p.test(t)) return false;
  // i === 0 é o padrão da palavra "urgente/urgência/emergência"
  if (i === 0 && URGENCIA_NEGADA_RE.test(t)) return false;
  // o padrão "não consigo/aguento" só vale com verbo clínico depois do "consigo"
  if (p.source.includes("consigo|aguento") && NAO_CONSIGO_DE_AGENDA_RE.test(t)) {
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
export type IntencaoFisio = "agendar" | "pedido_medico" | "falar_com_fisio" | "sessao_em_curso" | "nota_fiscal";

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

// A TABELA DE PREÇO SÓ PARA QUEM QUER COMEÇAR (22/09). Em 50 dias (72 mensagens
// de fisioterapia), 58 receberam a tabela e cerca de 30 não queriam comprar nada:
// a Fabi desmarcando a sessão dela ("Precisei desmarcar a sessão de fisioterapia
// de hoje às 12h"), o João Flávio pedindo ao médico um novo pedido de 10 sessões,
// "Pode confirmar os dias das seções", "Não estou achando o pedido das minhas
// fisioterapia", nota fiscal. Os padrões abaixo são as formas REAIS dessas
// mensagens; o padrão de quem quer começar continua sendo o padrão.
const FISIO_NOTA_FISCAL_RE = /\b(nota\s+fiscal|nfs?-?e?|recibo)\b/i;
// "pedido de dez sessões", "pedido para fisioterapia", "o pedido das minhas fisio",
// "novo pedido", "pedido atualizado", "me envie um pedido", "fazer essa solicitação"
const FISIO_SESSAO_NOME = "(?:sess(?:[ãa]o|[õo]es)|se[çc](?:[ãa]o|[õo]es)|secao|secoes|fisio\\w*)";
const FISIO_PEDIDO_AMPLO_RE = new RegExp(
  "\\b(?:pedido\\s+(?:de|para|pra|das?|dos?)\\s+(?:\\d+\\s+|dez\\s+|vinte\\s+|mais\\s+|as?\\s+|os?\\s+|minhas?\\s+|meus?\\s+|novas?\\s+)?" + FISIO_SESSAO_NOME +
    "|pedido\\s+(?:atualizado|novo)|nov[oa]\\s+pedido" +
    "|(?:fazer|fizesse|fa[çc]a|emitir|pedir|solicitar|enviar|envie|mandar|mande|trocar|renovar)[,\\s]+(?:um\\s+|o\\s+|a\\s+|ess[ea]\\s+|uma\\s+|nov[oa]\\s+)?(?:solicita[çc][ãa]o|pedido))(?![\\p{L}])",
  "iu",
);
// quem JÁ faz fisio aqui: desmarcar/remarcar/alterar a sessão, confirmar os dias,
// "agendei uma sessão", "meus horários", "terminei as sessões", "já fiz"
const FISIO_SESSAO_EM_CURSO_RE = new RegExp(
  "\\b(?:(?:desmarc|remarc|cancel|alter|mud|troc)\\w*\\s+(?:a|as|o|os|minha|minhas|essa|essas|uma)?\\s*" + FISIO_SESSAO_NOME +
    "|confirm\\w*(?!\\s+se\\b)[\\s\\S]{0,60}\\b" + FISIO_SESSAO_NOME +
    "|" + FISIO_SESSAO_NOME + "[\\s\\S]{0,60}\\bconfirmad\\w*" +
    "|(?:marquei|agendei|tenho)\\s+(?:a\\s+|uma\\s+|as\\s+|minha\\s+|minhas\\s+)?" + FISIO_SESSAO_NOME +
    "|meus\\s+hor[áa]rios|minhas\\s+sess[õo]es" +
    "|(?:terminei|encerr\\w+|conclu[ií]\\w*|acabei|finaliz\\w+|j[áa]\\s+fiz)\\b[\\s\\S]{0,30}\\b(?:" + FISIO_SESSAO_NOME + "|ciclo))(?![\\p{L}])",
  "iu",
);

export function classificarPedidoDeFisioterapia(texto: unknown): IntencaoFisio {
  const t = String(texto ?? "");
  if (!t) return "agendar";
  if (FISIO_NOTA_FISCAL_RE.test(t)) return "nota_fiscal";
  // O pedido vem antes da sessão em curso: "já concluí as 10 sessões, me envie um
  // novo pedido" é pedido. "remarcar minha sessão" não casa nenhum padrão de pedido.
  if (FISIO_PEDIDO_MEDICO_RE.test(t) || FISIO_MAIS_SESSOES_RE.test(t) || FISIO_PEDIR_AO_MEDICO_RE.test(t) || FISIO_PEDIDO_AMPLO_RE.test(t)) {
    return "pedido_medico";
  }
  if (FISIO_COMPARECIMENTO_RE.test(t) || FISIO_SESSAO_MINHA_RE.test(t) || FISIO_SESSAO_EM_CURSO_RE.test(t)) return "sessao_em_curso";
  if (FISIO_FALAR_RE.test(t)) return "falar_com_fisio";
  return "agendar";
}

// SINAL DE FRUSTRAÇÃO — SEM CAIXA ALTA E SEM "!!" (caso Cristiano, 14/09) ─────
// O detector transferia na hora qualquer mensagem com duas palavras em CAIXA ALTA
// ou com "!!". Às 22h24 de 14/09 o Cristiano respondeu o nome do médico como está
// no sistema — "LUCAS MIOTTO JOSE" — e virou "paciente frustrado", passado para
// uma equipe que tinha ido embora. Às 22h42 o aviso de fila; ele desistiu.
//
// Medido em 45 dias (6.959 mensagens de paciente): 154 disparavam SÓ por caixa
// alta ou "!!", e das 32 transferências por frustração quase todas eram isso —
// "Obrigada!!", "Bom dia !!", "OURO 2 EMPRESARIAL", nome em maiúsculas, link de
// exame da Dasa, confirmação automática do Amigo ("Olá, EDUARDO..."). Frustração
// de verdade tem PALAVRA: "Que confusão!", "Estou perguntando isso há 5 msg já",
// "Que absurdo isso". Com as palavras e sem os dois padrões de pontuação, os
// mesmos 45 dias dão 9 disparos — e os 9 são pedido de gente ou queixa real.
//
// A queixa só vale em mensagem curta (até 280 caracteres): texto longo colado
// (relatório, e-mail encaminhado) fala de problema de outros, não do paciente.
const FRUSTRACAO_PADROES: RegExp[] = [
  /\beu\s+n[aã]o\s+estou\b/i,
  /\bvoc[eê]s?\s+est[aã]o\s+(me\s+)?(enrolando|brincando|errando)/i,
  /\bqual\s+(seu|teu)\s+nome\b/i,
  // `(?![\p{L}])` e não `\b`: "robô" termina em letra acentuada, e o `\b` do JS
  // é ASCII — "você é um robô?" nunca casou, nem no detector antigo.
  /\bvoc[eê]\s+[eé]\s+(um\s+)?(rob[oô]|bot|m[aá]quina|ia)(?![\p{L}])/iu,
  /\b(atendente|humano|pessoa)\s+(humano|de\s+verdade|agora|j[aá])\b/i,
  /\bquero\s+falar\s+com\s+(algu[eé]m|atendente|humano|pessoa)\b/i,
  /\bn[aã]o\s+(est[aá]\s+)?funcionando\b/i,
];
const QUEIXA_RE =
  /(que\s+confus[aã]o|absurd|rid[ií]cul|p[ée]ssim|desrespeit|palha[çc]ada|falta\s+de\s+respeito|ningu[eé]m\s+(me\s+)?respond|n[aã]o\s+(me\s+)?respondem|j[aá]\s+(falei|disse|perguntei|expliquei)(?![\p{L}])|perguntando\s+(isso\s+)?h[aá]|h[aá]\s+\d+\s+(msg|mensagens|vezes)|cansad[oa]\s+de|vou\s+desistir|desisto)/iu;

export function sinalDeFrustracao(texto: unknown): boolean {
  const t = typeof texto === "string" ? texto : "";
  if (!t.trim()) return false;
  if (FRUSTRACAO_PADROES.some((p) => p.test(t))) return true;
  return t.length <= 280 && QUEIXA_RE.test(t);
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
    /\bmais\s+(datas?|dias?|opcoes|horarios?)\b/.test(t) ||
    // 22/09 (caso Clarisse): "No dia que ele atender Tanto faz", "pode ser para
    // quando tiver", "O horário que ela tiver", "o que tiver"
    /\b(dia|data|horario)\s+que\s+(ele|ela|o\s+dr|a\s+dra|o\s+medico|a\s+medica|voces?|tiver)\b[\s\S]{0,12}\b(atender|atende|tiver|puder|estiver|der)\b/.test(t) ||
    /\b(o\s+)?(dia|data|horario)\s+que\s+(ele|ela)\s+tiver\b/.test(t) ||
    /\b(para|pra)\s+quando\s+(tiver|der|puder)\b/.test(t) ||
    /\bo\s+que\s+tiver\b/.test(t)
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

/**
 * O paciente citou ESTA hora ("HH:MM") no texto? Aceita "15:40", "15h40", "15.40",
 * "15 h 40", "15h" / "às 15" para hora cheia. Mesma lógica de `mensagemFalaDeDia`,
 * pelo mesmo motivo (19/09): `entities.time` herdava a hora da consulta velha —
 * "Dia 22/09" virava 22/09 08:40 e ia para o PUT do reagendamento sem o paciente
 * ter escolhido hora nenhuma. Hora que ele disse em QUALQUER mensagem dele vale
 * (medido de 04 a 18/09: 7 remarcações boas tinham a hora dita antes do CPF).
 */
export function mensagemCitaHora(texto: unknown, hhmm: unknown): boolean {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = String(parseInt(m[1], 10));
  const mm = m[2];
  const t = String(texto || "").toLowerCase();
  // 15:40 / 15h40 / 15.40 / 15 h 40 — o 0 à esquerda é opcional ("08:40" ou "8:40")
  const comMinuto = new RegExp(`(?<![\\d/])0?${h}\\s*[:h.]\\s*${mm}(?!\\d)`);
  if (comMinuto.test(t)) return true;
  // hora cheia: "15h", "15hs", "às 15" (mas não "às 21/09" nem "15/09")
  if (mm === "00") {
    if (new RegExp(`(?<![\\d/])0?${h}\\s*h(?![\\d])`).test(t)) return true;
    // (?:^|\s) e não \b: "à" é letra acentuada e o \b do JS é ASCII (mesmo tropeço do "você")
    if (new RegExp(`(?:^|\\s)[aà]s\\s+0?${h}(?![\\d/:h.])`).test(t)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// "NÃO ENCONTREI" NÃO É INSTABILIDADE (19/09)
// ─────────────────────────────────────────────────────────────────────────────
// Status "failed" fazia o modelo dizer "tivemos uma instabilidade" (regra FALHA
// TÉCNICA do prompt) para o que era só um cadastro sem consulta futura ou um CPF
// digitado errado — 9 + 3 + 4 casos de 04 a 18/09, cada um seguido de
// transferência por "instabilidade" que não existiu. Texto fixo, sem reescrita:
// diz o que houve e o próximo passo. "Vou passar para a nossa equipe" casa a
// PROMESSA_DE_HUMANO_RE de propósito — é ela que faz a transferência acontecer.
export const TEXTO_SEM_CONSULTA_FUTURA =
  "Não encontrei nenhuma consulta futura no seu CPF aqui no sistema. Vou passar para a nossa equipe conferir e te responder por aqui.";
export const TEXTO_SEM_CONSULTA_PARA_CANCELAR =
  "Não encontrei nenhuma consulta futura no seu CPF para cancelar. Vou passar para a nossa equipe conferir e te responder por aqui.";
/** CPF sem cadastro: pede para conferir os números, sem prometer gente ainda. */
export function textoCpfNaoEncontrado(cpf?: unknown): string {
  const d = String(cpf || "").replace(/\D/g, "");
  const fmt = d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : "";
  return `Não encontrei cadastro com ${fmt ? `o CPF ${fmt}` : "esse CPF"}. Pode conferir os números e me mandar de novo? Se preferir, me diga o nome completo que eu passo para a equipe.`;
}

// "NÃO TENHO NADA ANTES DISSO" SÓ PARA QUEM PEDIU ANTES (22/09)
// ─────────────────────────────────────────────────────────────────────────────
// Quando o fluxo gera a MESMA lista de horários de 30 min atrás, o webhook troca
// a repetição por "esses são os primeiros horários — não tenho nada antes disso"
// (caso Déa, 06/07). Só que de 04 a 21/09 isso saiu 8 vezes e em 5 o paciente
// tinha perguntado outra coisa: "Qual o valor da consulta?", "Ele é de ombro?",
// "Seria especialidade coluna?", "prefiro para outubro, quais datas ele tem" — a
// Elaine (21/09) pediu o mês SEGUINTE e ouviu que não havia nada ANTES. A frase
// antiga fica para quem pediu algo mais cedo; para o resto, um texto que não
// afirma nada e pede a data. Entender "outubro" e "quinta ou sexta" é o item 6,
// fora deste conserto.
const PEDE_MAIS_CEDO_RE =
  /\b(antes|mais\s+(cedo|pr[oó]xim[oa]s?|perto|r[aá]pido)|nada\s+(mais\s+)?cedo|primeir[oa]s?\s+(hor[aá]rio|data|vaga)|(essa|esta|nessa|nesta)\s+semana|hoje|amanh[aã]|urgente|s[oó]\s+(no\s+)?(fim|final)\s+do\s+m[eê]s|(t[aã]o|muito)\s+longe|demora)(?![\p{L}])/iu;

export function pedeHorarioMaisCedo(texto: unknown): boolean {
  const t = typeof texto === "string" ? texto : "";
  if (!t.trim()) return false;
  return PEDE_MAIS_CEDO_RE.test(t);
}

export function textoMesmaLista(nomeDoMedico: string, pediuMaisCedo: boolean): string {
  const medico = String(nomeDoMedico || "o médico").trim() || "o médico";
  if (pediuMaisCedo) {
    return `Infelizmente esses que te passei são os primeiros horários disponíveis do(a) ${medico} — não tenho nada antes disso. 🙏 Algum deles te atende?`;
  }
  return `Esses são os horários que encontrei com ${medico} para os próximos dias. Se você quer outra data ou outro período, me diga qual (por exemplo, "05/10" ou "semana que vem à tarde") que eu confiro a agenda. 🙏`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAUDAÇÃO PURA: CONSUMO GULOSO, NÃO UM REGEX DE UMA LINHA (auditoria 01/09)
// ─────────────────────────────────────────────────────────────────────────────
// O PURE_GREETING_RE aceitava UM token de saudação mais, no máximo, o sufixo
// "tudo bem". Qualquer vírgula, ponto, emoji ou segundo token derrubava — e a
// mensagem ia parar no LLM, voltava rotulada 'unknown' e virava combustível do
// disjuntor. Em 7 dias, 49 saudações caíram assim:
//
//   "Olá, tudo bem?"        a vírgula quebra
//   "Bom.dia"               o ponto quebra
//   "Oi, bom dia!"          dois tokens
//   "Oeeee boa tarde 🌞"    "Oeeee" não casa /oi+e?/ e o emoji sobra
//   "Olá Bom dia Tudo bem?" três tokens
//
// A saída é normalizar e ir COMENDO token de saudação enquanto houver. Se no fim
// não sobrou nada, era saudação. Se sobrou qualquer coisa ("Oi, quero agendar"),
// não era — e vai para o LLM como sempre.
const _TOKENS_DE_SAUDACAO: RegExp[] = [
  /^(bom\s+dia|boa\s+tarde|boa\s+noite|boa\s+madrugada|otima\s+tarde|otimo\s+dia)\b/,
  /^(ola+|oi+e*|oie+|oe+|opa+|hey+|hi+|hello+|e\s*ai+|fala+|salve+)\b/,
  /^(tudo\s+(bem|bom|certo|otimo|joia)|td\s+(bem|bom)|como\s+vai|como\s+esta)\b/,
  /^(voltei|estou\s+de\s+volta|de\s+novo|novamente|outra\s+vez)\b/,
  /^(bem|otimo|otima|tudo)\b/,           // "Bem e vc?", "Tudo?"
  /^(e\s+(vc|voce|voces|ai))\b/,          // "e vc?"
  /^(com\s+voce|contigo|por\s+ai)\b/,     // "...e com você?"
  /^(dr|dra|doutor|doutora|equipe|pessoal|gente)\b/, // vocativo: "Oi equipe"
];

/**
 * A mensagem é SÓ cumprimento, sem pedido nenhum?
 *
 * Come tokens de saudação da esquerda para a direita; sobrou texto, não é pura.
 * Conservadora de propósito: na dúvida devolve false e a mensagem segue para o
 * classificador, que é o comportamento de hoje.
 */
export function ehSaudacaoPura(texto: unknown): boolean {
  let t = stripAccents(String(texto ?? "").toLowerCase())
    // emoji, pontuação e símbolos viram espaço — é a pontuação que derrubava
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  if (t.length > 60) return false; // saudação de verdade é curta

  let mudou = true;
  while (mudou && t) {
    mudou = false;
    for (const re of _TOKENS_DE_SAUDACAO) {
      const m = t.match(re);
      if (m) {
        t = t.slice(m[0].length).trim();
        mudou = true;
        break;
      }
    }
  }
  return t.length === 0;
}

// ============================================================================
// horaDoSlot — a hora de um slot do calendário do Amigo, venha na chave que vier.
// ============================================================================
// O /calendar devolve cada vaga assim:
//   {"start":"09:00","end":"09:20","timegrid_id":…,"user_id":…,"event_id":…}
// A chave é "start". Três leitores no index.ts (o do auto-agendamento pós-cadastro,
// o retry dele e o de duplicidade) liam apenas start_time/startTime/time — as três
// inexistentes — e portanto coletavam ZERO horários sempre. Medido em 01/09: 6
// auto-agendamentos após cadastro, 5 abortados com "retry também vazio", 0 vagas
// lidas. Toda paciente recém-cadastrada ouvia que o horário escolhido tinha sumido
// (caso Nirya 01/09 21:20, caso Cecilia 14:48, caso das 14:57) — e o horário
// continuava livre na agenda.
//
// Um único leitor, para a chave não voltar a divergir. Aceita string solta também.
export function horaDoSlot(slot: unknown): string | null {
  const bruto =
    typeof slot === "string"
      ? slot
      : slot && typeof slot === "object"
        ? String(
            (slot as Record<string, unknown>).start_time ??
              (slot as Record<string, unknown>).startTime ??
              (slot as Record<string, unknown>).start ??
              (slot as Record<string, unknown>).time ??
              (slot as Record<string, unknown>).hour ??
              (slot as Record<string, unknown>).hora ??
              "",
          )
        : "";
  const m = bruto.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  if (!Number.isFinite(h) || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// ============================================================================
// mesmoMedico — "Dr. Hugo Bitencourt Fabri" e "Hugo Bitencourt Fabri" são O MESMO.
// ============================================================================
// A comparação era `a.toLowerCase() !== b.toLowerCase()`, e o LLM alterna livremente
// entre nome com e sem título, curto e completo, maiúsculo e minúsculo. Em 30h de log
// isso disparou 14 vezes "Doctor changed" — as 14 com o MESMO médico dos dois lados:
//   "Dr. Lucas Miotto José" → "Lucas Miotto José"    (título)
//   "Hugo"                  → "Hugo Bitencourt Fabri" (nome curto)
//   "Dr. Lucas Miotto"      → "LUCAS MIOTTO JOSÉ"     (caixa)
//   "Ana Paula"             → "Dra. Ana Paula"        (título feminino)
// Nenhuma troca real. Cada disparo apagava date/time no meio do fluxo — foi assim que
// a Nirya pediu 15h20 e saiu agendada 15h40 (01/09 21:22: o LLM extraiu "15:20", este
// ramo limpou, e a recuperação repôs o 15:40 velho do histórico).
//
// Critério: sem título, sem acento, sem pontuação; um conjunto de nomes contido no
// outro é a mesma pessoa. "Luiz" ⊂ "Luiz Gustavo Estephanelli" = mesmo médico.
// Se a clínica tiver dois médicos de mesmo primeiro nome e o paciente falar só ele,
// damos "mesmo" — o que preserva date/time e deixa a validação de vaga decidir, em vez
// de destruir o contexto. É estritamente melhor que o comportamento anterior.
const _TITULOS_MEDICO = /\b(dr|dra|doutor|doutora|prof|profa|professor|professora)\b/g;

function _nomesDe(v: unknown): Set<string> {
  const t = String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(_TITULOS_MEDICO, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return new Set();
  // "de/da/do/dos/das/e" não distinguem ninguém
  return new Set(t.split(" ").filter((p) => p.length > 1 && !/^(de|da|do|dos|das|e)$/.test(p)));
}

export function mesmoMedico(a: unknown, b: unknown): boolean {
  const A = _nomesDe(a);
  const B = _nomesDe(b);
  if (A.size === 0 || B.size === 0) return false;
  const [menor, maior] = A.size <= B.size ? [A, B] : [B, A];
  for (const nome of menor) if (!maior.has(nome)) return false;
  return true;
}

// ============================================================================
// slotJaPassou — um horário de HOJE que já passou não é vaga, é ruído.
// ============================================================================
// Às 21:06 de 01/09 a Julia ofereceu "01/09 (terça): 10:40, 11:00" — daquela mesma
// manhã. Não era alucinação: a API do Amigo devolve a grade CONFIGURADA do dia,
// sem noção de relógio, e não havia filtro nenhum do nosso lado (o único piso de
// data no parse é `_listGateMin`, que é a string vazia — código morto). Medido:
// 17 ofertas de horário já passado em 7 dias.
//
// O "agora" entra por PARÂMETRO de propósito: mantém este módulo puro (helpers.ts
// roda sob tsc --strict no preflight e é testado com relógio fixo), e impede que a
// função apodreça quando a data do teste ficar no passado. Quem chama passa
// getNowSPParts() — America/Sao_Paulo, nunca new Date() cru.
export function slotJaPassou(
  isoDate: string,
  hhmm: string,
  agora: { hoje: string; hora: number; minuto: number },
  leadMin = 0,
): boolean {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false; // data ilegível não derruba nada
  if (!agora || !/^\d{4}-\d{2}-\d{2}$/.test(String(agora.hoje))) return false;
  if (isoDate > agora.hoje) return false;
  if (isoDate < agora.hoje) return true;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  return Number(m[1]) * 60 + Number(m[2]) < agora.hora * 60 + agora.minuto + leadMin;
}

// A JANELA DE DATAS QUE O PACIENTE PEDIU (item 6, 22/09)
// ─────────────────────────────────────────────────────────────────────────────
// O classificador extrai UMA data (YYYY-MM-DD) e UM dia da semana. Não tem como
// dizer "esta semana", "outubro", "quinta ou sexta", "depois do dia 30". Em 45
// dias, 73 mensagens de agendar/remarcar pediam um período assim — e o fluxo
// respondia com a mesma lista de sempre, pedia "qual data?" três vezes (Clarisse,
// 21/09: "quinta à tarde ou sexta", "Tanto faz" → "informe a data desejada"), ou
// aceitava o chute do modelo ("mês que vem" → 01/10; "terça dia 29" → 22/09).
//
// Aqui a janela é lida do TEXTO, determinística, e devolve o que as buscas
// precisam: um intervalo (inicio/fim), um conjunto de dias da semana, datas
// explícitas, ou "qualquer data". O rótulo é o que a Julia diz de volta
// ("na semana que vem", "em outubro", "às quintas e sextas").
//
// Regras de precedência, da mais específica para a mais genérica:
//   1. "tanto faz" apaga tudo (qualquerData).
//   2. faixa ("depois do dia 30", "até dia 25", "entre 19 e 23") vence datas
//      soltas na mesma frase — "Dia 16/09 preciso remarcar para depois do dia
//      30/09": o 16/09 é a consulta atual, não o destino.
//   3. datas explícitas ("terça dia 29", "6 ou 7 de outubro", "amanhã") vencem
//      semana e mês ("essa semana ele pode amanhã?" é amanhã).
//   4. semana ("esta semana", "semana que vem", "daqui a 2 semanas") vence mês.
//   5. mês ("outubro", "mês que vem", "meados de outubro").
//   Dias da semana ("terça ou quinta", "não posso de segunda") somam-se a
//   qualquer uma das anteriores.
// Passado não é janela: "semana passada", "fiz essa semana", "15 dias atrás",
// "em agosto" (mês já passado) devolvem nada.
export type JanelaDeDatas = {
  inicio: string | null;
  fim: string | null;
  diasDaSemana: number[] | null;
  datas: string[] | null;
  qualquerData: boolean;
  rotulo: string;
  rotuloDias: string;
};

const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MESES_RE = "(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)";
const DIAS_NOMES = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const DIAS_PLURAL = ["domingos", "segundas", "terças", "quartas", "quintas", "sextas", "sábados"];
const DIAS_SINGULAR = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
// "segunda" também é "segunda quinzena", "segunda vez", "segunda opção"...
const DIA_RE = "(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:s)?(?:[\\s-]*feira)?(?!\\s+(?:quinzena|vez|opcao|consulta|via|etapa|metade))(?![\\p{L}])";
const JANELA_FAIXA_DIAS = 60;

function partesISO(iso: string): [number, number, number] {
  const [y, m, d] = String(iso).split("-").map(Number);
  return [y, m, d];
}
function isoDe(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function somaDias(iso: string, n: number): string {
  const [y, m, d] = partesISO(iso);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return isoDe(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function diaDaSemanaISO(iso: string): number {
  const [y, m, d] = partesISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function ultimoDiaDoMes(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function dataValida(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= ultimoDiaDoMes(y, m);
}
// "dia 29" → o próximo 29 a partir de hoje (este mês se ainda não passou, senão o seguinte)
function proximoDiaDoMes(dia: number, hoje: string): string | null {
  const [y, m, d] = partesISO(hoje);
  for (let k = 0; k < 3; k++) {
    const mm = ((m - 1 + k) % 12) + 1;
    const yy = y + Math.floor((m - 1 + k) / 12);
    if (!dataValida(yy, mm, dia)) continue;
    if (k === 0 && dia < d) continue;
    return isoDe(yy, mm, dia);
  }
  return null;
}
// dd/mm[/aa]: ano corrente, ou o seguinte se a data já ficou mais de 30 dias para trás
function dataDDMM(d: number, m: number, a: string | undefined, hoje: string): string | null {
  const [hy] = partesISO(hoje);
  let y = a ? (a.length === 2 ? 2000 + Number(a) : Number(a)) : hy;
  if (!dataValida(y, m, d)) return null;
  let iso = isoDe(y, m, d);
  if (!a && iso < somaDias(hoje, -30)) {
    y += 1;
    if (!dataValida(y, m, d)) return null;
    iso = isoDe(y, m, d);
  }
  return iso;
}
// "outubro" → o próximo outubro (este ano se ainda não passou), até 6 meses à frente
function mesPedido(nome: string, hoje: string): { y: number; m: number } | null {
  const idx = MESES.indexOf(nome);
  if (idx < 0) return null;
  const [hy, hm] = partesISO(hoje);
  const m = idx + 1;
  const y = m >= hm ? hy : hy + 1;
  const distancia = (y - hy) * 12 + (m - hm);
  if (distancia < 0 || distancia > 6) return null;
  return { y, m };
}
function ddmm(iso: string): string {
  const [, m, d] = partesISO(iso);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}
function listaDeDias(dias: number[], plural: boolean): string {
  const nomes = dias.map((d) => (plural ? DIAS_PLURAL[d] : DIAS_SINGULAR[d]));
  if (nomes.length <= 1) return nomes.join("");
  return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}
// verbo no passado logo antes da expressão: "que fiz essa semana", "marcou pra semana passada"
function ehPassado(t: string, indice: number): boolean {
  const antes = t.slice(Math.max(0, indice - 28), indice);
  return /\b(fiz|feito|feita|passei|estive|realizei|tive|fui|marquei|marcou|operei|operou|foi|era)\b[^.!?]*$/.test(antes);
}
// "não consigo essa semana", "estou fora de SP esta semana", "volto de férias em
// outubro": o período está sendo EXCLUÍDO, não pedido. Olha antes e depois.
function ehNegado(t: string, indice: number, tamanho: number): boolean {
  const antes = t.slice(Math.max(0, indice - 32), indice);
  const depois = t.slice(indice + tamanho, indice + tamanho + 26);
  const re = /\b(nao\s+(consigo|posso|vou|estarei|estou|da|dou|tenho)|impossivel|fora\s+de|(estarei|estou|vou\s+estar|ficarei)\s+fora|viajando|viajo|viagem|ferias)\b[^.!?]*$/;
  return re.test(antes) ||
    /^[^.!?]*\b(nao\s+(consigo|posso|vou|estarei|estou|da|dou)|impossivel|estarei\s+fora|passei|fiz|estive|foi|operei|realizei|passad[oa]|atras)\b/.test(depois);
}
// "a consulta de hoje", "marcada para dia 25/09", "consulta dia 16/09": é a consulta
// que já existe, não o destino — o destino vem com "para", "semana que vem", etc.
function ehAConsultaAtual(t: string, indice: number): boolean {
  const antes = t.slice(Math.max(0, indice - 40), indice);
  // só as formas inequívocas de "já existe": "consulta de hoje", "está marcada
  // para dia 25", "tenho sessão dia 16". "marcar consulta para o dia 25" é pedido.
  return (
    /\b(consulta|sessao|retorno|infiltracao|procedimento|horario)\s+de\s+$/.test(antes) ||
    /\b(marcad[ao]|agendad[ao])\s+(?:para\s+|pra\s+|no\s+|em\s+)(?:o\s+|a\s+|essa\s+|esta\s+|nessa\s+)?(?:\w+,?\s+)?(?:dia\s+)?$/.test(antes) ||
    /\btenho\s+(?:uma\s+)?(?:consulta|horario|sessao|retorno|infiltracao)\s+(?:marcad[ao]\s+|agendad[ao]\s+)?(?:para\s+|pra\s+|no\s+|em\s+)?(?:o\s+)?(?:dia\s+)?$/.test(antes)
  );
}

export function janelaDeDatas(texto: unknown, hoje: string): JanelaDeDatas | null {
  const bruto = typeof texto === "string" ? texto : "";
  if (!bruto.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(hoje))) return null;
  const t = stripAccents(bruto.toLowerCase()).replace(/\s+/g, " ");
  const vazio: JanelaDeDatas = { inicio: null, fim: null, diasDaSemana: null, datas: null, qualquerData: false, rotulo: "", rotuloDias: "" };

  if (pedeQualquerData(bruto)) return { ...vazio, qualquerData: true };

  const [hy, hm, hd] = partesISO(hoje);
  const j: JanelaDeDatas = { ...vazio };
  // "na semana do dia 21" é semana, não o dia 21: some do texto antes da leitura das datas
  const semanaDoDia = /\bsemana\s+(?:do\s+dia\s+|de\s+|do\s+)(\d{1,2})(?:\/(\d{1,2}))?(?![\d:h])/.exec(t);
  const tSemSemanaDoDia = semanaDoDia ? t.replace(semanaDoDia[0], " ".repeat(semanaDoDia[0].length)) : t;

  // ── dias da semana ──────────────────────────────────────────────────────
  {
    const diaRe = new RegExp(DIA_RE, "giu");
    const excluidos = new Set<number>();
    const pedidos: number[] = [];
    const faixa = new RegExp(`\\bde\\s+${DIA_RE}\\s+a(?:te)?\\s+${DIA_RE}`, "iu").exec(t);
    if (faixa) {
      const a = DIAS_NOMES.indexOf(faixa[1]);
      const b = DIAS_NOMES.indexOf(faixa[2]);
      if (a >= 0 && b >= 0 && a <= b) {
        for (let d = a; d <= b; d++) pedidos.push(d);
        j.rotuloDias = `de ${DIAS_SINGULAR[a]} a ${DIAS_SINGULAR[b]}`;
      }
    }
    if (pedidos.length === 0) {
      // "3a e 5a", "2ª feira", "4f" (a grafia de quem escreve rápido)
      const numericos = [...t.matchAll(/(?<![\d/:])([2-6])\s*(?:[aª]|f)(?:\s*feira)?(?![\d\p{L}])/giu)].map((m) => ({ index: m.index!, nome: DIAS_NOMES[Number(m[1]) - 1], len: m[0].length }));
      const nomeados = [...t.matchAll(diaRe)].map((m) => ({ index: m.index!, nome: m[1], len: m[0].length }));
      for (const m of [...nomeados, ...numericos].sort((a, b) => a.index - b.index)) {
        const d = DIAS_NOMES.indexOf(m.nome);
        if (d < 0) continue;
        const antes = t.slice(Math.max(0, m.index - 22), m.index);
        if (/\b(nao\s+(posso|consigo|da|dou)(\s+nem)?|nem|menos|exceto|tirando|fora|sem\s+ser|so\s+nao)\s+(de\s+|na\s+|nas\s+|as\s+|a\s+|em\s+|no\s+)?$/.test(antes)) {
          excluidos.add(d);
        } else if (ehNegado(t, m.index, m.len) || ehAConsultaAtual(t, m.index)) {
          continue; // "viajo no domingo", "estarei fora na quinta", "marcada para essa sexta"
        } else if (!pedidos.includes(d)) {
          pedidos.push(d);
        }
      }
      // a clínica não abre no fim de semana: sábado/domingo só valem quando são o
      // único pedido ("aos sábados?" recebe a resposta própria); "viajo no domingo,
      // volto terça" não pode virar busca por domingos
      if (pedidos.some((d) => d >= 1 && d <= 5)) {
        for (let i = pedidos.length - 1; i >= 0; i--) if (pedidos[i] === 0 || pedidos[i] === 6) pedidos.splice(i, 1);
      }
      if (pedidos.length > 0) {
        pedidos.sort((a, b) => a - b);
        j.rotuloDias = `às ${listaDeDias(pedidos, true)}`;
      } else if (excluidos.size > 0) {
        for (let d = 0; d <= 6; d++) if (!excluidos.has(d)) pedidos.push(d);
        j.rotuloDias = `sem ser ${listaDeDias([...excluidos].sort((a, b) => a - b), false)}`;
      }
    }
    if (pedidos.length > 0) j.diasDaSemana = pedidos;
  }

  // ── faixa: depois do dia / a partir / até / antes / entre ───────────────
  const diaOuData = (dia: string, mes?: string, nomeMes?: string): string | null => {
    const d = Number(dia);
    if (nomeMes) {
      const mp = mesPedido(nomeMes, hoje);
      return mp && dataValida(mp.y, mp.m, d) ? isoDe(mp.y, mp.m, d) : null;
    }
    if (mes) return dataDDMM(d, Number(mes), undefined, hoje);
    return proximoDiaDoMes(d, hoje);
  };
  let faixaAchada = false;
  {
    // o número precisa ser um DIA: "dia 19", "30/09" ou "19 de outubro" — "a partir
    // de 16:30", "depois de 2 semanas" e "até 3 vezes" não são datas
    // grupos, a partir de i: dia d/m (i, i+1) | dia d (i+2) | d/m (i+3, i+4) | d de mês (i+5, i+6)
    const ESPEC = "(?:dia\\s+(?:(\\d{1,2})\\/(\\d{1,2})|(\\d{1,2})(?![:\\dh/])(?!\\s*h(?:s|oras)?\\b))|(\\d{1,2})\\/(\\d{1,2})(?![\\d/:])|(\\d{1,2})\\s+de\\s+" + MESES_RE + ")";
    const lerEspec = (m: RegExpExecArray, i: number): string | null =>
      m[i] ? diaOuData(m[i], m[i + 1]) : m[i + 2] ? diaOuData(m[i + 2]) : m[i + 3] ? diaOuData(m[i + 3], m[i + 4]) : m[i + 5] ? diaOuData(m[i + 5], undefined, m[i + 6]) : null;
    const desde = new RegExp(`\\b(depois|apos|a partir)\\s+(?:do|de|da)?\\s*${ESPEC}`).exec(t);
    const emDiante = new RegExp(`\\b(?:do\\s+)?${ESPEC}\\s+em\\s+diante\\b`).exec(t);
    const ate = new RegExp(`\\b(ate|antes)\\s+(?:o\\s+|do\\s+|de\\s+)?${ESPEC}`).exec(t);
    const entre = /\bentre\s+(?:os\s+dias\s+|o\s+dia\s+|dias?\s+)?(\d{1,2})(?:\/(\d{1,2}))?\s+e\s+(?:o\s+dia\s+|dia\s+)?(\d{1,2})(?:\/(\d{1,2}))?(?:\s+de\s+([a-z]+))?/.exec(t);
    const desdeRelativo = /\b(depois|apos|a partir)\s+(?:de\s+|do\s+|da\s+)?(depois\s+de\s+amanha|amanha|hoje)\b/.exec(t);
    if (desdeRelativo && !entre && !desde && !emDiante) {
      const base = desdeRelativo[2] === "hoje" ? hoje : desdeRelativo[2] === "amanha" ? somaDias(hoje, 1) : somaDias(hoje, 2);
      j.inicio = desdeRelativo[1] === "a partir" ? base : somaDias(base, 1);
      j.fim = somaDias(j.inicio, JANELA_FAIXA_DIAS);
      j.rotulo = `a partir de ${ddmm(j.inicio)}`; faixaAchada = true;
    } else if (entre) {
      const nomeMes = entre[5] && MESES.includes(entre[5]) ? entre[5] : undefined;
      let a = diaOuData(entre[1], entre[2], nomeMes);
      let b = diaOuData(entre[3], entre[4], nomeMes);
      // "entre 19 e 23" no dia 21: é este mês, que ainda não acabou
      if (a && b && !nomeMes && !entre[2] && Number(entre[3]) >= hd && Number(entre[1]) < hd) {
        a = isoDe(hy, hm, Number(entre[1]));
      }
      if (a && b && a <= b) {
        j.inicio = a; j.fim = b; j.rotulo = `de ${ddmm(a)} a ${ddmm(b)}`; faixaAchada = true;
      }
    } else if (desde || emDiante) {
      const inclusivo = emDiante ? true : desde![1] === "a partir";
      const base = desde ? lerEspec(desde, 2) : lerEspec(emDiante!, 1);
      if (base) {
        j.inicio = inclusivo ? base : somaDias(base, 1);
        j.fim = somaDias(j.inicio, JANELA_FAIXA_DIAS);
        j.rotulo = `a partir de ${ddmm(j.inicio)}`; faixaAchada = true;
      }
    } else if (ate) {
      const base = lerEspec(ate, 2);
      if (base) {
        j.fim = ate[1] === "antes" ? somaDias(base, -1) : base;
        j.inicio = hoje;
        j.rotulo = `até ${ddmm(j.fim)}`; faixaAchada = true;
      }
    }
  }

  // ── datas explícitas ────────────────────────────────────────────────────
  if (!faixaAchada) {
    const datas = new Set<string>();
    const dda = /\bdepois\s+de\s+amanha\b/.exec(t);
    const amanha = /\bamanha\b/.exec(t);
    const hj = /\bhoje\b/.exec(t);
    if (dda && !ehNegado(t, dda.index, dda[0].length) && !ehAConsultaAtual(t, dda.index)) datas.add(somaDias(hoje, 2));
    else if (amanha && !ehNegado(t, amanha.index, amanha[0].length) && !ehAConsultaAtual(t, amanha.index)) datas.add(somaDias(hoje, 1));
    if (hj && !/\b(hoje\s+ainda\s+(e|nao|esta)|ate\s+hoje)\b/.test(t) && !ehNegado(t, hj.index, hj[0].length) && !ehAConsultaAtual(t, hj.index)) datas.add(hoje);
    // "6 ou 7 de outubro", "16 de outubro"
    for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2}(?:\\s*(?:,|ou|e)\\s*\\d{1,2})*)\\s+de\\s+${MESES_RE}\\b`, "g"))) {
      const mp = mesPedido(m[2], hoje);
      if (!mp || ehNegado(t, m.index!, m[0].length) || ehAConsultaAtual(t, m.index!)) continue;
      for (const n of m[1].split(/\s*(?:,|ou|e)\s*/)) {
        const d = Number(n);
        if (dataValida(mp.y, mp.m, d)) datas.add(isoDe(mp.y, mp.m, d));
      }
    }
    // "dia 8/9", "16/09", "16/09/26" — não "8:20" nem CPF
    for (const m of tSemSemanaDoDia.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/:])/g)) {
      if (ehNegado(t, m.index!, m[0].length) || ehAConsultaAtual(t, m.index!)) continue;
      const iso = dataDDMM(Number(m[1]), Number(m[2]), m[3], hoje);
      if (iso) datas.add(iso);
    }
    // "dia 29", "dia 06 ou 07" — sem hora colada ("dia 14:00")
    for (const m of tSemSemanaDoDia.matchAll(new RegExp(`\\bdias?\\s+(\\d{1,2}(?:\\s*(?:,|ou|e)\\s*\\d{1,2})*)(?![:\\dh/])(?!\\s+de\\s+${MESES_RE})`, "g"))) {
      if (ehPassado(t, m.index!) || ehNegado(t, m.index!, m[0].length) || ehAConsultaAtual(t, m.index!)) continue;
      for (const n of m[1].split(/\s*(?:,|ou|e)\s*/)) {
        const iso = proximoDiaDoMes(Number(n), hoje);
        if (iso) datas.add(iso);
      }
    }
    for (const d of [...datas]) if (d < hoje) datas.delete(d); // "fiz a cirurgia dia 18/09" não é destino
    if (datas.size > 0) {
      j.datas = [...datas].sort();
      const dd = j.datas.map(ddmm);
      j.rotulo = `em ${dd.length <= 1 ? dd.join("") : `${dd.slice(0, -1).join(", ")} ou ${dd[dd.length - 1]}`}`;
    }
  }

  // ── semana ──────────────────────────────────────────────────────────────
  if (!faixaAchada && !j.datas) {
    const dow = diaDaSemanaISO(hoje);
    const segundaDesta = somaDias(hoje, dow === 0 ? -6 : 1 - dow);
    const semanaDe = (segunda: string, rotulo: string) => { j.inicio = segunda; j.fim = somaDias(segunda, 6); j.rotulo = rotulo; };
    const esta = /\b(esta|essa|nesta|nessa|desta|dessa)\s+semana\b|\bainda\s+(?:para\s+|pra\s+)?(?:esta|essa|desta|dessa)?\s*semana\b/.exec(t);
    const proxima = /\b(semana\s+que\s+vem|semana\s+q\s+vem|proxima\s+semana|semana\s+seguinte|outra\s+semana|semana\s+que\s+entra)\b/.exec(t);
    const daqui = /\bdaqui\s+(?:a\s+)?(\d{1,2}|uma|duas|tres)\s+semanas?\b/.exec(t);
    if (semanaDoDia) {
      const alvo = semanaDoDia[2] ? dataDDMM(Number(semanaDoDia[1]), Number(semanaDoDia[2]), undefined, hoje) : proximoDiaDoMes(Number(semanaDoDia[1]), hoje);
      if (alvo) {
        const w = diaDaSemanaISO(alvo);
        semanaDe(somaDias(alvo, w === 0 ? -6 : 1 - w), `na semana do dia ${Number(semanaDoDia[1])}`);
      }
    } else if (daqui) {
      const n = { uma: 1, duas: 2, tres: 3 }[daqui[1]] ?? Number(daqui[1]);
      if (n >= 1 && n <= 12) semanaDe(somaDias(segundaDesta, 7 * n), `daqui a ${n} semana${n > 1 ? "s" : ""}`);
    } else if (proxima && !ehPassado(t, proxima.index) && !ehNegado(t, proxima.index, proxima[0].length)) {
      semanaDe(somaDias(segundaDesta, 7), "na semana que vem");
    } else if (esta && !ehPassado(t, esta.index) && !ehNegado(t, esta.index, esta[0].length)) {
      j.inicio = hoje; j.fim = somaDias(segundaDesta, 6); j.rotulo = "esta semana";
    }
  }

  // ── mês ─────────────────────────────────────────────────────────────────
  if (!faixaAchada && !j.datas && !j.inicio) {
    const mesQueVem = /\b(mes\s+que\s+vem|proximo\s+mes|mes\s+seguinte|mes\s+q\s+vem)\b/.exec(t);
    const esteMes = /\b(este|esse|neste|nesse)\s+mes\b/.exec(t);
    const fimDoMes = /\b(fim|final)\s+do\s+mes\b/.exec(t);
    const comNome = new RegExp(`\\b(?:(primeira|segunda)\\s+quinzena\\s+de\\s+|(inicio|comeco)\\s+de\\s+|(meados|metade|meio)\\s+de\\s+|(fim|final)\\s+de\\s+)?${MESES_RE}\\b`, "g");
    let mes: { y: number; m: number } | null = null;
    let parte: "toda" | "q1" | "q2" | "inicio" | "meio" | "fim" = "toda";
    let nome = "";
    if (mesQueVem && !ehNegado(t, mesQueVem.index, mesQueVem[0].length)) {
      mes = { y: hm === 12 ? hy + 1 : hy, m: hm === 12 ? 1 : hm + 1 }; nome = MESES[mes.m - 1];
    } else if (esteMes) {
      mes = { y: hy, m: hm }; nome = MESES[hm - 1];
    } else if (fimDoMes) {
      mes = { y: hy, m: hm }; nome = MESES[hm - 1]; parte = "fim";
    } else {
      for (const m of t.matchAll(comNome)) {
        // "16 de outubro" já virou data; "em agosto" (passado) não é janela
        if (/\d\s+de\s*$/.test(t.slice(Math.max(0, m.index! - 8), m.index!)) || ehPassado(t, m.index!) || ehNegado(t, m.index!, m[0].length)) continue;
        // "Marco Aurélio" não é março: sem cedilha, só com preposição na frente
        if (m[5] === "marco" && !/mar[çc]o/.test(bruto.toLowerCase().normalize("NFC")) && !/\b(em|para|pra|de|no|ate|durante)\s+$/.test(t.slice(Math.max(0, m.index! - 10), m.index!))) continue;
        if (m[5] === "marco" && !/ç/.test(bruto) && !/\b(em|para|pra|de|no|ate|durante)\s+$/.test(t.slice(Math.max(0, m.index! - 10), m.index!))) continue;
        const mp = mesPedido(m[5], hoje);
        if (!mp) continue;
        mes = mp; nome = m[5];
        parte = m[1] === "primeira" ? "q1" : m[1] === "segunda" ? "q2" : m[2] ? "inicio" : m[3] ? "meio" : m[4] ? "fim" : "toda";
        break;
      }
    }
    if (mes) {
      const ultimo = ultimoDiaDoMes(mes.y, mes.m);
      const faixas = { toda: [1, ultimo], q1: [1, 15], q2: [16, ultimo], inicio: [1, 10], meio: [11, 20], fim: [21, ultimo] } as const;
      const [a, b] = faixas[parte];
      const nomeBonito = nome === "marco" ? "março" : nome;
      let inicio = isoDe(mes.y, mes.m, a);
      if (inicio < hoje) inicio = hoje;
      const fim = isoDe(mes.y, mes.m, b);
      if (fim >= hoje) {
        j.inicio = inicio; j.fim = fim;
        j.rotulo = parte === "q1" ? `na primeira quinzena de ${nomeBonito}` : parte === "q2" ? `na segunda quinzena de ${nomeBonito}`
          : parte === "inicio" ? `no início de ${nomeBonito}` : parte === "meio" ? `em meados de ${nomeBonito}` : parte === "fim" ? `no fim de ${nomeBonito}` : `em ${nomeBonito}`;
      }
    }
  }

  if (!j.inicio && !j.fim && !j.datas && !j.diasDaSemana) return null;
  return j;
}

// Aplica a janela a uma lista de datas ISO (na ordem em que vieram). `semPeriodo`
// solta o intervalo/datas e `semDias` solta os dias da semana — é a escada que a
// resposta honesta usa: "esta semana não tem; nas próximas, às quintas e sextas:".
export function filtrarDatasPelaJanela(
  datasISO: string[],
  janela: JanelaDeDatas | null | undefined,
  opts?: { semPeriodo?: boolean; semDias?: boolean },
): string[] {
  const lista = Array.isArray(datasISO) ? datasISO.filter((d) => /^\d{4}-\d{2}-\d{2}/.test(String(d))) : [];
  if (!janela || janela.qualquerData) return lista;
  let r = lista;
  if (!opts?.semPeriodo) {
    if (janela.datas && janela.datas.length > 0) {
      const set = new Set(janela.datas);
      r = r.filter((d) => set.has(d.slice(0, 10)));
    } else {
      if (janela.inicio) r = r.filter((d) => d.slice(0, 10) >= janela.inicio!);
      if (janela.fim) r = r.filter((d) => d.slice(0, 10) <= janela.fim!);
    }
  }
  if (!opts?.semDias && janela.diasDaSemana && janela.diasDaSemana.length > 0) {
    const set = new Set(janela.diasDaSemana);
    r = r.filter((d) => set.has(diaDaSemanaISO(d.slice(0, 10))));
  }
  return r;
}

// O texto da lista quando houve janela. Nível 1: achou dentro dela. Nível 2: nada
// no período, mas há vaga nos dias pedidos (ou sem dias). Nível 3: nem nos dias
// pedidos. `agendaAte`: a agenda do médico acaba ANTES da janela começar — ela
// ainda não foi aberta, e o texto diz até onde vai em vez de "não tem".
// Nenhum destes textos promete gente (PROMESSA_DE_HUMANO_RE) de propósito.
export function textoHorariosNaJanela(args: {
  nivel: 1 | 2 | 3;
  medico: string;
  janela: JanelaDeDatas;
  periodo?: string;
  corpo: string;
  agendaAte?: string;
}): string {
  const medico = String(args.medico || "o médico").trim() || "o médico";
  const per = args.periodo === "manha" ? " (manhã)" : args.periodo === "tarde" ? " (tarde)" : "";
  const rot = args.janela.rotulo || "";
  const dias = args.janela.rotuloDias || "";
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const rodape = "\n\nAlgum desses serve? Se preferir outra data ou período, é só me dizer.";
  if (args.nivel === 1) {
    return `Horários disponíveis com ${medico}${rot ? ` ${rot}` : ""}${dias ? ` ${dias}` : ""}${per}:\n\n${args.corpo}\n\nQual data e horário prefere?`;
  }
  if (args.agendaAte && rot) {
    return `A agenda de ${medico} ainda não está aberta ${rot} — por enquanto vai até ${formatDateLabel(args.agendaAte)}. Os últimos horários abertos:\n\n${args.corpo}\n\nQuer marcar um deles? Se preferir esperar, é só me chamar mais perto da data.`;
  }
  if (args.nivel === 2 && rot) {
    return `${cap(rot)} não encontrei horário livre com ${medico}${dias ? ` ${dias}` : ""}. Os primeiros que encontrei${dias ? ` ${dias}` : ""}${per}:\n\n${args.corpo}${rodape}`;
  }
  if (rot && dias) {
    return `${cap(rot)} não encontrei horário livre com ${medico}, e nas próximas semanas não há vaga ${dias}. Os primeiros horários${per}:\n\n${args.corpo}${rodape}`;
  }
  if (dias) {
    return `Nas próximas semanas não há vaga com ${medico} ${dias}${per}. Os primeiros horários${per}:\n\n${args.corpo}${rodape}`;
  }
  return `${cap(rot) || "Nesse período"} não encontrei horário livre com ${medico}. Os primeiros que encontrei${per}:\n\n${args.corpo}${rodape}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELAR SÓ COM PEDIDO (23/09, caso Adriana)
// ─────────────────────────────────────────────────────────────────────────────
// 23/09 10h01: "Meu filho passou muito mal e não foi na escola / Preciso cuidar
// dele" foi classificado como cancelar, e a consulta daquele dia com o Dr.
// Cristian foi cancelada NA HORA — a palavra "cancelar" não aparece em lugar
// nenhum. O resto da mensagem chegou no lote seguinte: "Por isso, por favor,
// preciso remarcar a consulta". A remarcação já não achou consulta, a paciente
// perdeu a vaga e esperou das 10h03 às 13h07 pela equipe, que só tinha o dia
// seguinte.
//
// Com CPF e uma consulta futura só, o cancelar fazia o PUT sem perguntar nada.
// Agora o PUT exige pedido: verbo de cancelar/desmarcar na mensagem (ou nas
// anteriores do paciente, quando a atual é o CPF que a Julia pediu), ou o "sim"
// à pergunta da própria Julia. Aviso de ausência ("não vou conseguir ir") vira
// pergunta — cancelar OU remarcar —, que é também a chance de não perder o
// paciente. Calibrado nas 65 mensagens classificadas como cancelar de 09/08 a
// 23/09.
export type PedidoDeCancelar = "cancelar" | "remarcar" | "ausencia" | null;

const _CANCELAR_RE = /\b(?:cancel\w*|desmarc\w*|desist\w*)\b/g;
const _REMARCAR_RE =
  /\b(?:remarcar|remarque|remarcacao|reagendar|reagende|reagendamento|trocar\s+(?:o\s+|a\s+)?(?:dia|data|horario)|mudar\s+(?:o\s+|a\s+)?(?:dia|data|horario)|passar\s+(?:para|pra)\s+outr[oa]|(?:marca|marcar|agenda|agendar)\s+outr[oa]|outr[oa]\s+(?:dia|data|horario|semana)|adiar)\b/g;
const _AUSENCIA_RE =
  /\bnao\s*(?:vou|irei|poderei|conseguirei|consigo|posso|podemos|vamos|vai|ira|podera|conseguira|consegue)\s+(?:mais\s+)?(?:conseguir\s+|poder\s+)?(?:ir|comparecer|chegar|estar|vir|levar)\b|\bnao\s+irei\b|\bimprevisto\b/;

// "não precisa cancelar", "não quero remarcar": a palavra está lá, o pedido não.
function _pedidoNegado(t: string, idx: number): boolean {
  const antes = t.slice(Math.max(0, idx - 30), idx);
  return /\bnao\s+(?:\w+\s+){0,2}$/.test(antes) || /\bsem\s+$/.test(antes);
}

function _temPedido(re: RegExp, t: string): boolean {
  for (const m of t.matchAll(re)) if (!_pedidoNegado(t, m.index ?? 0)) return true;
  return false;
}

/** O que a mensagem pede sobre a consulta que já existe. */
export function lerPedidoDeCancelar(texto: unknown): PedidoDeCancelar {
  const t = stripAccents(String(texto ?? "").toLowerCase());
  if (!t.trim()) return null;
  if (_temPedido(_REMARCAR_RE, t)) return "remarcar";
  if (_temPedido(_CANCELAR_RE, t)) return "cancelar";
  if (_AUSENCIA_RE.test(t)) return "ausencia";
  return null;
}

// A pergunta que a Julia faz antes de cancelar. O "sim" do paciente só vale como
// pedido quando a última mensagem dela for esta pergunta — por isso a marca fixa.
export const PERGUNTA_CANCELAR_MARCA = "Quer que eu *cancele*";
const _SIM_AO_CANCELAR_RE =
  /^\s*(?:sim|s|pode|pode sim|isso|isso mesmo|confirmo|quero|ok|pode ser|por favor|correto|certo|exato)\b/;

/**
 * O cancelar pode fazer o PUT agora, sem perguntar?
 *
 * Sim quando: a mensagem pede cancelar; ou é o "sim" à pergunta da Julia; ou é
 * continuação (CPF, número da lista) de um pedido explícito do paciente. O
 * pedido mais recente vence: quem pediu para cancelar e depois disse "prefiro
 * remarcar" não perde a consulta quando manda o CPF.
 */
export function podeCancelarSemPerguntar(a: {
  atual: unknown;
  anterioresDoPaciente?: unknown[] | null;
  ultimaDaJulia?: unknown;
}): boolean {
  const agora = lerPedidoDeCancelar(a.atual);
  if (agora === "cancelar") return true;
  if (agora === "remarcar") return false;
  if (String(a.ultimaDaJulia ?? "").includes(PERGUNTA_CANCELAR_MARCA)) {
    const t = stripAccents(String(a.atual ?? "").toLowerCase()).trim();
    return !/^n(?:ao|a)\b/.test(t) && _SIM_AO_CANCELAR_RE.test(t);
  }
  const anteriores = (a.anterioresDoPaciente || []).map((x) => String(x ?? "")).slice(-6).reverse();
  for (const t of anteriores) {
    const p = lerPedidoDeCancelar(t);
    if (p === "cancelar") return true;
    if (p === "remarcar") return false;
  }
  return false;
}

/** "de hoje, às 10:00" / "de amanhã (24/09), às 15:20" / "de 25/09 (sexta)". */
export function quandoDaConsulta(dataISO: unknown, hora: unknown, hojeISO: string): string {
  const d = String(dataISO ?? "").slice(0, 10);
  const h = String(hora ?? "").slice(0, 5);
  let q = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    if (d === hojeISO) q = "de hoje";
    else if (d === addDaysToISO(hojeISO, 1)) q = `de amanhã (${d.slice(8, 10)}/${d.slice(5, 7)})`;
    else q = `de ${formatDateLabel(d)}`;
  }
  const hh = /^\d{2}:\d{2}$/.test(h) ? `às ${h}` : "";
  return [q, hh].filter(Boolean).join(", ");
}

/** A pergunta antes de cancelar: diz QUAL consulta e oferece remarcar. Sai literal. */
export function textoPerguntaCancelar(a: { dataISO: unknown; hora: unknown; medico: unknown; hojeISO: string }): string {
  const quando = quandoDaConsulta(a.dataISO, a.hora, a.hojeISO);
  const medico = String(a.medico ?? "").trim();
  return (
    `${PERGUNTA_CANCELAR_MARCA} sua consulta${quando ? ` ${quando}` : ""}${medico ? ` com ${medico}` : ""}? ` +
    "Se preferir *remarcar* para outro dia, é só me dizer que eu vejo os horários. 🙏"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PEDIDO DE NOVA MARCAÇÃO LOGO DEPOIS DE MARCAR/CANCELAR (23/09, Adriana 10h02)
// ─────────────────────────────────────────────────────────────────────────────
// A trava pós-marcação (index.ts, "POST-BOOKING GUARD") existe para um "ok" ou
// "obrigada" não reabrir uma marcação que acabou de acontecer. Mas ela só
// reconhecia data com barra ("30/09") ou frases como "semana que vem": "É
// possível agendar para amanhã?", logo depois do cancelamento, virou "unknown",
// e a Julia respondeu duas vezes que ia "verificar e já te informo" — sem
// verificar nada. Agora a data em palavras é lida pelo mesmo leitor da janela de
// datas (item 6): amanhã, hoje, sexta, outubro, "depois do dia 5". Depois de
// CANCELAR, o pedido de marcar de novo vale mesmo sem data — o contexto antigo já
// foi apagado de propósito. Despedida ("até amanhã") não é pedido.
export function pedidoDeNovaMarcacao(texto: unknown, hojeISO: string, depoisDeCancelar: boolean): boolean {
  const bruto = String(texto ?? "").trim();
  if (!bruto || isClosingThanks(bruto)) return false;
  const t = stripAccents(bruto.toLowerCase()).replace(
    /\bate\s+(?:amanha|logo|mais|breve|la|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/g,
    " ",
  );
  const j = janelaDeDatas(t, hojeISO);
  if (j && (j.inicio || j.fim || (j.datas && j.datas.length > 0) || (j.diasDaSemana && j.diasDaSemana.length > 0))) return true;
  if (
    depoisDeCancelar &&
    /\b(?:agendar|marcar|remarcar|reagendar|nova consulta|outra consulta|outro horario|outra data)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MANHÃ/TARDE NA BUSCA COM VÁRIOS MÉDICOS (23/09, casos Deia e Mari)
// ─────────────────────────────────────────────────────────────────────────────
// No caminho de um médico só, o período filtrava os horários. No de vários
// médicos, não: a lista enchia com as primeiras datas (todas à tarde) e o
// modelo respondia, honesto, "não encontrei atendimento de manhã" — havia 07/10
// às 08h40, que a Glaucia achou em seguida.
export function filtrarPeloPeriodo(slots: string[], periodo?: string | null): string[] {
  if (periodo === "manha") return slots.filter((t) => String(t).slice(0, 5) < "12:00");
  if (periodo === "tarde") return slots.filter((t) => String(t).slice(0, 5) >= "12:00");
  return slots;
}

/** Nenhum médico tem vaga no período pedido: diz isso e mostra o que há. Sai literal. */
export function textoSemHorarioNoPeriodo(a: { periodo: string; quem: string; rotulo?: string; corpo: string }): string {
  const per = a.periodo === "manha" ? "de manhã" : "à tarde";
  const rot = String(a.rotulo || "").trim();
  return (
    `Não encontrei horário ${per} com ${a.quem}${rot ? ` ${rot}` : ""}. Os horários que encontrei:\n\n${a.corpo}\n\n` +
    "Algum desses serve? Se preferir outra data ou período, é só me dizer."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// O TETO DO AMIGO COM O TEXTO CERTO (23/09, caso Karina)
// ─────────────────────────────────────────────────────────────────────────────
// O `POST /attendances` do robô às vezes devolve "Limite de atendimentos
// atingido". A Julia explicava com a consulta MAIS ANTIGA do paciente — a
// Karina ouviu "você já tem uma consulta marcada para 31/08", e respondeu "31/08
// já passou". A que pesava era a de 15/09.
//
// O que se sabe do teto (medido em 23/09, 13 pacientes bloqueados e 38 marcações
// aceitas desde 27/08): NÃO é "uma por mês" — a Julia marcou a segunda consulta
// do mês para Carolina, Ju Michelan, GHD e Rodrigo. Em 11 dos 13 bloqueios havia
// consulta até 16 dias antes da data pedida (o tipo CONSULTA do Amigo tem
// `comeback_days: 16`, o prazo de retorno), e em 4 dos 13 era a própria marcação
// repetida (o site marcou e a Julia tentou de novo; Maria Inês, Renan, Giulia,
// Ana Carolina). A equipe marca esses casos pela tela do Amigo, em geral como
// outro tipo de atendimento e sem convênio. O Amigo não documenta a regra.
//
// Então o texto diz o que dá para afirmar:
//   mesmo dia  → a consulta já existe; confirma e NÃO transfere
//   futura     → cita a futura e oferece trocar (a equipe remarca)
//   recente    → cita a última consulta (até 30 dias antes) e passa para a equipe
//   nenhuma    → texto neutro e passa para a equipe
export type AtendimentoDoAmigo = {
  start_date?: unknown;
  date?: unknown;
  status?: unknown;
  canceled?: unknown;
  user?: unknown;
  doctor_name?: unknown;
  user_name?: unknown;
};

export function textoDoLimiteDeAtendimentos(a: {
  atendimentos: AtendimentoDoAmigo[] | null | undefined;
  dataPedida: string;
  hoje: string;
}): { tipo: "mesmo_dia" | "futura" | "recente" | "nenhuma"; transferir: boolean; texto: string } {
  const vivos = (Array.isArray(a.atendimentos) ? a.atendimentos : [])
    .map((x) => {
      const st = String(x?.status ?? "").toLowerCase();
      const cancelada = x?.canceled === true || x?.canceled === "true" || /^cancel/.test(st);
      const bruto = String(x?.start_date ?? x?.date ?? "");
      const dia = bruto.slice(0, 10);
      const hora = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(bruto) ? bruto.slice(11, 16) : "";
      const u = x?.user && typeof x.user === "object" ? (x.user as Record<string, unknown>).name : "";
      const medico = String(u || x?.doctor_name || x?.user_name || "").trim();
      return { cancelada, dia, hora, medico };
    })
    .filter((v) => !v.cancelada && /^\d{4}-\d{2}-\d{2}$/.test(v.dia))
    .sort((x, y) => `${x.dia} ${x.hora}`.localeCompare(`${y.dia} ${y.hora}`));

  type V = (typeof vivos)[number];
  const quando = (v: V) => `*${formatDateLabel(v.dia)}*${v.hora ? ` às *${v.hora}*` : ""}`;
  const com = (v: V) => (v.medico ? ` com ${v.medico}` : "");

  const mesmoDia = vivos.find((v) => v.dia === a.dataPedida);
  if (mesmoDia) {
    return {
      tipo: "mesmo_dia",
      transferir: false,
      texto:
        `Você já tem consulta marcada para ${quando(mesmoDia)}${com(mesmoDia)}. ✅ ` +
        "Não precisa marcar de novo — se quiser trocar o horário, é só me dizer.",
    };
  }
  const futura = vivos.find((v) => v.dia >= a.hoje);
  if (futura) {
    return {
      tipo: "futura",
      transferir: true,
      texto:
        `Não consegui marcar esse horário: você já tem uma consulta marcada para ${quando(futura)}${com(futura)}, ` +
        "e o sistema da clínica não aceitou uma segunda. Já chamei uma atendente — se você quiser *trocar* a consulta " +
        "que já existe por esse novo horário, ela resolve rapidinho. 🙏",
    };
  }
  const limiteRecente = addDaysToISO(a.dataPedida, -30);
  const ultima = [...vivos].reverse().find((v) => v.dia < a.hoje && v.dia >= limiteRecente);
  if (ultima) {
    return {
      tipo: "recente",
      transferir: true,
      texto:
        `Não consegui marcar pelo sistema: você teve consulta em ${quando(ultima)}${com(ultima)}, e uma nova consulta ` +
        "tão perto da anterior precisa ser marcada pela nossa equipe (às vezes entra como retorno). " +
        "Já chamei uma atendente para te ajudar. 🙏",
    };
  }
  return {
    tipo: "nenhuma",
    transferir: true,
    texto:
      "Não consegui concluir esse agendamento: o sistema da clínica não aceitou a marcação. " +
      "Já chamei uma atendente para finalizar com você. 🙏",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSULTA PARA OUTRA PESSOA (23/09, caso Karina)
// ─────────────────────────────────────────────────────────────────────────────
// 22/09 13h27: "teria um horário para atender minha filha de 12 anos?". No dia
// seguinte, "Se ainda tiver na sexta às 15h" — e a Julia tentou marcar no CPF da
// MÃE, que o cache achou pelo telefone. Só não virou consulta no nome errado
// porque o Amigo recusou por outro motivo. É a mesma família do caso Andrea
// (16/09): o telefone é de quem escreve, a consulta pode não ser.
//
// Quando a conversa diz que a consulta é de outra pessoa, o CPF que o PACIENTE
// não digitou (veio do cache, do telefone ou de uma busca antiga) não vale: a
// Julia segura o horário e pede nome completo e CPF de quem vai ser atendido.
// A mensagem mais recente decide — "agora quero marcar para mim" desfaz.
export type ConsultaDeOutraPessoa = { relacao: string; comArtigo: string; pronome: "dela" | "dele" };

const _RELACOES_FEM: Record<string, string> = {
  filha: "filha", mae: "mãe", esposa: "esposa", mulher: "esposa", irma: "irmã", sogra: "sogra", neta: "neta",
  namorada: "namorada", companheira: "companheira", enteada: "enteada", sobrinha: "sobrinha", tia: "tia",
  prima: "prima", cunhada: "cunhada", nora: "nora", crianca: "criança",
};
const _RELACOES_MASC: Record<string, string> = {
  filho: "filho", pai: "pai", marido: "marido", esposo: "esposo", irmao: "irmão", sogro: "sogro", neto: "neto",
  namorado: "namorado", companheiro: "companheiro", enteado: "enteado", sobrinho: "sobrinho", tio: "tio",
  primo: "primo", cunhado: "cunhado", genro: "genro", bebe: "bebê",
};
const _REL = `(${[...Object.keys(_RELACOES_FEM), ...Object.keys(_RELACOES_MASC), "avo"].join("|")})`;
const _PARA_OUTRA_RE = new RegExp(`\\b(?:para|pra|pro|p/)\\s+(?:o\\s+|a\\s+)?(?:meu|minha)\\s+${_REL}\\b`);
const _ACAO_PARA_OUTRA_RE = new RegExp(
  `\\b(?:atender|atendimento|consulta|horario|agendar|marcar|levar|trazer|consultar|examinar|avaliar)\\b[^.?!\\n]{0,40}?\\b(?:meu|minha)\\s+${_REL}\\b`,
);
const _OUTRA_PRECISA_RE = new RegExp(
  `\\b(?:meu|minha)\\s+${_REL}\\b[^.?!\\n]{0,80}?\\b(?:precisa|precisaria|precisar|quer|queria|vai|tem que|teria|machucou|esta com|sente|sentindo|com dor|caiu|torceu|quebrou|passou|operou)\\b`,
);
const _SOU_RESPONSAVEL_RE = /\b(?:sou|aqui e)\s+(?:a|o)\s+(?:mae|pai|responsavel|avo)\s+d([oa])\s+[a-z]/;
const _PARA_MIM_RE = /\b(?:para|pra)\s+mim\b|\beu\s+mesm[oa]\b|\bminha\s+(?:propria\s+)?consulta\b|\bsou\s+eu\b/;

function _descreverRelacao(chave: string, original: string): ConsultaDeOutraPessoa {
  if (chave === "avo") {
    const fem = /\bav[óo]\b/.test(original) && original.includes("avó");
    return fem
      ? { relacao: "avó", comArtigo: "a sua avó", pronome: "dela" }
      : { relacao: "avô", comArtigo: "o seu avô", pronome: "dele" };
  }
  if (_RELACOES_FEM[chave]) return { relacao: _RELACOES_FEM[chave], comArtigo: `a sua ${_RELACOES_FEM[chave]}`, pronome: "dela" };
  const m = _RELACOES_MASC[chave] || chave;
  return { relacao: m, comArtigo: `o seu ${m}`, pronome: "dele" };
}

/** A consulta é de outra pessoa? Lê as mensagens do paciente (ordem cronológica), da mais nova para a mais velha. */
export function consultaParaOutraPessoa(textosDoPaciente: unknown[] | null | undefined): ConsultaDeOutraPessoa | null {
  const lista = (textosDoPaciente || []).map((x) => String(x ?? "")).filter((x) => x.trim());
  for (let i = lista.length - 1; i >= 0; i--) {
    const original = lista[i].toLowerCase();
    const t = stripAccents(original);
    if (_PARA_MIM_RE.test(t)) return null;
    const sou = _SOU_RESPONSAVEL_RE.exec(t);
    if (sou) return sou[1] === "a" ? _descreverRelacao("filha", original) : _descreverRelacao("filho", original);
    const m = _PARA_OUTRA_RE.exec(t) || _ACAO_PARA_OUTRA_RE.exec(t) || _OUTRA_PRECISA_RE.exec(t);
    if (m) return _descreverRelacao(m[1], original);
  }
  return null;
}

/** O CPF apareceu digitado pelo paciente em alguma mensagem? (Senão veio do cache ou do telefone.) */
export function cpfDigitadoNaConversa(cpf: unknown, textos: unknown[] | null | undefined): boolean {
  const d = String(cpf ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  return (textos || []).some((t) => String(t ?? "").replace(/\D/g, "").includes(d));
}
