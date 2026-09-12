// _shared/atendimento.ts — regras de atendimento humano compartilhadas.
//
// Fica em _shared porque DUAS funções precisam da mesma decisão: o
// whatsapp-webhook (que vê a mensagem chegar) e o human-transfer-timeout (o cron
// que devolve o ticket à fila). Se cada um tivesse sua cópia, elas divergiriam —
// e a divergência apareceria como ticket devolvido sem motivo, ou não devolvido
// quando devia, sem ninguém entender por quê.

// ─────────────────────────────────────────────────────────────────────────────
// DEVOLUÇÃO À FILA POR INATIVIDADE DA ATENDENTE (pedido do dono, 25/08)
// ─────────────────────────────────────────────────────────────────────────────
// Regra: paciente entra, fica pendente, uma atendente pega. Se ele PERGUNTA algo
// e ninguém responde dentro do prazo, o ticket volta para a fila de pendentes,
// para outra pessoa pegar. Prazo padrão 10 min; Vânia e Lidiane têm 1 hora.
//
// O ponto delicado é o "PERGUNTA algo". O dono foi explícito: se o paciente só
// mandou "obrigado", ou mandou um documento sem texto, NÃO pode devolver — não
// há nada a responder, e devolver criaria rodízio de ticket sem motivo, que é
// justamente a bagunça que ele quer evitar.
//
// Por que não reusar o ACK_REGEX do orphan-ack guard: ele cobre só
// sim|não|ok|certo|confirmo|👍, porque foi feito para outra pergunta ("isto é
// resposta a uma pergunta nossa?"). Agradecimento e despedida passam por ele —
// e são exatamente os casos que o dono citou.
//
// Desenho conservador de propósito: na dúvida, EXIGE resposta. O custo de
// devolver à fila sem precisar (alguém pega de novo) é muito menor que o de
// deixar paciente com pergunta esperando sem ninguém ver.

/** Tira acento, baixa a caixa e remove pontuação/emoji das bordas. */
function _normalizarCurta(s: string): string {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s\.\!\?\,\;\:\-\_\*\~]+$/g, "")
    .replace(/^[\s\.\!\?\,\;\:\-\_\*\~]+/g, "")
    .trim();
}

// Expressões que, SOZINHAS, encerram o assunto. Não é lista de palavras soltas:
// cada entrada precisa ser a mensagem INTEIRA. "obrigada, mas queria remarcar"
// tem conteúdo depois do agradecimento e continua exigindo resposta.
const _FECHAMENTOS = [
  // confirmação
  "sim", "nao", "s", "n", "ok", "okay", "okey", "certo", "confirmo", "confirmado",
  "isso", "isso mesmo", "exato", "exatamente", "positivo", "pode ser", "pode sim",
  "tudo bem", "ta bom", "tabom", "ta certo", "beleza", "blz", "combinado", "fechado",
  "perfeito", "otimo", "otima", "show", "top", "maravilha", "legal", "bacana",
  // agradecimento
  "obrigado", "obrigada", "obg", "obgd", "vlw", "valeu", "grato", "grata",
  "agradeco", "agradecida", "agradecido", "muito obrigado", "muito obrigada",
  "obrigado(a)", "obrigadao", "gratidao",
  // ciência
  "entendi", "entendido", "compreendi", "ciente", "anotado", "aguardo",
  "aguardando", "no aguardo", "ate mais", "ate logo", "ate breve", "tchau",
  "bom dia", "boa tarde", "boa noite", "abraco", "abracos", "bjs", "beijos",
];

/**
 * A última mensagem do paciente exige resposta de gente?
 *
 * `true`  → o relógio de inatividade corre; vencido, o ticket volta para a fila.
 * `false` → nada a responder; o ticket fica onde está.
 *
 * @param texto   texto da mensagem (transcrição, se for áudio)
 * @param temMidia se veio anexo (documento, foto, áudio)
 */
export function exigeRespostaDaAtendente(texto: unknown, temMidia = false): boolean {
  const bruto = typeof texto === "string" ? texto : "";

  // A interrogação é checada no texto BRUTO, antes de qualquer normalização —
  // _normalizarCurta apara pontuação das bordas, então "ok?" chegaria aqui como
  // "ok" e cairia na lista de fechamentos. Um teste pegou exatamente isso.
  // "ok?" e "certo?" são perguntas, não confirmações.
  if (bruto.includes("?")) return true;

  const t = _normalizarCurta(bruto);

  // Mídia sem texto: o paciente mandou o documento que pediram, uma foto de
  // exame, um comprovante. Não há pergunta — e devolver à fila por causa disso
  // foi o caso que o dono citou nominalmente.
  if (!t) return false;

  // Só encerra o assunto se a mensagem INTEIRA for um fechamento.
  if (_FECHAMENTOS.includes(t)) return false;

  // Fechamento + emoji ("obrigada 😊") ou repetido ("obrigada obrigada") ainda
  // encerra. O corte em 40 caracteres evita que uma frase longa que começa com
  // "obrigada" seja tratada como despedida.
  if (t.length <= 40) {
    const semEmoji = t.replace(/[\p{Extended_Pictographic}‍️]/gu, "").replace(/\s+/g, " ").trim();
    if (!semEmoji) return false;                       // só emoji
    if (_FECHAMENTOS.includes(semEmoji)) return false;
    // "obrigada, tchau" / "ok obrigada" — todas as partes são fechamento
    const partes = semEmoji.split(/[,;]|\s+e\s+/).map((p) => p.trim()).filter(Boolean);
    if (partes.length > 1 && partes.every((p) => _FECHAMENTOS.includes(p))) return false;
  }

  return true;
}

/**
 * Minutos de tolerância antes de devolver o ticket para a fila.
 *
 * Vânia e Lidiane têm 1 hora: elas tratam cirurgia, pós-operatório e
 * infiltração, onde a resposta costuma depender de conferir agenda de centro
 * cirúrgico ou falar com o médico. Devolver em 10 minutos tiraria o paciente de
 * quem está justamente resolvendo o caso dele.
 *
 * Comparação sem acento e sem caixa: o nome chega do Z-PRO com grafia variável
 * ("VÂNIA", "Vania", "vânia ").
 */
export function prazoDeRespostaEmMinutos(
  nomeAtendente: unknown,
  prazoPadrao = 10,
  prazoEstendido = 60,
  nomesEstendidos: string[] = ["vania", "lidiane"],
): number {
  const n = _normalizarCurta(typeof nomeAtendente === "string" ? nomeAtendente : "");
  if (!n) return prazoPadrao;
  const primeiro = n.split(/\s+/)[0];
  return nomesEstendidos.includes(primeiro) ? prazoEstendido : prazoPadrao;
}

// ─────────────────────────────────────────────────────────────────────────────
// VARREDURA DA FICHA — tirar o nome de quem foi embora (pedido do dono, 12/09)
// ─────────────────────────────────────────────────────────────────────────────
// A devolução por inatividade acima resolve UM caso: o paciente perguntou e
// ninguém respondeu no prazo. Ela não resolve o caso que o dono descreveu:
//
//   "algumas pessoas saem antes, às 4h da tarde. Fico preocupado com as pessoas
//    ir embora e não desligarem o offline, ou ir embora e não zerarem a ficha."
//
// Aí o ticket continua com o nome dela. Ninguém está esperando resposta AGORA —
// então a regra dos 10 minutos não dispara — mas quando o paciente escrever
// amanhã, a conversa cai na lista de quem não está mais lá.
//
// Medido em 12/09, no sábado de manhã, direto no Z-PRO (não no espelho):
//   • 13 tickets desta semana ainda abertos com nome de atendente
//   •  5 tickets em "pending" AINDA carregando o nome da Lidiane — pendente e
//      com dona ao mesmo tempo, que é literalmente "deixou na própria fila"
//   •  1 ticket aberto com a Vânia desde 23/03 (4.150 horas)
//   • nenhum ticket é fechado às 18h: o quadro dorme como estava
//   • a Laiz aparecia ONLINE no sábado ao meio-dia — saiu na sexta e o Z-PRO
//     nunca soube. É exatamente o "não desligar o offline".
//
// Por isso a decisão tem TRÊS prazos, do mais curto ao mais longo, e não um só:
// fora do expediente a clínica está fechada e ninguém está trabalhando aquilo;
// dona marcada offline é a evidência mais forte que existe de que ela saiu;
// e o prazo longo é a rede embaixo, para quando o Z-PRO acha que todo mundo
// ainda está online.
//
// Assimetria de propósito: só agimos com `donaOnline === false`. "Online" no
// Z-PRO é palpite (a Laiz prova isso); "offline" é alguém tendo dito que saiu.

export type LimitesDaFicha = {
  /** minutos sem mensagem nenhuma, dona online, dentro do expediente. 0 desliga a varredura inteira. */
  ocioso: number;
  /** minutos sem mensagem quando o Z-PRO diz que a dona está offline. */
  donaOffline: number;
  /** minutos sem mensagem com a clínica fechada. */
  foraDeExpediente: number;
  /** acima disto o ticket não é resíduo do dia, é arqueologia — não mexe. */
  idadeMaximaDias: number;
};

export const LIMITES_PADRAO_DA_FICHA: LimitesDaFicha = {
  ocioso: 120,
  donaOffline: 30,
  foraDeExpediente: 15,
  idadeMaximaDias: 7,
};

/**
 * A clínica está aberta neste instante?
 *
 * Fecha às 18h15, não às 18h: em 08–11/09 a Mardila respondeu às 18:02 e 18:04 e
 * a Vânia às 18:09. Cortar às 18h em ponto tiraria o ticket da mão de quem ainda
 * estava digitando. Abre às 7h30 pelo mesmo motivo do outro lado — Glaucia às
 * 07:41, Lidiane às 07:48.
 *
 * @param agora `diaDaSemana` 0=domingo … 6=sábado, hora/minuto em São Paulo.
 *              Vem por PARÂMETRO para a função continuar pura e testável.
 */
export function expedienteAberto(
  agora: { diaDaSemana: number; hora: number; minuto: number },
  abreMin = 7 * 60 + 30,
  fechaMin = 18 * 60 + 15,
): boolean {
  if (agora.diaDaSemana === 0 || agora.diaDaSemana === 6) return false;
  const m = agora.hora * 60 + agora.minuto;
  return m >= abreMin && m < fechaMin;
}

/**
 * Este ticket deve perder o dono e voltar para a fila de pendentes?
 *
 * Só decide — quem chama é que fala com o Z-PRO. Devolve o motivo junto para a
 * auditoria dizer POR QUE o ticket mudou de mão; sem isso a atendente abre o
 * painel, não acha o caso que era dela e ninguém sabe explicar.
 */
export function decideLiberarFicha(
  f: {
    /** o ticket tem nome de atendente? sem dono não há de quem tirar. */
    temDona: boolean;
    /** minutos desde a última mensagem, em QUALQUER direção. */
    ociosoMin: number;
    /** dias desde a última mensagem. */
    idadeDias: number;
    /** `false` = o Z-PRO confirmou que ela saiu. `true`/`null` = não confiamos. */
    donaOnline: boolean | null;
    expedienteAberto: boolean;
  },
  lim: LimitesDaFicha = LIMITES_PADRAO_DA_FICHA,
): { liberar: boolean; motivo: string } {
  if (lim.ocioso <= 0) return { liberar: false, motivo: "varredura_desligada" };
  if (!f.temDona) return { liberar: false, motivo: "sem_dona" };

  // Arqueologia não é resíduo do expediente. O ticket aberto com a Vânia desde
  // 23/03 não volta para a fila: jogá-lo em pendentes faria uma conversa de seis
  // meses atrás brotar no topo do quadro na segunda-feira, competindo por atenção
  // com quem está esperando hoje. Esses saem numa limpeza combinada, não sozinhos.
  if (f.idadeDias > lim.idadeMaximaDias) return { liberar: false, motivo: "velho_demais" };

  // Ordem do mais forte para o mais fraco: a clínica fechada vale mais que o
  // status da dona, e o status da dona vale mais que o relógio genérico.
  if (!f.expedienteAberto && f.ociosoMin >= lim.foraDeExpediente) {
    return { liberar: true, motivo: "fora_de_expediente" };
  }
  if (f.donaOnline === false && f.ociosoMin >= lim.donaOffline) {
    return { liberar: true, motivo: "dona_offline" };
  }
  if (f.ociosoMin >= lim.ocioso) {
    return { liberar: true, motivo: "ocioso" };
  }
  return { liberar: false, motivo: "dentro_do_prazo" };
}
