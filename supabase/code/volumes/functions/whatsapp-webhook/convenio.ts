// convenio.ts — o que o PACIENTE disse sobre o convênio, e o que a clínica faz com isso.
//
// Módulo estrito (sem @ts-nocheck). O nome vem antes de helpers.ts na ordem alfabética de
// propósito: a suíte de regressão junta os módulos num arquivo só, e um import de helpers
// só passa se vier antes das declarações dele (como em guards.ts).
// insurance.ts continua cuidando do cadastro do Amigo (grupo × plano) e da guarda de
// afirmação de cobertura.

import { semMetadados, pacienteDisseParticular, respostaSimOuNao, portoPlanoNaoAtendido } from "./helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CONVÊNIO DECIDIDO ANTES DA LISTA DE HORÁRIOS (16/11/2026, etapa 4 do plano de 15/11)
// ─────────────────────────────────────────────────────────────────────────────
// O que o paciente DISSE sobre o convênio era lido em pontos diferentes, cada um com a
// sua regra: a guarda de afirmação olha a resposta da Julia; o cadastro olha o que o
// classificador extraiu; a pergunta de cobertura olha só a mensagem atual. Três falhas:
//   • Sophia (10/11): "pelo convênio Hapvida" + "plano SMART 500" → lista, reserva, CPF,
//     cadastro e só então "esse plano eu preciso confirmar". A clínica não atende.
//   • Renata (15/11): "Convenio medsenior black 3" → o CLASSIFICADOR escreveu
//     insurance_choice="particular" na mensagem da data de nascimento; a consulta saiu
//     como particular sem ela dizer ("Particular não", respondeu depois).
//   • 16/11: dois cadastros com "Porto Seguro P320" e "P470 Q" marcados PELO CONVÊNIO, em
//     planos que a clínica não atende (o cadastro pegava o primeiro plano do grupo).
// Aqui fica a leitura única: só as falas do paciente, a mais recente manda. A tabela é a
// do script da clínica (seção "Convênios e Planos"); mudou lá, muda aqui.

type ClasseDeConvenio = "todos" | "bradesco" | "notredame" | "porto" | "reembolso";

// Padrões SEM acento (o texto é normalizado antes). `contexto`: nome que também é nome de
// gente ou de lugar só conta na frase que fala de convênio ou plano.
const CATALOGO_DE_CONVENIOS: Array<{ nome: string; re: RegExp; classe: ClasseDeConvenio; contexto?: boolean }> = [
  { nome: "SulAmérica", re: /\bsul\s*am[ei]+rica\b|\bsula\s+am[ei]+rica\b/, classe: "todos" },
  { nome: "Care Plus", re: /\bcare\s*plus\b/, classe: "todos" },
  { nome: "Gama Saúde", re: /\bgama\b/, classe: "todos", contexto: true },
  { nome: "Mediservice", re: /\bmedi\s*service\b/, classe: "todos" },
  { nome: "Omint", re: /\bomint\b/, classe: "todos" },
  { nome: "Bradesco", re: /\bbradesco\b/, classe: "bradesco" },
  { nome: "Notre Dame / Hapvida", re: /\bnotre\s*dam+e\b|\bhapvida\b|\bintermedica\b|\bgndi\b/, classe: "notredame" },
  { nome: "Porto Seguro", re: /\bporto\s+(?:seguro|saude)\b|\bp\s*-?\s*(?:220|320|470)\s*-?\s*q?\b/, classe: "porto" },
  { nome: "Porto Seguro", re: /\bporto\b/, classe: "porto", contexto: true },
  { nome: "Amil", re: /\bamil\b|\blincx\b|\bone\s+health\b/, classe: "reembolso" },
  { nome: "Unimed", re: /\bunimed\b/, classe: "reembolso" },
  { nome: "Prevent Senior", re: /\bprevent(?:\s+senior)?\b/, classe: "reembolso" },
  { nome: "MedSênior", re: /\bmed\s*senior\b/, classe: "reembolso" },
  { nome: "Alice", re: /(?<!\b(?:dra?|doutora?|sra?)\.?\s)\balice\b/, classe: "reembolso", contexto: true },
  { nome: "Cassi", re: /\bcassi\b/, classe: "reembolso" },
  { nome: "Bluemed", re: /\bblue\s*med\b/, classe: "reembolso" },
  { nome: "Saúde Caixa", re: /\bsaude\s+caixa\b/, classe: "reembolso" },
  { nome: "Golden Cross", re: /\bgolden\s+cross\b/, classe: "reembolso" },
  { nome: "Allianz", re: /\ballianz\b/, classe: "reembolso" },
];
const CONTEXTO_DE_CONVENIO_RE = /\b(?:convenio|plano|carteirinha|seguro\s+saude)\b/;

function _normConvenio(s: unknown): string {
  return semMetadados(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Os convênios que a fala cita (sem repetir). */
function conveniosDaFala(falaNormalizada: string): Array<{ nome: string; classe: ClasseDeConvenio }> {
  const temContexto = CONTEXTO_DE_CONVENIO_RE.test(falaNormalizada);
  const achados: Array<{ nome: string; classe: ClasseDeConvenio }> = [];
  for (const c of CATALOGO_DE_CONVENIOS) {
    if (c.contexto && !temContexto) continue;
    if (!c.re.test(falaNormalizada)) continue;
    if (!achados.some((a) => a.nome === c.nome)) achados.push({ nome: c.nome, classe: c.classe });
  }
  return achados;
}

/** "Particular não", "não quero particular", "no particular não consigo": recusa, não aceite. */
export function pacienteRecusouParticular(texto: unknown): boolean {
  const t = _normConvenio(texto);
  return /\bparticular\s*,?\s+nao\b(?!\s+tem\s+problema)|\bnao\s+(?:quero|vou|posso|consigo|tenho\s+como|da|pretendo|gostaria)\b[^.!?\n]{0,30}\bparticular\b|\bsem\s+ser\s+particular\b/.test(t);
}

export type VeredictoDoConvenioDito =
  | { tipo: "nada" }
  | { tipo: "particular" }
  | { tipo: "atendido"; convenio: string }
  | { tipo: "nao_atendido"; convenio: string; motivo: "plano" | "reembolso"; plano?: string }
  | { tipo: "equipe_confirma"; convenio: string }
  | { tipo: "sem_plano"; convenio: string }
  | { tipo: "efetivo" };

/**
 * O que o PACIENTE disse sobre o convênio. `falas` em ordem (a mais antiga primeiro), só
 * o que ele escreveu. A fala mais recente que cita convênio (ou "particular") decide; o
 * plano pode vir nela ou nas falas seguintes ("Hapvida" → "plano SMART 500").
 */
export function vereditoDoConvenioDito(falas: ReadonlyArray<unknown>): VeredictoDoConvenioDito {
  const lista = (falas || []).map(_normConvenio).filter((f) => f.trim().length > 0).slice(-12);
  for (let i = lista.length - 1; i >= 0; i--) {
    const fala = lista[i];
    const convenios = conveniosDaFala(fala);
    const particular = pacienteDisseParticular(fala) && !pacienteRecusouParticular(fala);
    if (convenios.length === 0) {
      if (particular) return { tipo: "particular" };
      continue;
    }
    if (particular) return { tipo: "particular" }; // "Convênio Amil… vai ser particular"
    if (convenios.length > 1) return { tipo: "nada" }; // "mudou de SulAmérica para Amil": não decido
    const { nome, classe } = convenios[0];
    const plano = lista.slice(i).join("\n");
    if (classe === "todos") return { tipo: "atendido", convenio: nome };
    if (classe === "reembolso") return { tipo: "nao_atendido", convenio: nome, motivo: "reembolso" };
    if (classe === "porto") {
      const p = portoPlanoNaoAtendido(plano);
      return p ? { tipo: "nao_atendido", convenio: nome, motivo: "plano", plano: p } : { tipo: "equipe_confirma", convenio: nome };
    }
    if (classe === "bradesco") {
      if (/\befetivo\b/.test(plano)) return { tipo: "efetivo" };
      if (/\benfermaria\b/.test(plano)) return { tipo: "equipe_confirma", convenio: nome };
      if (/\b(?:nacional|top)\b/.test(plano)) return { tipo: "atendido", convenio: nome };
      const disseAlgumPlano = /\b(?:flex|ideal|preferencial|premium|perfil|exclusivo|empresarial|copart\w*|basico|standard|hospitalar|multi|livre\s+escolha)\b|\bplano\s*:?\s*[a-z]{3,}/.test(plano);
      return disseAlgumPlano ? { tipo: "equipe_confirma", convenio: nome } : { tipo: "sem_plano", convenio: nome };
    }
    // Notre Dame / Hapvida: 900 e 1000 atendidos; 800 a equipe confirma (resposta da equipe
    // em 10/11: "atendemos a partir do premium 800" — o script diz 900 e 1000); abaixo disso
    // e as linhas Smart/Advance/Mix/Clássico não. Número só conta colado ao
    // plano: a conversa tem data, hora e CPF.
    if (/\b(?:900|1000)\b/.test(plano)) return { tipo: "atendido", convenio: nome };
    if (/\b800\b/.test(plano)) return { tipo: "equipe_confirma", convenio: nome };
    const linha = /\b(advance|smart|nosso\s+plano|mix|classico)\b/.exec(plano);
    const numero = /\b(?:plano|premium|notre\s*dam+e|hapvida|intermedica|gndi)\b[^\n\d]{0,25}\b(\d{3})\b(?![\/:.\d])/.exec(plano);
    if (linha || (numero && Number(numero[1]) < 800)) {
      return { tipo: "nao_atendido", convenio: nome, motivo: "plano", plano: (linha?.[1] || numero?.[1] || "").trim() };
    }
    return /\bpremium\b/.test(plano) ? { tipo: "equipe_confirma", convenio: nome } : { tipo: "sem_plano", convenio: nome };
  }
  return { tipo: "nada" };
}

/**
 * O texto que sai NO LUGAR da lista de horários (ou do cadastro) quando o convênio ou o
 * plano dito não é atendido. Sem fila: informa, dá a alternativa do script e pergunta.
 * `horario` — "dd/mm às HH:MM" quando o paciente já escolheu um.
 * De propósito sem "atendemos", "pelo convênio" e "pelo plano": a guarda de afirmação de
 * cobertura lê essas palavras como promessa e trocaria o texto.
 */
export function textoConvenioNaoAtendido(
  v: Extract<VeredictoDoConvenioDito, { tipo: "nao_atendido" }>,
  preco: string | null,
  horario?: string | null,
  paraConfirmar?: boolean,
): string {
  const valor = preco ? ` (${preco})` : "";
  const alternativa =
    `A consulta pode ser *particular*${valor}, e a gente fornece a nota fiscal para você pedir o reembolso ao seu plano.`;
  const pergunta = horario
    ? `Quer que eu ${paraConfirmar ? "confirme" : "siga com"} o horário de ${horario} como particular?`
    : "Quer que eu veja os horários como particular?";
  let abertura: string;
  if (v.motivo === "reembolso") {
    abertura = `A ${v.convenio} não está entre os convênios da clínica. 🙏`;
  } else if (v.convenio === "Porto Seguro") {
    abertura = `Esse plano da Porto Seguro${v.plano ? ` (${v.plano})` : ""} a clínica não atende. 🙏`;
  } else {
    abertura = `Esse plano da ${v.convenio} a clínica não atende. 🙏`;
  }
  return `${abertura} ${alternativa} ${pergunta}`;
}

/** A pergunta que fecha o texto acima — o "sim" a ela autoriza o particular. */
export const PERGUNTA_COMO_PARTICULAR_RE = /como particular\?\s*$/i;
/** …e qual fluxo perguntou: "confirme o horário" é o cadastro; "siga com"/"veja os horários" é a marcação. */
export const PERGUNTA_PARTICULAR_DO_CADASTRO_RE = /Quer que eu confirme (?:o horário de [^?]{4,30} )?como particular\?\s*$/i;

/** A Julia já explicou que é particular com reembolso? (a lista de convênios do cadastro não é explicação) */
export function jaExplicouParticular(falasDaJulia: ReadonlyArray<unknown>): boolean {
  return (falasDaJulia || []).some((f) => {
    const t = _normConvenio(f);
    // "Não atendemos o plano smart" (a atendente, 10/11) também conta: já foi dito
    return /\breembolso\b/.test(t) || /\bnao\s+esta\s+entre\s+os\s+convenios\b/.test(t) || /\bnao\s+atende(?:mos)?\b/.test(t);
  });
}

/**
 * O paciente autorizou marcar como particular? Vale a palavra DELE ("particular", "sem
 * convênio", "reembolso") ou o "sim" à pergunta "… como particular?" — e só o que veio
 * depois de ele dizer o convênio. O "particular" escrito pelo classificador não conta.
 */
export function particularAutorizado(
  historico: ReadonlyArray<{ role?: string; content?: unknown }> | null | undefined,
  mensagemAtual: unknown,
): boolean {
  const msgs: Array<{ role: string; t: string }> = (Array.isArray(historico) ? historico : [])
    .slice(-30)
    .map((m) => ({ role: String(m?.role || ""), t: semMetadados(m?.content) }));
  const atual = semMetadados(mensagemAtual);
  const ultimaDoPaciente = [...msgs].reverse().find((m) => m.role === "user");
  if (atual && ultimaDoPaciente?.t !== atual) msgs.push({ role: "user", t: atual });

  let desde = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user" && conveniosDaFala(_normConvenio(msgs[i].t)).length > 0) {
      desde = i;
      break;
    }
  }
  let autorizado = false;
  for (let i = desde; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    const t = msgs[i].t;
    if (pacienteRecusouParticular(t)) {
      autorizado = false;
      continue;
    }
    if (pacienteDisseParticular(t)) {
      autorizado = true;
      continue;
    }
    const anterior = [...msgs.slice(0, i)].reverse().find((m) => m.role === "assistant");
    if (anterior && PERGUNTA_COMO_PARTICULAR_RE.test(anterior.t.trim())) {
      const r = respostaSimOuNao(t);
      if (r === "sim") autorizado = true;
      else if (r === "nao") autorizado = false;
    }
  }
  return autorizado;
}

/** A explicação já foi dada e o paciente ainda não respondeu: a pergunta sozinha, sem repetir tudo. */
export function textoSoFaltaOParticular(preco: string | null, horario?: string | null): string {
  const valor = preco ? ` (${preco})` : "";
  return horario
    ? `Para eu concluir: a consulta fica como *particular*${valor}. Quer que eu confirme o horário de ${horario} como particular?`
    : `Para eu concluir: a consulta fica como *particular*${valor}. Quer que eu confirme como particular?`;
}

/** "Não vou prosseguir", "não vou agendar", "deixa pra lá": desistiu depois de saber que é particular. */
export function desistiuDeMarcar(texto: unknown): boolean {
  const t = _normConvenio(texto);
  return /\bnao\s+(?:vou|quero|irei|pretendo)\s+(?:mais\s+)?(?:prosseguir|agendar|marcar|seguir|continuar)\b|\bdeixa\s+(?:pra\s+la|para\s+la|quieto)\b|\bvou\s+(?:ver|procurar|tentar)\s+(?:em\s+)?outr[oa]\b|\bdesisto\b/.test(t);
}

// RECUSA DITA COM OUTRAS PALAVRAS (24/11, Rodrigo 23/11). A Julia (pelo modelo) disse "não
// atende a Unimed Seguros diretamente… pode ser realizada no particular… Quer que eu veja um
// horário?" e ele respondeu "o reembolso é muito pequeno, estou buscando alguém que atenda o
// plano diretamente". Nem a pergunta terminava em "como particular?" nem a resposta dizia
// "particular não": o modelo prometeu a equipe e a ficha foi para a fila. É a mesma recusa.
export function ofereceuParticularPorNaoAtender(falaDaJulia: unknown): boolean {
  const t = _normConvenio(falaDaJulia);
  return /\bparticular\b/.test(t) && /\bnao\s+(?:atende|atendemos|esta\s+entre|e\s+atendid[oa]|aceita|aceitamos|trabalha|trabalhamos)\b/.test(t) && /\?\s*$/.test(String(falaDaJulia ?? "").trim());
}
export function recusaPorQuererOConvenio(texto: unknown): boolean {
  const t = _normConvenio(texto);
  if (t.includes("?")) return false;
  // "o reembolso é pequeno, mas quero marcar mesmo assim" é aceite, não recusa
  if (/\bmesmo\s+assim\b|\b(?:quero|vou|pode|podemos|vamos)\s+(?:sim|marcar|agendar|seguir|ver|ser)\b/.test(t)) return false;
  return /\b(?:busc|procur)\p{L}*\b[^.!?\n]{0,40}\b(?:atend|aceit)\p{L}*\b[^.!?\n]{0,25}\b(?:plano|convenio|direto|diretamente)\b/u.test(t) ||
    /\breembolso\b[^.!?\n]{0,25}\b(?:muito\s+)?(?:pequeno|baixo|pouco|nao\s+compensa|nao\s+vale)\b/.test(t) ||
    /\bso\s+(?:pelo|pela|com\s+o|no|se\s+for\s+pelo)\s+(?:plano|convenio)\b/.test(t);
}

export const TEXTO_NAO_MARQUEI_SEM_PARTICULAR =
  "Sem problema — não marquei nada. 😊 Se mudar de ideia, ou se tiver outro convênio, é só me dizer por aqui.";
