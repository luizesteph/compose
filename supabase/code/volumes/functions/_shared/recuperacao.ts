// _shared/recuperacao.ts — o que a Recuperação (tela /recuperacao) decide e diz (23/09).
//
// A Recuperação é do dono (19/07): a Julia volta a falar, UMA vez, com quem não
// marcou. Tinha duas categorias — falha na marcação (3 h) e perguntou o valor e
// sumiu (4 h). Em 23/09 entrou a terceira, que era a intenção do antigo "resgate
// de 24 h" (patient-recovery, desligado desde abril e que nunca funcionou: ele
// disparava quando o paciente VOLTAVA depois de 24 h e desistia se a própria
// Julia respondesse):
//
//   agendamento_abandonado — a última coisa da conversa é uma pergunta de agenda
//   da Julia (lista de horários, reserva, pedido de CPF ou de cadastro, link do
//   site) e ninguém escreveu mais nada por 20 h, sem marcação. Medido de 24/08 a
//   23/09: 2 a 3 pacientes por semana.

export const CATEGORIA_ABANDONO = "agendamento_abandonado";

/** A mensagem da Julia é uma pergunta de agenda (a marcação estava no meio)? */
export function ehPerguntaDeAgenda(m: { ai_intent?: string | null; action_status?: string | null }): boolean {
  const intent = String(m?.ai_intent ?? "");
  const status = String(m?.action_status ?? "");
  if (intent === "widget_link_sent") return true;
  // REMARCAR NÃO CONTA (27/09): quem remarca JÁ TEM consulta. "Ficou faltando fechar
  // o seu agendamento" foi para a Cristal (26/09 7h), que tem consulta em 05/10 e só
  // queria entrar na lista de espera.
  return ["agendar", "cadastrar"].includes(intent) && ["needs_info", "needs_registration"].includes(status);
}

/**
 * O paciente disse que não vai seguir? (27/09, caso Catherine 24/09: "Agradeço, mas
 * não vou prosseguir com o agendamento" às 10h30 e, às 14h30, a Recuperação mandou
 * "Vi que você perguntou sobre valores mais cedo…"). Recusa depois do caso = não
 * envia. Só frases de desistência explícita — "não" solto, "agora não" e "vou
 * ver" não contam (medido nas respostas às perguntas de preço de 60 dias).
 */
export function recusouSeguir(texto: unknown): boolean {
  const t = String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!t.trim()) return false;
  return /\bnao\s+vou\s+(?:prosseguir|seguir|continuar|marcar|agendar|querer)\b|\bnao\s+(?:quero|preciso)\s+(?:mais\s+)?(?:marcar|agendar|a\s+consulta|consulta)\b|\bdesisto\b|\bdesist(?:i|ir)\s+(?:da|de)\b|\b(?:consegui|marquei|vou\s+(?:tentar|procurar|marcar))\s+(?:em\s+|n[ao]\s+)?outr[oa]\s+(?:lugar|clinica|medico|local)\b|\bnao\s+tenho\s+(?:mais\s+)?interesse\b|^\s*nao,?\s+obrigad[oa]s?\b/.test(t) ||
    // "Por ora não, obrigada" (10/11, Daniela 05/11: respondeu assim a "Quer que eu veja um
    // horário?" e 4 h depois recebeu "Vi que você perguntou sobre valores…"). Só com o
    // agradecimento junto — "agora não" solto continua não contando.
    /\b(?:por\s+ora|por\s+enquanto|no\s+momento|agora|hoje)\s+nao\b[\s,.!]*(?:muito\s+)?(?:obrigad|grat[oa]\b|valeu|agradec)/.test(t);
}

/** Quantos minutos ANTES do caso uma recusa ainda vale (10/11, Oscar 05/11: "Não vou
 *  agendar grato" às 10h10, a Julia se despediu às 10h11 — e a despedida virou o "caso";
 *  a recusa, de um minuto antes, não era lida). */
export const RECUSA_ANTES_DO_CASO_MIN = 15;

/**
 * O preço para pôr no follow-up de quem perguntou o valor (10/11, Thiago 04/11: a
 * pergunta ficou calada pela ficha aberta e o follow-up dizia "vi que você perguntou
 * sobre valores" sem dizer o valor). Só quando a pergunta é da CONSULTA e não cita outro
 * serviço — nutróloga, fisioterapia, infiltração, exame e cirurgia têm outro preço.
 */
export function precoParaARecuperacao(pergunta: unknown, notasDaClinica: unknown): string | null {
  const t = String(pergunta ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!t.trim()) return null;
  if (/nutr|fisio|infiltra|aplicac|cirurg|onda|exame|raio|\brx\b|resson|tomograf|sess[ao]|procedimento|ultrass|laudo/.test(t)) return null;
  if (!/consulta|ortoped|\bvalor\b|\bpreco\b|quanto/.test(t)) return null;
  const m = String(notasDaClinica ?? "").match(/Consulta\s+Particular\s+com\s+Ortopedistas:?\**:?\s*(R\$\s*\d[\d.]*(?:,\d{2})?)/i);
  return m ? m[1].replace(/\s+/g, " ") : null;
}

/**
 * A conversa é de procedimento (infiltração, fisioterapia, cirurgia)? Esses casos
 * são da equipe (Lidiane, Vânia, a fisio), não de marcação de consulta: "Ficou
 * faltando fechar o seu agendamento" foi para o André (26/09 19h), que espera a
 * Lidiane marcar as infiltrações (27/09).
 */
export function falaDeProcedimento(texto: unknown): boolean {
  const t = String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /infiltra|fisioterap|\bfisio\b|cirurgi/.test(t);
}

/**
 * O texto do follow-up de cada categoria.
 *
 * Regras (desde 19/07, e as do dono):
 *   - sem nome: o nome do WhatsApp é apelido, loja ou o dono do aparelho (11/08);
 *   - nunca pede "responda sim" (o orphan-ACK leria como resposta ao robô de
 *     confirmação do Amigo) e termina num pedido aberto — médico, dia, sintoma;
 *   - nunca data nem hora (antialucinação);
 *   - a falha não é chamada de "instabilidade": desde 19/09 muita falha é "não
 *     achei consulta", horário ocupado ou o teto do Amigo, não queda de sistema.
 */
export function textoDaRecuperacao(categoria: string, linkDoSite?: string | null, precoDaConsulta?: string | null): string {
  const link = linkDoSite ? `\n\nSe preferir, é só clicar aqui para agendar online:\n${linkDoSite}` : "";
  if (categoria === "falha_agendamento") {
    return (
      "Oi! 👋 Mais cedo não consegui concluir seu agendamento por aqui — me desculpe! 🙏 " +
      `Se ainda quiser marcar, me diga o médico ou o que você está sentindo que eu vejo os horários agora.${link}`
    );
  }
  if (categoria === CATEGORIA_ABANDONO) {
    return (
      "Oi! 👋 Ficou faltando fechar o seu agendamento aqui com a gente. " +
      `Se ainda quiser marcar, me diga o médico ou o dia que prefere que eu vejo os horários de novo. 😊${link}`
    );
  }
  if (precoDaConsulta) {
    return (
      `Oi! 👋 Vi que você perguntou sobre valores mais cedo: a consulta particular com nossos ortopedistas é ${precoDaConsulta}, com direito a retorno em até 30 dias. ` +
      `Se quiser marcar, me diga o médico ou o que você está sentindo que eu já verifico os horários.${link}`
    );
  }
  return (
    "Oi! 👋 Vi que você perguntou sobre valores mais cedo. Posso ajudar em mais alguma coisa? " +
    `Se quiser marcar uma consulta, me diga o médico ou o que você está sentindo que eu já verifico os horários.${link}`
  );
}
