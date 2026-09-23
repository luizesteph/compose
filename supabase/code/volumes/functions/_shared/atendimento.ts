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
  nomesEstendidos: string[] = Object.keys(ATENDENTES_DE_CASO_LONGO),
): number {
  const n = _normalizarCurta(typeof nomeAtendente === "string" ? nomeAtendente : "");
  if (!n) return prazoPadrao;
  const primeiro = n.split(/\s+/)[0];
  return nomesEstendidos.includes(primeiro) ? prazoEstendido : prazoPadrao;
}

// ─────────────────────────────────────────────────────────────────────────────
// CASO LONGO — Vânia e Lidiane vão para pendentes UMA vez (pedido do dono, 15/09)
// ─────────────────────────────────────────────────────────────────────────────
// "Os pacientes da Vânia e da Lidiane podem estar precisando de ajuda realmente,
//  mas não pode ficar transferindo várias vezes. Transfere uma vez para
//  pendentes e, caso as meninas vejam que não tem urgência, volta para elas —
//  as respostas delas são de longa duração, às vezes dias."
//
// Três caminhos tiravam o paciente delas, cada um por conta própria e sem saber
// do outro: a Julia (pedido de atendente), a devolução por inatividade (60 min)
// e a varredura da ficha (2h). Medido de 08 a 15/09: 187 idas para pendentes de
// pacientes das duas, 129 com a mesma conversa já passada pela fila nos 7 dias
// anteriores — 57 da Julia, 64 da inatividade, 8 da varredura. Um paciente da
// Vânia foi para a fila SEIS vezes em quatro minutos (15/09, 8h36–8h40).
//
// A regra é uma só para os três: caso da Vânia ou da Lidiane que já passou pela
// fila nos últimos 7 dias fica com ela. Só volta para a fila se a mensagem é
// urgência CLÍNICA (classificarUrgencia, helpers.ts). Nos 57 textos que a Julia
// teria segurado nenhum era urgência: "algum retorno?", "ok no aguardo", laudo.

/** Primeiro nome sem acento → como escrever para o paciente. */
export const ATENDENTES_DE_CASO_LONGO: Record<string, string> = {
  vania: "Vânia",
  lidiane: "Lidiane",
};

/** Quanto tempo "já passou pela fila" continua valendo. */
export const JANELA_CASO_LONGO_DIAS = 7;

/**
 * Linhas do transfer_audit que só AVISAM — não tiram o ticket de ninguém.
 * Todo o resto (pedido_paciente, inatividade, ficha_parada, urgencia...) é ida
 * para a fila e conta.
 */
export const GATILHOS_SEM_MOVIMENTO = [
  "aviso_timeout",
  "mensagem_engolida",
  "cancelamento_engolido",
  "inatividade_travada",
];

/** Pronto para `.not("trigger", "in", ...)` do supabase-js. */
export const FILTRO_GATILHOS_SEM_MOVIMENTO = `(${GATILHOS_SEM_MOVIMENTO.join(",")})`;

/** Início da janela, em ISO, para o `.gte("created_at", ...)`. */
export function desdeJanelaCasoLongo(agoraMs: number = Date.now()): string {
  return new Date(agoraMs - JANELA_CASO_LONGO_DIAS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * "Vânia" ou "Lidiane" quando o nome é de uma delas; null para o resto.
 * Aceita a grafia do Z-PRO ("VÂNIA", "Lidiane Souza") e a da classificação
 * ("vania").
 */
export function atendenteDeCasoLongo(nome: unknown): string | null {
  const n = _normalizarCurta(typeof nome === "string" ? nome : "");
  if (!n) return null;
  const primeiro = n.split(/\s+/)[0];
  return Object.prototype.hasOwnProperty.call(ATENDENTES_DE_CASO_LONGO, primeiro)
    ? ATENDENTES_DE_CASO_LONGO[primeiro]
    : null;
}

/** O ticket pode ir (de novo) para a fila? */
export function decideNovaIdaAFila(s: {
  casoLongo: boolean;
  jaPassouPelaFila: boolean;
  urgenciaClinica: boolean;
}): { mover: boolean; motivo: string } {
  if (!s.casoLongo) return { mover: true, motivo: "regra_normal" };
  if (!s.jaPassouPelaFila) return { mover: true, motivo: "primeira_ida" };
  if (s.urgenciaClinica) return { mover: true, motivo: "urgencia_clinica" };
  return { mover: false, motivo: "caso_longo_fica_com_a_dona" };
}

// ─────────────────────────────────────────────────────────────────────────────
// RELÓGIO DA GUARDA DE HUMANO — o handoff zera a contagem (19/09)
// ─────────────────────────────────────────────────────────────────────────────
// A guarda cala a Julia por `human_guard_timeout_min` (30) contados da PRIMEIRA
// mensagem pulada depois da última fala humana. Faltava um marco: a própria
// transferência. Conversa com mensagem pulada dias atrás e nenhuma fala humana
// depois já nascia "calada há mais de 30 min" — a Julia transferia e, na mensagem
// seguinte do paciente, falava de novo por cima da fila (e transferia de novo).
// Medido de 04 a 18/09: em 53 das 242 transferências por pedido do paciente a
// Julia voltou a responder antes de qualquer atendente, 30 delas em menos de 30
// minutos; o Rommel foi para a fila seis vezes em quatro minutos (15/09).
//
// Regra: a equipe tem o prazo INTEIRO a partir do último marco — fala humana ou
// handoff que MOVE o ticket (transferência da Julia, devolução por inatividade,
// varredura da ficha). Aviso e alerta (GATILHOS_SEM_MOVIMENTO) não contam.
export function relogioDaGuarda(s: {
  agoraMs: number;
  prazoMin: number;
  ultimaFalaMs: number | null;
  ultimoHandoffMs: number | null;
}): { equipeAindaTemPrazo: boolean; contarDesdeMs: number | null } {
  const prazoMs = Math.max(0, Number(s.prazoMin) || 0) * 60 * 1000;
  const valido = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v <= s.agoraMs;
  const marcos = [s.ultimaFalaMs, s.ultimoHandoffMs].filter(valido);
  const contarDesdeMs = marcos.length ? Math.max(...marcos) : null;
  const equipeAindaTemPrazo =
    prazoMs > 0 && valido(s.ultimoHandoffMs) && s.agoraMs - s.ultimoHandoffMs < prazoMs;
  return { equipeAindaTemPrazo, contarDesdeMs };
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

// ─────────────────────────────────────────────────────────────────────────────
// FIM DO EXPEDIENTE — NÃO PROMETER QUEM JÁ ESTÁ INDO EMBORA (pedido do dono, 15/09)
// ─────────────────────────────────────────────────────────────────────────────
// "A partir das 17:30, fala assim: 'Vou tentar passar para um atendente antes do
//  encerramento do atendimento.' Falando assim, o pessoal vai entender que, se não
//  conseguir a resposta, fica para amanhã de manhã."
//
// O que a Julia dizia nessa hora (09–14/09, mensagens reais): "Já estou te
// transferindo para nossa equipe... Só um instante", "vou te transferir agora
// mesmo para a Lidiane", "uma atendente vai continuar com você em instantes", e o
// aviso de 15 min "a Laiz está finalizando outro atendimento e já já te responde"
// às 17h54, 18h06, 18h28. Promessa de agora para uma equipe que está saindo — foi
// o que fez o Vitor (14/09, 17h49) escrever "Estou perguntando isso há 5 msg já".
//
// A janela fecha às 18h15, junto com `expedienteAberto`: é até quando as meninas
// ainda respondem (Vânia às 18:09 em 08/09). Depois disso a frase "antes do
// encerramento" deixaria de ser verdade.

export const FRASE_ENCERRAMENTO = "Vou tentar passar para um atendente antes do encerramento do atendimento.";

/** Seg–sex, das 17h30 às 18h15 (São Paulo). `agora` por parâmetro para a função seguir pura. */
export function pertoDoEncerramento(
  agora: { diaDaSemana: number; hora: number; minuto: number },
  inicioMin = 17 * 60 + 30,
  fimMin = 18 * 60 + 15,
): boolean {
  if (agora.diaDaSemana === 0 || agora.diaDaSemana === 6) return false;
  const m = agora.hora * 60 + agora.minuto;
  return m >= inicioMin && m < fimMin;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORA DO EXPEDIENTE — A VERSÃO DA NOITE (pedido do dono, 15/09)
// ─────────────────────────────────────────────────────────────────────────────
// Depois das 18h15 "antes do encerramento" já não é verdade. Caso Cristiano
// (14/09): 22h24 a Julia passou o caso para a equipe, 22h42 saiu "seu caso
// continua na fila da nossa equipe", e ele respondeu "Não quero mais" — estava a
// um passo de marcar com o Dr. Lucas. À noite a frase precisa dizer QUANDO:
// amanhã de manhã, hoje de manhã (madrugada), ou segunda-feira (sexta à noite e
// fim de semana). Feriado não entra aqui: o dia fechado tem fluxo próprio
// (getClosedDayInfo no webhook), que já diz "em DD/MM, quando voltarmos".

/**
 * Frase para a noite, a madrugada e o fim de semana. Com `nome`, a frase fala da
 * atendente ("ela te responde"); sem, da equipe.
 */
export function fraseForaDoExpediente(
  agora: { diaDaSemana: number; hora: number; minuto: number },
  nome?: string | null,
): string {
  const alvo = nome ? `a ${nome}` : "a nossa equipe";
  const m = agora.hora * 60 + agora.minuto;
  const fecha = 18 * 60 + 15;
  const abre = 7 * 60 + 30;
  const fimDeSemana = agora.diaDaSemana === 0 || agora.diaDaSemana === 6 || (agora.diaDaSemana === 5 && m >= fecha);
  if (fimDeSemana) return `Vou deixar seu caso com ${alvo} — o atendimento volta na segunda-feira de manhã.`;
  if (m < abre) {
    return `Vou deixar seu caso com ${alvo} — ${nome ? "ela te responde" : "te respondem"} hoje de manhã, quando o atendimento começar.`;
  }
  return `Vou deixar seu caso com ${alvo} — o atendimento de hoje já encerrou, então ${nome ? "ela te responde" : "te respondem"} amanhã de manhã.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESGATE DA MENSAGEM PARADA (23/09, pedido do dono)
// ─────────────────────────────────────────────────────────────────────────────
// 23/09 12h14, Fernanda: "Consigo algum ortopedista de pé para ver minha
// ressonância hoje". O ticket era da Glaucia (no almoço, 12h–13h). A guarda de
// humano calou a Julia, a Fase 2 devolveu o ticket para a fila às 12h26 (certo),
// às 13h ele estava com a Lidiane e foi fechado sem resposta — e ninguém mais
// falou com ela. O Felipe (16h38, "o adesivo eu coloco em que região?") foi
// igual: devolvido às 16h50, nenhuma resposta.
//
// O buraco: a guarda com prazo (08/09) deixa a Julia voltar a responder a
// PRÓXIMA mensagem depois de 30 min de silêncio da equipe — mas a mensagem que
// já estava esperando nunca era reprocessada. Se o paciente não escreve de novo,
// morre ali. Medido de 08 a 23/09: 221 conversas com paciente esperando mais de
// 30 min com a dona do ticket calada; 94 mensagens nunca respondidas.
//
// Agora a Fase 5 do human-transfer-timeout resgata: passado o prazo da guarda
// (clinic_tokens.human_guard_timeout_min, o mesmo botão — 0 desliga tudo), a
// Julia responde a mensagem parada. Só quando:
//   - as mensagens depois da última fala (de qualquer um) foram TODAS puladas
//     pela guarda por causa da dona do ticket (ou juntadas no mesmo lote);
//     pulada por transferência que a própria Julia fez fica com a fila e com o
//     aviso de 15 min;
//   - a primeira delas é de HOJE (São Paulo) — "hoje" no texto não pode virar
//     o dia seguinte — e tem pelo menos o prazo da guarda;
//   - juntas, exigem resposta ("obrigada" não é pergunta parada);
//   - o ticket não é de admin (o dono, a conta CBT).
export const MARCA_RESGATADA = "| resgatada";

const _PULADA_PELA_DONA_RE =
  /^(?:Humano ativo: (?:raw_payload\(status=open|recent_manual_reply)|Última mensagem foi de atendente humano)/;

export type MensagemParaResgate = {
  id: string;
  created_at: string;
  direction: string;
  ai_intent?: string | null;
  action_status?: string | null;
  action_error?: string | null;
  message_text?: string | null;
  temMidia?: boolean;
};

export type DecisaoDeResgate =
  | { resgatar: true; ids: string[]; texto: string; desde: string }
  | { resgatar: false; motivo: string };

// A SIMULAÇÃO QUE APERTOU A REGRA (23/09). Rodando a primeira versão sobre 08 a
// 23/09 saíam ~25 resgates por dia útil, e boa parte era errada: "Obrigada e
// igualmente!🌷", "Recebi a receita, muito obrigado", um nome solto respondendo
// à pergunta da atendente ("Alberto ragazzi pauli gebrim"), "Vânia, quando o Dr.
// Gustavo vai está atendendo?". Agora só resgata PERGUNTA OU PEDIDO NOVO, nunca
// mensagem dirigida a uma atendente pelo nome, nunca caso longo (Vânia e
// Lidiane ficam com os pacientes delas — regra de 15/09).
const _NOME_DE_ATENDENTE_RE = /(?<![\p{L}])(?:v[aâ]nia|lidiane|lidi|gl[aá]ucia|laiz|la[ií]s|mardil+a|caroline|carol)(?![\p{L}])/iu;
// Resposta automática do WhatsApp comercial do PRÓPRIO paciente ("Recebi sua
// solicitação. O prazo para retorno é de até 48 horas úteis") — responder a ela é
// robô conversando com robô.
const _AUTORRESPOSTA_RE =
  /recebi (?:a )?sua (?:solicita|mensagem)|resposta autom[aá]tica|mensagem autom[aá]tica|prazo para (?:retorno|resposta)|hor[aá]rio de (?:expediente|atendimento) [eé]|estou (?:ausente|de f[eé]rias)|fora do (?:escrit[oó]rio|expediente)|agradecemos (?:o seu|seu) contato/iu;
// "Pode", "Podemos sim", "Não posso": resposta à pergunta da atendente, não pedido.
const _VERBO_DE_AGENDA_RE = /(?<![\p{L}])(?:marcar|agendar|desmarcar|remarcar|reagendar|cancelar)(?![\p{L}])/iu;
// Atendente falou com o paciente há menos de 2 h: a mensagem parada costuma ser a
// resposta à proposta dela ("pode ser na quarta às 17?"). Se a Julia marcasse, a
// equipe marcaria de novo. Fica com ela (e com o alerta da Fase 3).
const CONVERSA_RECENTE_COM_ATENDENTE_MS = 2 * 60 * 60 * 1000;
const IDADE_MAXIMA_DO_RESGATE_MS = 3 * 60 * 60 * 1000;
const _SAUDACAO_RE =
  /(?<![\p{L}])(?:ol[aá]|oi+e?|bom dia|boa tarde|boa noite|tudo bem|tudo bom|td bem|tudo certo|como vai)(?![\p{L}])[\s,!.?]*/giu;
const _PEDIDO_RE =
  /(?<![\p{L}])(?:consigo|conseguiria|conseguem|gostaria|queria|quero|preciso|precisaria|tem|teria|d[uú]vida|pode|poderia|podem|podemos|voc[eê]s|vcs|qual|quais|quando|como|onde|posso|daria|poss[ií]vel|marcar|agendar|remarcar|desmarcar|cancelar)(?![\p{L}])/iu;

/** A mensagem parada é pergunta ou pedido novo (e não saudação, agradecimento ou resposta curta)? */
export function pareceNovaPergunta(texto: unknown): boolean {
  const semSaudacao = String(texto ?? "").replace(_SAUDACAO_RE, " ").trim();
  if (!semSaudacao) return false;
  if (semSaudacao.includes("?")) return true;
  const palavras = semSaudacao.split(/[\s/]+/).filter((p) => /[\p{L}\p{N}]/u.test(p));
  if (palavras.length <= 3 && !_VERBO_DE_AGENDA_RE.test(semSaudacao)) return false;
  return _PEDIDO_RE.test(semSaudacao);
}

function _diaEmSaoPaulo(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function decidirResgate(a: {
  agoraMs: number;
  prazoMin: number;
  mensagens: MensagemParaResgate[];
  donoEhAdmin?: boolean;
  donoNome?: string | null;
}): DecisaoDeResgate {
  if (!(Number(a.prazoMin) > 0)) return { resgatar: false, motivo: "desligado" };
  if (a.donoEhAdmin) return { resgatar: false, motivo: "dono_admin" };
  if (atendenteDeCasoLongo(a.donoNome)) return { resgatar: false, motivo: "caso_longo" };
  const ms = [...(a.mensagens || [])].sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  let ultimaFala = -1;
  ms.forEach((m, i) => {
    if (m.direction === "outgoing") ultimaFala = i;
  });
  const presas = ms.slice(ultimaFala + 1).filter((m) => m.direction === "incoming");
  if (!presas.length) return { resgatar: false, motivo: "sem_mensagem_parada" };
  for (const p of presas) {
    const st = String(p.action_status || "");
    if (st !== "skipped" && st !== "batched") return { resgatar: false, motivo: "julia_ja_processou" };
    const erro = String(p.action_error || "");
    if (erro.includes(MARCA_RESGATADA)) return { resgatar: false, motivo: "ja_resgatada" };
    if (st === "skipped" && !_PULADA_PELA_DONA_RE.test(erro)) return { resgatar: false, motivo: "outro_motivo" };
  }
  if (!presas.some((p) => p.action_status === "skipped")) return { resgatar: false, motivo: "outro_motivo" };
  const primeira = presas[0];
  const t0 = Date.parse(primeira.created_at);
  if (_diaEmSaoPaulo(t0) !== _diaEmSaoPaulo(a.agoraMs)) return { resgatar: false, motivo: "outro_dia" };
  if (a.agoraMs - t0 < Number(a.prazoMin) * 60000) return { resgatar: false, motivo: "dentro_do_prazo" };
  // No normal o resgate sai ~30 min depois. Mais de 3 h só acontece logo depois de
  // um deploy ou com o cron parado — aí seria rajada de resposta velha ("hoje" às 19h45).
  if (a.agoraMs - t0 > IDADE_MAXIMA_DO_RESGATE_MS) return { resgatar: false, motivo: "velha_demais" };
  const falouHaPouco = ms.some(
    (m) =>
      m.direction === "outgoing" &&
      m.ai_intent === "manual_reply" &&
      Date.parse(m.created_at) < t0 &&
      t0 - Date.parse(m.created_at) < CONVERSA_RECENTE_COM_ATENDENTE_MS,
  );
  if (falouHaPouco) return { resgatar: false, motivo: "conversa_recente_com_a_atendente" };
  const texto = presas.map((p) => String(p.message_text || "").trim()).filter(Boolean).join("\n");
  if (!exigeRespostaDaAtendente(texto, presas.some((p) => !!p.temMidia))) {
    return { resgatar: false, motivo: "nao_exige_resposta" };
  }
  if (_AUTORRESPOSTA_RE.test(texto)) return { resgatar: false, motivo: "autorresposta" };
  if (_NOME_DE_ATENDENTE_RE.test(texto)) return { resgatar: false, motivo: "falou_com_a_atendente" };
  if (!pareceNovaPergunta(texto)) return { resgatar: false, motivo: "nao_e_pergunta" };
  return { resgatar: true, ids: presas.map((p) => p.id), texto, desde: primeira.created_at };
}
