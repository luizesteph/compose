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
