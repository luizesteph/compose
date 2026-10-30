// _shared/confirmacao.ts — insistência da confirmação da consulta (20/10/2026, pedido do dono).
//
// O lembrete "você tem um atendimento agendado… Responda somente: SIM/NÃO" sai de
// outro mecanismo, de manhã. Quem não respondeu até a tarde recebe, entre 13h e
// 15h do dia anterior à consulta, uma segunda mensagem — uma por paciente,
// espaçada (tudo junto o WhatsApp bloqueia a linha). "SIM" a ela confirma a
// consulta no Amigo (PUT /attendances/confirmed); qualquer outra resposta fica
// com a equipe, como a resposta ao lembrete da manhã.
//
// Medido em 20/10 (GET /attendances da API do robô, 21/10): 74 consultas, 31
// confirmadas, 43 esperando. Todas com celular de 11 dígitos. O `start_date` vem
// com a HORA LOCAL marcada como "Z" ("2026-10-21T08:00:00.000Z" = 8h em SP):
// data e hora saem do texto, nunca de new Date().
//
// Funções puras: o cron (confirmacao-insistencia) e o webhook usam as mesmas.

// 29/10 (pedido do dono): o envio começa às 13h (era 16h–17h55), com a mesma duração.
export const JANELA_INICIO_MIN = 13 * 60; // 13:00
export const JANELA_FIM_MIN = 15 * 60; // 15:00 — fim da janela num dia normal
export const ULTIMO_ENVIO_MIN = 14 * 60 + 55; // folga de 5 min antes do fim
/**
 * Plano atrasado (23/10, pedido do dono: "não pode acontecer isso"): o servidor caiu
 * das 15h31 às 17h46, o plano só saiu às 17h56 e as 44 consultas de segunda ficaram
 * "sem_tempo". Plano que começa depois das 16h15 ganha a mesma duração (1h55), até no
 * máximo 19h25; a janela fica aberta até 19h30 para esses envios. Dia normal não muda:
 * plano às 16h, último envio 17h55.
 */
export const JANELA_FIM_ATRASO_MIN = 19 * 60 + 30;
export const ULTIMO_ENVIO_ATRASO_MIN = 19 * 60 + 25;
const TOLERANCIA_DO_INICIO_MIN = 15;

/** Último envio permitido para um plano que começa em `inicioMin` (minutos do dia em SP). */
export function ultimoEnvioDoPlano(inicioMin: number): number {
  if (inicioMin <= JANELA_INICIO_MIN + TOLERANCIA_DO_INICIO_MIN) return ULTIMO_ENVIO_MIN;
  const duracao = ULTIMO_ENVIO_MIN - JANELA_INICIO_MIN;
  return Math.min(ULTIMO_ENVIO_ATRASO_MIN, Math.max(ULTIMO_ENVIO_MIN, inicioMin + duracao));
}
export const INTERVALO_MINIMO_S = 90; // nunca duas mensagens a menos de 90 s
export const MAXIMO_POR_DIA = 70;
/**
 * Quem escreveu à clínica nas últimas N horas está em conversa: a equipe já fala com
 * ele. Era 12 h (20/10); em 21/10 pulou 7 de 16 — e 2 deles precisavam da mensagem
 * (Adriana: "Ah que pena, ok" às 13h48; Renato: "Não, obrigado" ao particular às
 * 8h12). Quem marcou nas últimas 24 h também recebe, com outra abertura (marcouNaConversa).
 */
export const HORAS_EM_CONVERSA = 2;
/** marcação nas últimas N horas = consulta acabou de ser feita: confirma igual, com outra abertura (21/10) */
export const HORAS_MARCOU_AGORA = 24;

/**
 * A mensagem mostra que a consulta foi marcada agora? Fala da equipe "Agendado amanhã…",
 * "Consulta agendada. 22/10…" (Laiz, Glaucia — 21/10), linha da marcação pelo site
 * ("Agendamento via widget: …") ou marcação da Julia (ai_entities.booked_event_id).
 */
export function marcouNaConversa(m: { direction?: string | null; ai_intent?: string | null; message_text?: string | null; booked?: boolean }): boolean {
  if (m.booked) return true;
  const t = String(m.message_text ?? "");
  if (m.direction === "incoming") return /^\s*Agendamento via widget:/i.test(t);
  if (m.direction === "outgoing" && m.ai_intent === "manual_reply") {
    return /\b(?:consulta\s+)?(?:agendad[oa]|marcad[oa])\b/i.test(t) && !/\?\s*$/.test(t.trim()) && !/\b(?:j[aá]\s+tem|tinha|estava)\b/i.test(t);
  }
  return false;
}
/** "SIM" vale até N horas depois do envio */
export const HORAS_VALIDADE_DO_SIM = 30;

const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function diaDaSemana(iso: string): number {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

function somaDias(iso: string, n: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(a, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * Feriados em que a clínica não atende (pedido do dono, 29/10: "segunda é feriado… manda
 * amanhã para as consultas de terça; na segunda não manda nada"). Dia de feriado não é
 * dia útil: a véspera mira o dia seguinte a ele e no feriado não sai nada.
 */
export const FERIADOS = new Set<string>(["2026-11-02"]);
export const ehFeriado = (iso: string) => FERIADOS.has(iso);

/** Próximo dia útil (seg–sex, fora feriado) depois de hoje. Sexta → segunda. */
export function proximoDiaUtil(hojeISO: string): string {
  let d = somaDias(hojeISO, 1);
  while (diaDaSemana(d) === 0 || diaDaSemana(d) === 6 || ehFeriado(d)) d = somaDias(d, 1);
  return d;
}

/**
 * A janela de envio está aberta? (dom–sex fora feriado, 13:00–19:29 em SP). Num dia normal o plano
 * termina às 17h55 e nada sai depois; o resto da janela só serve ao plano atrasado (23/10).
 */
export function janelaAberta(hojeISO: string, minutosDoDia: number): boolean {
  const dw = diaDaSemana(hojeISO);
  // sábado nunca; domingo/feriado só no dia da REPESCAGEM (véspera da consulta — 22/10 e 29/10)
  if (dw === 6) return false;
  if ((dw === 0 || ehFeriado(hojeISO)) && !diaDeRepescagem(hojeISO)) return false;
  return minutosDoDia >= JANELA_INICIO_MIN && minutosDoDia < JANELA_FIM_ATRASO_MIN;
}

/**
 * O relatório espera os envios do dia (23/10): enquanto houver consulta ainda na fila
 * (ou nenhum plano gravado — servidor fora), segura até as 19h40.
 */
/**
 * Regra do dono (24/10): "sempre que você enviar, você tem que mandar o relatório lá no
 * Slack… não importa o dia". Dom–sex sai sempre (é dia de envio); no sábado, só se algo
 * foi enviado hoje (envio extraordinário, como o de 24/10).
 */
export function relatorioNoDia(hojeISO: string, houveEnvioHoje: boolean): boolean {
  const dw = diaDaSemana(hojeISO);
  return houveEnvioHoje || diaDeRepescagem(hojeISO) || (dw >= 1 && dw <= 5 && !ehFeriado(hojeISO));
}

export const RELATORIO_ESPERA_ATE_MIN = 19 * 60 + 40;
export function relatorioDeveEsperar(statusDasLinhas: string[], minutosDoDia: number): boolean {
  if (minutosDoDia >= RELATORIO_ESPERA_ATE_MIN) return false;
  if (!statusDasLinhas.length) return true;
  return statusDasLinhas.some((s) => s === "agendada" || s === "enviando");
}

/**
 * Domingo (pedido do dono, 22/10: "sempre na sexta… para segunda-feira e ainda tentar
 * fazer uma confirmação no domingo de novo"): quem a sexta mandou e ainda não confirmou,
 * nem respondeu nada depois, recebe a mensagem de novo — o fim de semana é longo.
 */
export function ehDomingo(hojeISO: string): boolean {
  return diaDaSemana(hojeISO) === 0;
}

/**
 * Dia da repescagem: dia sem atendimento (domingo ou feriado) que é a VÉSPERA da próxima
 * consulta. Domingo normal → segunda. Feriado de segunda 02/11 (pedido do dono, 29/10: "a
 * repescagem vai ser na segunda"): a sexta manda para a terça, o domingo 01/11 fica quieto
 * e a repescagem é na segunda 02/11.
 */
export function diaDeRepescagem(hojeISO: string): boolean {
  const dw = diaDaSemana(hojeISO);
  if (dw !== 0 && !ehFeriado(hojeISO)) return false;
  return somaDias(proximoDiaUtil(hojeISO), -1) === hojeISO;
}

/** Na repescagem: a linha de sexta ainda pede mensagem? (status + o paciente não respondeu depois) */
export function precisaDeRepescagem(linha: { status: string } | undefined, respondeuDepois: boolean): boolean {
  if (!linha) return true; // consulta marcada depois da sexta
  if (["confirmada", "cancelada", "falhou_confirmar", "falhou_cancelar", "confirmando", "cancelando", "enviando"].includes(linha.status)) return false;
  if (respondeuDepois) return false; // falou algo ("remarcar", pergunta…): está com a equipe
  return true;
}

/**
 * Chave de comparação do telefone: DDD + últimos 8 dígitos. Junta "5511987654321",
 * "11987654321" e o número sem o nono dígito que o WhatsApp às vezes manda
 * ("551187654321"). null quando não dá para saber o DDD.
 */
export function chaveDoTelefone(tel: unknown): string | null {
  let d = String(tel ?? "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  // 11 dígitos só é celular brasileiro com o nono dígito: "12125551234" (EUA,
  // sem o 55) não pode virar "DDD 12" e colidir com o paciente (revisão 20/10)
  if (d.length === 11 && d[2] !== "9") return null;
  return d.slice(0, 2) + d.slice(-8);
}

/** Telefone do cadastro do Amigo no formato de envio (55 + DDD + número). */
export function telefoneParaEnvio(celular: unknown, ddi: unknown): string | null {
  const d = String(celular ?? "").replace(/\D/g, "");
  const cc = String(ddi ?? "55").replace(/\D/g, "") || "55";
  if (cc !== "55") return null; // fora do Brasil: fica com a equipe
  // só celular (11 dígitos com o 9): em 26/10 a mensagem foi para um fixo (Wolf Berger,
  // 11 5093-…) — fixo não tem WhatsApp; fica como "sem celular" e a equipe liga
  const n = d.length === 13 && d.startsWith("55") ? d.slice(2) : d;
  if (n.length === 11 && n[2] === "9") return `55${n}`;
  return null;
}

/** "LUCAS MIOTTO JOSÉ" → "Lucas Miotto José"; mantém de/da/dos minúsculos. */
export function nomeBonito(s: unknown): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split(" ")
    .map((p, i) => (i > 0 && /^(de|da|do|das|dos|e)$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

export type ConsultaDoAmigo = {
  id: number;
  start_date: string; // "AAAA-MM-DDTHH:MM:00.000Z" — hora LOCAL
  confirmed_at?: string | null;
  canceled?: boolean;
  status?: string;
  patient_id?: number;
  patient?: { id?: number; name?: string; contact_cellphone?: string; contact_cellphone_dial_code?: string } | null;
  user?: { id?: number; name?: string } | null;
};

export type ItemDaInsistencia = {
  attendance_id: number;
  patient_id: number;
  paciente_nome: string;
  medico_nome: string;
  data_consulta: string; // AAAA-MM-DD
  hora: string; // HH:MM
  telefone: string | null;
  telefone_chave: string | null;
};

/** A consulta ainda espera confirmação? (não cancelada, sem confirmed_at, status agendado) */
export function esperaConfirmacao(c: ConsultaDoAmigo): boolean {
  if (!c || c.canceled || c.confirmed_at) return false;
  const st = String(c.status ?? "scheduled").toLowerCase();
  return st === "scheduled" || st === "";
}

export function itemDaConsulta(c: ConsultaDoAmigo): ItemDaInsistencia {
  const sd = String(c.start_date ?? "");
  const tel = telefoneParaEnvio(c.patient?.contact_cellphone, c.patient?.contact_cellphone_dial_code);
  return {
    attendance_id: Number(c.id),
    patient_id: Number(c.patient_id ?? c.patient?.id ?? 0),
    paciente_nome: nomeBonito(c.patient?.name),
    medico_nome: nomeBonito(c.user?.name),
    data_consulta: sd.slice(0, 10),
    hora: sd.slice(11, 16),
    telefone: tel,
    telefone_chave: chaveDoTelefone(tel),
  };
}

/**
 * Horários de envio de `n` mensagens entre `inicioMs` e o último envio permitido.
 * Intervalo igual (nunca menos de 90 s) com folga aleatória de até 30% dele — o
 * espaçamento irregular é o que o WhatsApp tolera. O que não couber volta como
 * null (fica de fora, "sem_tempo").
 */
export function planejarHorarios(n: number, inicioMs: number, fimMs: number, aleatorio: () => number = Math.random): Array<number | null> {
  const out: Array<number | null> = [];
  if (n <= 0) return out;
  const espaco = Math.max(0, fimMs - inicioMs);
  const passo = Math.max(INTERVALO_MINIMO_S * 1000, Math.floor(espaco / n));
  for (let i = 0; i < n; i++) {
    const t = inicioMs + i * passo + Math.floor(aleatorio() * passo * 0.3);
    out.push(i < MAXIMO_POR_DIA && t <= fimMs ? t : null);
  }
  return out;
}

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}
function ddmmaaaa(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** "amanhã" / "segunda-feira" — de quando a mensagem sai para o dia da consulta. */
export function quandoEhAConsulta(dataISO: string, hojeISO: string): string {
  if (dataISO === hojeISO) return "hoje";
  if (dataISO === somaDias(hojeISO, 1)) return "amanhã";
  return DIAS[diaDaSemana(dataISO)];
}

/**
 * Texto da insistência. Casa LEMBRETE_DE_CONFIRMACAO_RE ("você tem um
 * atendimento agendado … Responda somente") e traz "Dia: dd/mm/aaaa" — assim a
 * resposta que não for "SIM" vai para a equipe pelo mesmo caminho da resposta ao
 * lembrete da manhã, e o resgate da mensagem parada também não pega.
 */
export function textoDaInsistencia(itens: ItemDaInsistencia[], hojeISO: string, opts?: { marcouAgora?: boolean }): string {
  const quando = quandoEhAConsulta(itens[0].data_consulta, hojeISO);
  // quem marcou nas últimas 24 h também confirma (pedido do dono, 21/10: o "SIM" ativo
  // aumenta a chance de comparecer) — só a abertura muda, "ainda não recebemos" soaria estranho
  const cab = opts?.marcouAgora
    ? "Olá! 😊 Aqui é a Julia, da CBT Ortopedia. Passando para confirmar a sua consulta."
    : "Olá! 😊 Aqui é a Julia, da CBT Ortopedia. Ainda não recebemos a sua confirmação.";
  const pe = "Se precisar remarcar ou cancelar, é só escrever aqui que a nossa equipe te ajuda.";
  if (itens.length === 1) {
    const i = itens[0];
    return `${cab} Você tem um atendimento agendado ${quando} com o(a) *${i.medico_nome}* — ` +
      `Dia: ${ddmmaaaa(i.data_consulta)}, Horário: ${i.hora} — paciente *${i.paciente_nome}*.\n\n` +
      `Responda somente *SIM* para confirmar. ${pe}`;
  }
  const linhas = itens
    .map((i) => `• *${i.paciente_nome}* com o(a) *${i.medico_nome}* — Dia: ${ddmmaaaa(i.data_consulta)}, Horário: ${i.hora}`)
    .join("\n");
  return `${cab} Você tem um atendimento agendado ${quando}:\n${linhas}\n\n` +
    `Responda somente *SIM* para confirmar todos. ${pe}`;
}

/** Resposta depois de confirmar no Amigo. */
export function textoConfirmado(itens: Array<Pick<ItemDaInsistencia, "data_consulta" | "hora" | "medico_nome">>, hojeISO: string): string {
  if (itens.length === 1) {
    const i = itens[0];
    const q = quandoEhAConsulta(i.data_consulta, hojeISO);
    return `Obrigada! Sua consulta de ${q} (${ddmm(i.data_consulta)}) às ${i.hora} com o(a) ${i.medico_nome} está confirmada. ✅ Até lá!`;
  }
  return `Obrigada! Confirmei:\n` +
    itens.map((i) => `• ${ddmm(i.data_consulta)} às ${i.hora} com o(a) ${i.medico_nome}`).join("\n") +
    `\n✅ Até lá!`;
}

/**
 * "SIM" de confirmação — só o sim claro, curto e sem ressalva. "Sim, mas posso
 * remarcar?", "não", "sim? qual horário?" ficam com a equipe.
 */
export function ehSimDeConfirmacao(texto: unknown): boolean {
  const bruto = String(texto ?? "").trim();
  if (!bruto || bruto.length > 80 || bruto.includes("?")) return false;
  const t = bruto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return /^(?:👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|✅|☑️)+$/u.test(bruto.replace(/\s+/g, ""));
  // "Ok", "pode deixar", "combinado" à mensagem de confirmação = SIM (29/10, pedido do dono:
  // Geraldo respondeu "Ok" e ficou sem confirmar). Só a mensagem inteira — "ok, vou ver" não.
  if (/^(?:(?:oi|ola|bom dia|boa tarde|boa noite)\s+)?(?:ok|okay|okey|okk+|pode deixar|combinado|certo|beleza|blz|ta bom|ta certo|perfeito|fechado|positivo)(?:\s+(?:obrigad[oa]|obg|grat[oa]|valeu|ate amanha|estarei la))*$/.test(t)) return true;
  if (/\b(nao|n|remarc\w*|cancel\w*|desmarc\w*|adiar|adiant\w*|antecip\w*|mudar|trocar|outro|outra|atras\w*|mas|porem|so que|infelizmente|nem)\b/.test(t)) return false;
  return /^(?:(?:ok|okay|ola|oi|bom dia|boa tarde|boa noite)\s+)?(?:sim|s|ss|siim+|confirmo|confirmado|confirmada|confirmar|pode confirmar|esta confirmado|ta confirmado|confirmadissimo)\b/.test(t) ||
    /^(?:vou sim|estarei la|estarei presente|irei sim|vou estar la|presenca confirmada|com certeza)\b/.test(t);
}

/**
 * Pedido de cancelamento CLARO em resposta à insistência (24/10, regra do dono: "se você
 * tiver certeza mesmo de que o paciente falou que quer cancelar, pode cancelar automático
 * no Amigo… tem que ser bem claro"). Só frase curta que COMEÇA pedindo o cancelamento, sem
 * pergunta, sem remarcar, sem condição nem negação. Casos de 24/10: "Cancelar, por
 * gentileza" cancela; "Remarcar" e "Vou precisar remarcar a consulta" ficam com a equipe.
 */
export function ehCancelamentoClaro(texto: unknown): boolean {
  // a saudação na frente não muda o pedido: "Olá tudo bom? Vou precisar cancelar" (29/10, Isabella)
  const bruto = String(texto ?? "").trim()
    .replace(/^(?:oi+|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite)[\s,!.]*(?:(?:tudo|td)\s+(?:bem|bom|certo|joia|jóia)[\s,!.?]*)?/iu, "")
    .trim();
  if (!bruto || bruto.length > 80 || bruto.includes("?")) return false;
  const t = bruto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\b(nao|n|nem|remarc\w*|reagend\w*|marcar|agendar|outro|outra|trocar|mudar|adiar|adiant\w*|antecip\w*|transferir|se|caso|mas|porem|so que|posso|consigo|tem como|da pra|da para|como|quanto|taxa|multa|reembols\w*|talvez|acho|pensando|errad\w*|engano)\b/.test(t)) return false;
  return /^(?:(?:oi|ola|bom dia|boa tarde|boa noite)\s+)?(?:(?:por favor|pf|pfv|favor)\s+)?(?:(?:eu\s+)?(?:quero|queria|gostaria de|preciso|vou precisar|vou ter que|tenho que|vou|pode|podem|poderia|poderiam)\s+)?(?:cancelar|cancela|cancele|desmarcar|desmarca|desmarque)\b/.test(t);
}

/** Resposta depois de cancelar no Amigo. */
export function textoCancelado(i: Pick<ItemDaInsistencia, "data_consulta" | "hora" | "medico_nome">, hojeISO: string): string {
  const q = quandoEhAConsulta(i.data_consulta, hojeISO);
  return `Pronto, sua consulta de ${q} (${ddmm(i.data_consulta)}) às ${i.hora} com o(a) ${i.medico_nome} foi cancelada. ` +
    `Se quiser marcar para outro dia, é só escrever aqui. 😊`;
}

/** Filtro de médico do teste: todas as palavras do filtro no nome (sem acento, sem caixa). Filtro vazio = todos. */
export function medicoDoFiltro(nomeMedico: unknown, filtro: string | null | undefined): boolean {
  const n = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const f = n(filtro);
  if (!f) return true;
  const nome = n(nomeMedico);
  return f.split(" ").every((p) => nome.includes(p));
}
