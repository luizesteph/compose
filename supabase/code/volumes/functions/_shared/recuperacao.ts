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
  return ["agendar", "reagendar", "cadastrar"].includes(intent) && ["needs_info", "needs_registration"].includes(status);
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
export function textoDaRecuperacao(categoria: string, linkDoSite?: string | null): string {
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
  return (
    "Oi! 👋 Vi que você perguntou sobre valores mais cedo. Posso ajudar em mais alguma coisa? " +
    `Se quiser marcar uma consulta, me diga o médico ou o que você está sentindo que eu já verifico os horários.${link}`
  );
}
