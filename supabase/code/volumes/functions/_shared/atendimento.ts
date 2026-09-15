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
// ── O PRIMEIRO DIA INTEIRO (seg 14/09) MOSTROU DOIS ERROS MEUS ─────────────────
//
// 1. PINGUE-PONGUE. O tempo parado era medido pela ÚLTIMA MENSAGEM do ticket.
//    Quando a atendente pegava um ticket antigo da fila, ele continuava "parado
//    há 14 horas" — e dois minutos depois a varredura tirava o ticket dela de
//    novo. 74 liberações em só 46 tickets: 43 foram repetição. A Glaucia pegou o
//    #228408 cinco vezes entre 7h42 e 8h06; o #228823 voltou seis vezes. Em 12
//    casos a dona respondeu logo depois — estava trabalhando naquilo.
//    Correção: o relógio conta do MAIS RECENTE entre última mensagem, última
//    atualização do ticket (pegar o ticket atualiza) e a última vez que ESTA
//    varredura liberou o mesmo ticket. Pegou, ganha o prazo inteiro.
//
// 2. "OFFLINE" NÃO PROVA QUE SAIU. Eu tinha escrito que só o offline era
//    confiável. Não é: o Z-PRO marcou a Lidiane como OFFLINE o dia inteiro e ela
//    respondeu 82 mensagens entre 7h34 e 17h32 — perdeu 18 tickets por isso. Com
//    a Laiz ONLINE num sábado ao meio-dia (12/09), o status não vale para lado
//    nenhum. A regra do offline saiu. Ficam as duas que não dependem dele:
//    clínica fechada, e ticket parado demais.
//
// Assimetria de propósito que continua valendo: um prazo zerado DESLIGA a regra
// dele — nunca vira "libera na hora". Com `>= 0` sempre verdadeiro, um zero posto
// para desligar faria exatamente o contrário.

export type LimitesDaFicha = {
  /** minutos parado dentro do expediente. 0 desliga a varredura INTEIRA. */
  ocioso: number;
  /** minutos parado com a clínica fechada. 0 desliga só esta regra. */
  foraDeExpediente: number;
  /** acima disto (desde a última mensagem) não é resíduo do dia, é arqueologia — não mexe. */
  idadeMaximaDias: number;
};

export const LIMITES_PADRAO_DA_FICHA: LimitesDaFicha = {
  ocioso: 120,
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
 * Há quantos minutos NINGUÉM mexe neste ticket.
 *
 * Conta do mais recente dos três sinais — é isto que acaba com o pingue-pongue:
 * - a última mensagem (paciente, atendente ou Julia);
 * - a última atualização do ticket no Z-PRO (assumir o ticket atualiza);
 * - a última vez que a varredura liberou este mesmo ticket. Este é o cinto de
 *   segurança: mesmo que o Z-PRO não atualize o ticket quando alguém o pega, o
 *   ticket só pode ser liberado de novo depois de um prazo inteiro.
 * Valor ausente, inválido ou no futuro (relógio torto) não conta.
 */
export function minutosParado(s: {
  agoraMs: number;
  ultimaMensagemMs?: number | null;
  atualizadoMs?: number | null;
  ultimaLiberacaoMs?: number | null;
}): number {
  const validos = [s.ultimaMensagemMs, s.atualizadoMs, s.ultimaLiberacaoMs]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0 && v <= s.agoraMs);
  if (!validos.length) return 0;
  return (s.agoraMs - Math.max(...validos)) / 60000;
}

/**
 * Telefone do paciente a partir das mensagens de um ticket (showAllMessages).
 *
 * Em 14/09, 58 das 74 linhas de auditoria saíram SEM telefone: as mensagens
 * enviadas pela clínica vêm com `remoteJid: ""`, e o código pegava a primeira
 * string que aparecia — a vazia. Agora só vale identificador com cara de
 * telefone; `@lid` é id interno do WhatsApp, não número. Sem remoteJid bom, tenta
 * o `chatid` de dentro do `dataJson`.
 */
export function telefoneDasMensagens(msgs: unknown): string | null {
  if (!Array.isArray(msgs)) return null;
  const candidatos: string[] = [];
  for (const m of msgs as Array<Record<string, unknown>>) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.remoteJid === "string") candidatos.push(m.remoteJid);
    if (typeof m.dataJson === "string" && m.dataJson.includes("chatid")) {
      try {
        const dj = JSON.parse(m.dataJson) as Record<string, unknown>;
        if (typeof dj.chatid === "string") candidatos.push(dj.chatid);
      } catch { /* dataJson malformado: ignora */ }
    }
  }
  for (const c of candidatos) {
    if (!c || c.includes("@lid") || c.includes("@g.us")) continue;
    const so = c.split("@")[0].replace(/\D/g, "");
    if (so.length >= 10 && so.length <= 13) return so;
  }
  return null;
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
    /** minutos parado — use `minutosParado`, nunca só a última mensagem. */
    ociosoMin: number;
    /** dias desde a última MENSAGEM (idade da conversa, não do ticket). */
    idadeDias: number;
    expedienteAberto: boolean;
  },
  lim: LimitesDaFicha = LIMITES_PADRAO_DA_FICHA,
): { liberar: boolean; motivo: string } {
  if (!(lim.ocioso > 0)) return { liberar: false, motivo: "varredura_desligada" };
  if (!f.temDona) return { liberar: false, motivo: "sem_dona" };

  // Arqueologia não é resíduo do expediente. O ticket aberto com a Vânia desde
  // 23/03 não volta para a fila: jogá-lo em pendentes faria uma conversa de seis
  // meses atrás brotar no topo do quadro na segunda-feira, competindo por atenção
  // com quem está esperando hoje. Esses saem numa limpeza combinada, não sozinhos.
  if (f.idadeDias > lim.idadeMaximaDias) return { liberar: false, motivo: "velho_demais" };

  if (lim.foraDeExpediente > 0 && !f.expedienteAberto && f.ociosoMin >= lim.foraDeExpediente) {
    return { liberar: true, motivo: "fora_de_expediente" };
  }
  if (f.ociosoMin >= lim.ocioso) {
    return { liberar: true, motivo: "ocioso" };
  }
  return { liberar: false, motivo: "dentro_do_prazo" };
}
