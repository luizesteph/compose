// _shared/confirmacao.ts — insistência da confirmação da consulta (20/10/2026, pedido do dono).
//
// O lembrete "você tem um atendimento agendado… Responda somente: SIM/NÃO" sai de
// outro mecanismo, de manhã. Quem não respondeu até a tarde recebe, entre 16h e
// 18h do dia anterior à consulta, uma segunda mensagem — uma por paciente,
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

export const JANELA_INICIO_MIN = 16 * 60; // 16:00
export const JANELA_FIM_MIN = 18 * 60; // 18:00 — nada sai depois disso
export const ULTIMO_ENVIO_MIN = 17 * 60 + 55; // folga de 5 min antes do fim
export const INTERVALO_MINIMO_S = 90; // nunca duas mensagens a menos de 90 s
export const MAXIMO_POR_DIA = 70;
/**
 * Quem escreveu à clínica nas últimas N horas está em conversa: a equipe já fala com
 * ele. Era 12 h (20/10); em 21/10 pulou 7 de 16 — e 2 deles precisavam da mensagem
 * (Adriana: "Ah que pena, ok" às 13h48; Renato: "Não, obrigado" ao particular às
 * 8h12). Quem marcou HOJE sai pela outra regra (marcouNaConversa).
 */
export const HORAS_EM_CONVERSA = 2;
/** marcação nas últimas N horas = consulta acabou de ser feita, não se pede confirmação */
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

/** Próximo dia útil (seg–sex) depois de hoje. Sexta → segunda. */
export function proximoDiaUtil(hojeISO: string): string {
  let d = somaDias(hojeISO, 1);
  while (diaDaSemana(d) === 0 || diaDaSemana(d) === 6) d = somaDias(d, 1);
  return d;
}

/** A janela de envio está aberta? (seg–sex, 16:00–17:59 em SP) */
export function janelaAberta(hojeISO: string, minutosDoDia: number): boolean {
  const dw = diaDaSemana(hojeISO);
  if (dw === 0 || dw === 6) return false;
  return minutosDoDia >= JANELA_INICIO_MIN && minutosDoDia < JANELA_FIM_MIN;
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
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return d;
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
export function textoDaInsistencia(itens: ItemDaInsistencia[], hojeISO: string): string {
  const quando = quandoEhAConsulta(itens[0].data_consulta, hojeISO);
  const cab = "Olá! 😊 Aqui é a Julia, da CBT Ortopedia. Ainda não recebemos a sua confirmação.";
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
  if (/\b(nao|n|remarc\w*|cancel\w*|desmarc\w*|adiar|adiant\w*|antecip\w*|mudar|trocar|outro|outra|atras\w*|mas|porem|so que|infelizmente|nem)\b/.test(t)) return false;
  return /^(?:(?:ok|okay|ola|oi|bom dia|boa tarde|boa noite)\s+)?(?:sim|s|ss|siim+|confirmo|confirmado|confirmada|confirmar|pode confirmar|esta confirmado|ta confirmado|confirmadissimo)\b/.test(t) ||
    /^(?:vou sim|estarei la|estarei presente|irei sim|vou estar la|presenca confirmada|com certeza)\b/.test(t);
}

/** Filtro de médico do teste: todas as palavras do filtro no nome (sem acento, sem caixa). Filtro vazio = todos. */
export function medicoDoFiltro(nomeMedico: unknown, filtro: string | null | undefined): boolean {
  const n = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  const f = n(filtro);
  if (!f) return true;
  const nome = n(nomeMedico);
  return f.split(" ").every((p) => nome.includes(p));
}
