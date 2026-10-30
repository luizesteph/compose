// Infiltração liberada (30/10/2026, pedido do dono): a liberação nasce no PDF Visco, que só
// tem o NOME do paciente e o médico da guia. Telefone, CPF e e-mail vêm do Amigo, e a API do
// robô não busca por nome — por isso o índice amigo_agenda (paciente + médico, lido de
// GET /attendances?status=ALL). Medido em 30/10: 982 de 1.127 nomes de guia têm o mesmo
// nome na agenda; 4 têm homônimo.
//
// A regra que importa é a do médico: "exato" exige NOME e MÉDICO DA GUIA na agenda. Sem o
// médico, ou com nome só parecido, o telefone aparece marcado para conferir. Com homônimo
// que o médico não desempata, o telefone NÃO aparece: ligar para a pessoa errada e marcar
// com o médico errado é a confusão que a tela existe para evitar.

export type Casamento = "exato" | "conferir" | "ambiguo" | "nao_encontrado";

export interface LinhaDaAgenda {
  amigo_patient_id: number;
  medico_id: number;
  medico_nome: string | null;
  nome: string;
  celular: string | null;
  ultima_data: string;
  realizada: boolean;
}

export interface ResultadoDoCasamento {
  casamento: Casamento;
  amigo_patient_id: number | null;
  nome_amigo: string | null;
  celular: string | null;
  medico_confere: boolean;
  medico_amigo_id: number | null;
  ultima_consulta_medico: string | null;
  candidatos: number;
}

const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e"]);

/** minúsculas, sem acento, só letras e espaço */
export function nomeChave(t: unknown): string {
  return String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokensDoNome(t: unknown): string[] {
  return nomeChave(t).split(" ").filter((p) => p && !PARTICULAS.has(p));
}

/** "Dr. Hugo Bitencourt Fabri" e "Hugo Bitencourt Fabri" são o mesmo médico */
export function medicoChave(t: unknown): string {
  return tokensDoNome(t)
    .filter((p, i) => !(i === 0 && /^(dr|dra|doutor|doutora)$/.test(p)))
    .sort()
    .join(" ");
}

const chaveDoNome = (tokens: string[]) => [...tokens].sort().join(" ");

function distancia(a: string, b: string): number {
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(ant[j] + 1, atual[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    ant = atual;
  }
  return ant[b.length];
}

/** nome abreviado ("Maria Silva" × "Maria Aparecida Silva") ou erro de digitação de até 2 letras */
export function nomeParecido(a: string[], b: string[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const [curto, longo] = a.length <= b.length ? [a, b] : [b, a];
  if (curto[0] === longo[0] && curto[curto.length - 1] === longo[longo.length - 1] && curto.every((p) => longo.includes(p))) {
    return true;
  }
  if (a.length !== b.length || distancia(a[0], b[0]) > 1) return false;
  return distancia(a.join(" "), b.join(" ")) <= 2;
}

const digitos = (t: unknown) => String(t ?? "").replace(/\D/g, "");

function resultado(
  casamento: Casamento,
  linhas: LinhaDaAgenda[],
  doMedico: LinhaDaAgenda[],
  candidatos: number,
): ResultadoDoCasamento {
  const maisNova = [...(doMedico.length ? doMedico : linhas)].sort((x, y) => y.ultima_data.localeCompare(x.ultima_data))[0];
  const comCelular = [...linhas].sort((x, y) => y.ultima_data.localeCompare(x.ultima_data)).find((l) => digitos(l.celular));
  return {
    casamento,
    amigo_patient_id: maisNova?.amigo_patient_id ?? null,
    nome_amigo: maisNova?.nome ?? null,
    celular: comCelular?.celular ?? null,
    medico_confere: doMedico.length > 0,
    medico_amigo_id: doMedico[0]?.medico_id ?? null,
    ultima_consulta_medico: doMedico.length ? maisNova.ultima_data : null,
    candidatos,
  };
}

const SEM_ACHADO: ResultadoDoCasamento = {
  casamento: "nao_encontrado",
  amigo_patient_id: null,
  nome_amigo: null,
  celular: null,
  medico_confere: false,
  medico_amigo_id: null,
  ultima_consulta_medico: null,
  candidatos: 0,
};

const AMBIGUO = (candidatos: number): ResultadoDoCasamento => ({ ...SEM_ACHADO, casamento: "ambiguo", candidatos });

function porPessoa(linhas: LinhaDaAgenda[]): Map<number, LinhaDaAgenda[]> {
  const m = new Map<number, LinhaDaAgenda[]>();
  for (const l of linhas) m.set(l.amigo_patient_id, [...(m.get(l.amigo_patient_id) || []), l]);
  return m;
}

/** linhas do paciente com o médico da guia; atendimento cancelado não prova vínculo */
const comOMedico = (linhas: LinhaDaAgenda[], medico: string) =>
  linhas.filter((l) => l.realizada && medicoChave(l.medico_nome) === medico);

export interface AgendaPreparada {
  porNome: Map<string, LinhaDaAgenda[]>;
  porMedico: Map<string, Array<{ linha: LinhaDaAgenda; tokens: string[] }>>;
}

/** normaliza a agenda UMA vez: são ~15 mil linhas, e refazer isso por paciente estoura a CPU da função */
export function prepararAgenda(linhas: LinhaDaAgenda[]): AgendaPreparada {
  const a: AgendaPreparada = { porNome: new Map(), porMedico: new Map() };
  const chaveDoMedico = new Map<string, string>();
  for (const linha of linhas) {
    const tokens = tokensDoNome(linha.nome);
    const nome = chaveDoNome(tokens);
    const lista = a.porNome.get(nome);
    if (lista) lista.push(linha);
    else a.porNome.set(nome, [linha]);
    const bruto = String(linha.medico_nome ?? "");
    let medico = chaveDoMedico.get(bruto);
    if (medico === undefined) {
      medico = medicoChave(bruto);
      chaveDoMedico.set(bruto, medico);
    }
    if (!linha.realizada) continue;
    const doMedico = a.porMedico.get(medico);
    if (doMedico) doMedico.push({ linha, tokens });
    else a.porMedico.set(medico, [{ linha, tokens }]);
  }
  return a;
}

export function casarPaciente(
  nomeGuia: string,
  medicoGuia: string,
  agenda: LinhaDaAgenda[] | AgendaPreparada,
): ResultadoDoCasamento {
  const alvo = tokensDoNome(nomeGuia);
  const medico = medicoChave(medicoGuia);
  if (!alvo.length) return SEM_ACHADO;
  const preparada = Array.isArray(agenda) ? prepararAgenda(agenda) : agenda;

  const iguais = preparada.porNome.get(chaveDoNome(alvo)) ?? [];
  if (iguais.length) {
    const pessoas = [...porPessoa(iguais).values()];
    if (pessoas.length === 1) {
      const doMedico = comOMedico(pessoas[0], medico);
      return resultado(doMedico.length ? "exato" : "conferir", pessoas[0], doMedico, 1);
    }
    // homônimo: quem desempata é o médico da guia
    const doMedico = pessoas.filter((p) => comOMedico(p, medico).length);
    if (doMedico.length === 1) return resultado("exato", doMedico[0], comOMedico(doMedico[0], medico), pessoas.length);
    // cadastro duplicado da mesma pessoa: mesmo celular em todos
    const celulares = new Set(iguais.map((l) => digitos(l.celular)).filter(Boolean));
    if (doMedico.length > 1 && celulares.size === 1) {
      const todas = doMedico.flat();
      return resultado("exato", todas, comOMedico(todas, medico), pessoas.length);
    }
    return AMBIGUO(pessoas.length);
  }

  // nome só parecido vale apenas entre os pacientes do médico da guia
  const parecidos = (preparada.porMedico.get(medico) ?? []).filter((x) => nomeParecido(alvo, x.tokens)).map((x) => x.linha);
  if (!parecidos.length) return SEM_ACHADO;
  const pessoas = [...porPessoa(parecidos).values()];
  if (pessoas.length > 1) return AMBIGUO(pessoas.length);
  return resultado("conferir", pessoas[0], pessoas[0], 1);
}

interface AtendimentoDoAmigo {
  patient?: { id?: unknown; name?: unknown; contact_cellphone?: unknown } | null;
  user?: { id?: unknown; name?: unknown } | null;
  start_date?: unknown;
  status?: unknown;
  canceled?: unknown;
}

/** GET /attendances → linhas de amigo_agenda; sem paciente ou sem médico não entra */
export function linhasDaAgenda(lista: AtendimentoDoAmigo[]): Array<Record<string, unknown>> {
  const saida: Array<Record<string, unknown>> = [];
  for (const a of lista) {
    const pid = Number(a.patient?.id);
    const mid = Number(a.user?.id);
    const nome = String(a.patient?.name ?? "").trim();
    const data = String(a.start_date ?? "").slice(0, 10);
    if (!pid || !mid || !nome || !/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;
    saida.push({
      amigo_patient_id: pid,
      medico_id: mid,
      medico_nome: String(a.user?.name ?? "").trim() || null,
      nome,
      nome_chave: nomeChave(nome),
      celular: digitos(a.patient?.contact_cellphone) || null,
      data,
      realizada: !(a.canceled || String(a.status ?? "").toLowerCase() === "canceled"),
    });
  }
  return saida;
}

/** health_insurance do Amigo vem como texto ou objeto */
export function convenioDaFicha(h: unknown): string | null {
  if (typeof h === "string") return h.trim() || null;
  if (h && typeof h === "object") {
    const n = (h as { name?: unknown }).name;
    return typeof n === "string" && n.trim() ? n.trim() : null;
  }
  return null;
}

// Depois da liberação (30/10/2026, pedido do dono): a Julia AVISA o paciente e não marca.
// A infiltração é marcada por uma atendente ("Ele pode ligar também, já sabe o telefone da
// clínica"). A tabela acompanha o resto: agendado vem do Amigo, feita é confirmada por gente.
//
// O Amigo não tem tipo "infiltração": a equipe marca como consulta com o médico da guia
// (conferido em 30/10: Dr. Hugo 27/10 10:45 e Dr. Cristian 22/10 17:00, os dois com o horário
// que a Lidiane e a Vânia escreveram ao paciente). Por isso "agendado" é atendimento não
// cancelado com o médico da guia DEPOIS da liberação; uma consulta comum com ele também conta.

export const TELEFONE_DA_CLINICA = "(11) 5044-3566";
export const INTENT_AVISO_DE_LIBERACAO = "liberado_aviso";

/** O GET /attendances recusa janela de mais de 90 dias (400 VALIDATION_ERROR em end_date) */
export const AGENDA_DIAS_ANTES = 8;
export const AGENDA_DIAS_DEPOIS = 80;

const INICIO_DO_AVISO_MIN = 8 * 60 + 30;
const FIM_DO_AVISO_MIN = 17 * 60 + 30;

export function primeiroNome(nome: unknown): string {
  const p = String(nome ?? "").trim().split(/\s+/)[0] ?? "";
  return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : "";
}

export function textoAvisoDeLiberacao(nome: unknown, medicos: string[]): string {
  const n = primeiroNome(nome);
  const unicos = [...new Set(medicos.map((m) => String(m ?? "").trim()).filter(Boolean))];
  const comQuem = unicos.length === 1 ? ` com ${unicos[0]}` : "";
  return `Olá${n ? `, ${n}` : ""}! Aqui é da CBT Ortopedia. 😊 Sua infiltração${comQuem} foi liberada e você já pode agendar. ` +
    `Quer marcar? É só responder por aqui que uma das nossas atendentes continua com você, ou, se preferir, ligar para ${TELEFONE_DA_CLINICA}.`;
}

/** 55 + DDD + celular com o 9; fixo não recebe WhatsApp */
export function celularParaEnvio(tel: unknown): string | null {
  let d = digitos(tel);
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  return d.length === 11 && d[2] === "9" ? `55${d}` : null;
}

/** seg-sex, 8h30-17h30, fora de feriado: a resposta tem que encontrar a equipe na clínica */
export function podeAvisarAgora(a: { diaDaSemana: number; minutos: number; feriado: boolean }): boolean {
  if (a.feriado || a.diaDaSemana < 1 || a.diaDaSemana > 5) return false;
  return a.minutos >= INICIO_DO_AVISO_MIN && a.minutos < FIM_DO_AVISO_MIN;
}

export interface LiberadoParaAviso {
  casamento: string;
  telefone: string | null;
  validade_guia: string | null;
  aviso_enviado_em: string | null;
  agendado_para: string | null;
  feita_em: string | null;
}

/** Só quem tem certeza de nome e médico, guia em dia e nada marcado ainda */
export function recebeAviso(l: LiberadoParaAviso, hojeISO: string): boolean {
  if (l.casamento !== "exato" || l.aviso_enviado_em || l.agendado_para || l.feita_em) return false;
  if (!l.validade_guia || l.validade_guia.slice(0, 10) < hojeISO) return false;
  return celularParaEnvio(l.telefone) !== null;
}

const horaLocalSP = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T").slice(0, 16);

interface AtendimentoParaAgendado extends AtendimentoDoAmigo {
  patient_id?: unknown;
  agenda_event?: { name?: unknown } | null;
}

/** o primeiro atendimento vivo com o médico da guia depois da liberação */
export function agendamentoDoLiberado(
  l: { amigo_patient_id: number | null; medico_amigo_id: number | null; medico_nome: string; liberado_em: string },
  lista: AtendimentoParaAgendado[],
): { agendado_para: string; agendado_tipo: string | null } | null {
  if (!l.amigo_patient_id) return null;
  const desde = horaLocalSP(l.liberado_em);
  const medico = medicoChave(l.medico_nome);
  const achados = lista
    .filter((a) => {
      if (Number(a.patient_id ?? a.patient?.id) !== Number(l.amigo_patient_id)) return false;
      const situacao = String(a.status ?? "").toLowerCase();
      if (a.canceled || situacao === "canceled" || situacao === "missed") return false;
      const mesmoMedico = l.medico_amigo_id
        ? Number(a.user?.id) === Number(l.medico_amigo_id)
        : medicoChave(a.user?.name) === medico;
      return mesmoMedico && String(a.start_date ?? "").slice(0, 16) >= desde;
    })
    .sort((x, y) => String(x.start_date).localeCompare(String(y.start_date)));
  if (!achados.length) return null;
  return {
    agendado_para: String(achados[0].start_date).slice(0, 16),
    agendado_tipo: String(achados[0].agenda_event?.name ?? "").trim() || null,
  };
}

/**
 * Liberado com a marcação em aberto não é agendado pela Julia: "agendar" e "cadastrar" vão
 * para a atendente. "unknown" só vai se ele está respondendo ao aviso ("sim", "pode ser"),
 * e agradecimento não abre ticket para ninguém.
 */
export function liberadoVaiParaAtendente(a: {
  intent: string;
  respondendoAoAviso: boolean;
  soAgradecimento: boolean;
}): boolean {
  if (a.soAgradecimento) return false;
  if (a.intent === "agendar" || a.intent === "cadastrar") return true;
  return a.intent === "unknown" && a.respondendoAoAviso;
}
