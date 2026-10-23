// _shared/relatorio-confirmacao.ts — relatório diário da insistência da confirmação
// (21/10/2026, pedido do dono: "todo dia… mandar um relatório para o Slack da Mardila";
// "vamos no servidor" — sem depender de computador ligado).
//
// Mesmo conteúdo do deploy/relatorio-confirmacao.sh (que segue para uso manual): quem
// confirmou pelo SIM, quem respondeu outra coisa, quem não respondeu, quem não recebeu —
// com nome completo e telefone (regra do dono para listas da equipe).
//
// O texto do paciente é DADO NÃO CONFIÁVEL: sai sem < > & (menção/link do Slack, como
// <!channel>), sem marcação (* _ ~ ` " |) e cortado em 80 caracteres.

export type LinhaDoRelatorio = {
  status: string;
  motivo: string | null;
  paciente_nome: string | null;
  medico_nome: string | null;
  telefone: string | null;
  hora: string | null;
  data_consulta: string; // AAAA-MM-DD
  enviada_em?: string | null;
};

export function limparTextoDoPaciente(t: unknown, max = 80): string {
  return String(t ?? "")
    .replace(/[<>&*_~`"|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
/** nome, médico, hora, motivo: também vêm de fora (cadastro do Amigo, feito até pelo site) */
const campo = (t: unknown, vazio: string) => limparTextoDoPaciente(t, 120) || vazio;

/** "5511973529675" → "+55 11 97352-9675" */
export function telefoneLegivel(t: unknown): string {
  const d = String(t ?? "").replace(/\D/g, "");
  if (d.length < 12) return d || "sem telefone";
  return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, d.length - 4)}-${d.slice(-4)}`;
}

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function motivoLegivel(l: LinhaDoRelatorio): string {
  if (l.status === "agendada") return "ainda na fila de envio";
  if (l.status === "falhou") return "o envio falhou";
  switch (l.motivo) {
    case "em_conversa": return "estava conversando com a equipe";
    case "sem_celular": return "sem celular no cadastro";
    case "sem_tempo": return "não coube na janela";
    case "numero_sem_julia": return "número sem Julia";
    default: return campo(l.motivo || l.status, "?");
  }
}

/**
 * Monta o relatório (mrkdwn do Slack). `respostas` = o que o paciente escreveu depois
 * do envio, por id da linha (já pode vir sujo — é limpo aqui).
 */
export function montarRelatorio(
  linhas: LinhaDoRelatorio[],
  respostas: Map<string, string[]>,
  diaEnvioISO: string,
  ids?: string[],
  equipeJaFalou?: Set<string>,
): string {
  if (!linhas.length) return "Hoje não havia consultas de amanhã esperando confirmação.";
  const comId = linhas.map((l, i) => ({ l, id: ids?.[i] ?? String(i) }));
  const item = (l: LinhaDoRelatorio) =>
    `• ${campo(l.paciente_nome, "(sem nome)")} — ${telefoneLegivel(l.telefone)} — ${campo(l.hora, "--:--")} com ${campo(l.medico_nome, "(médico?)")}`;
  const resp = (id: string) => (respostas.get(id) || []).map((t) => limparTextoDoPaciente(t)).filter(Boolean).join(" / ");
  const ordena = (a: { l: LinhaDoRelatorio }, b: { l: LinhaDoRelatorio }) =>
    String(a.l.hora).localeCompare(String(b.l.hora)) || String(a.l.paciente_nome).localeCompare(String(b.l.paciente_nome));

  const conf = comId.filter((x) => x.l.status === "confirmada").sort(ordena);
  const canc = comId.filter((x) => x.l.status === "cancelada").sort(ordena);
  const comEquipe = comId.filter((x) => ["enviada", "falhou_confirmar"].includes(x.l.status) && equipeJaFalou?.has(x.id)).sort(ordena);
  const semEquipe = (x: { id: string }) => !equipeJaFalou?.has(x.id);
  const outra = comId.filter((x) => ["enviada", "falhou_confirmar"].includes(x.l.status) && resp(x.id) && semEquipe(x)).sort(ordena);
  const calados = comId.filter((x) => x.l.status === "enviada" && !resp(x.id) && semEquipe(x)).sort(ordena);
  const semMsg = comId.filter((x) => ["pulada", "falhou", "agendada"].includes(x.l.status)).sort(ordena);
  const enviadas = linhas.filter((l) => !!l.enviada_em).length;

  const out: string[] = [];
  out.push(`*Confirmação das consultas de ${ddmm(linhas[0].data_consulta)}* (envio de ${ddmm(diaEnvioISO)})`);
  out.push(
    `• Sem confirmação às 16h: ${linhas.length} · mensagens enviadas: ${enviadas} · confirmadas pelo SIM: ${conf.length}` +
      ` · já confirmadas antes do envio: ${linhas.filter((l) => l.status === "ja_confirmada").length}` +
      ` · canceladas: ${canc.length} · sem mensagem: ${semMsg.length}`,
  );
  if (conf.length) out.push("", "*✅ Confirmaram pelo SIM* (já registrado no Amigo)", ...conf.map((x) => item(x.l)));
  if (canc.length) out.push("", "*❌ Canceladas depois da mensagem*", ...canc.map((x) => item(x.l)));
  if (outra.length) out.push("", "*⚠️ Responderam outra coisa — a equipe precisa ver*", ...outra.map((x) => `${item(x.l)} — disse: "${resp(x.id)}"`));
  if (calados.length) out.push("", "*📞 Receberam e não responderam (ligar)*", ...calados.map((x) => item(x.l)));
  if (comEquipe.length) {
    out.push("", "*👩‍💼 A equipe já conversou com o paciente depois da mensagem (conferir se ficou confirmado)*",
      ...comEquipe.map((x) => (resp(x.id) ? `${item(x.l)} — disse: "${resp(x.id)}"` : item(x.l))));
  }
  if (semMsg.length) out.push("", "*🚫 Não receberam a mensagem*", ...semMsg.map((x) => `${item(x.l)} — ${motivoLegivel(x.l)}`));
  return out.join("\n");
}

export function textoParaAMardila(relatorio: string): string {
  if (!relatorio.startsWith("*Confirmação")) return relatorio;
  return `Boa tarde, Mardila! Resultado da confirmação de hoje 👇\n\n${relatorio}\n\n` +
    `Quem está em ⚠️ e 📞 precisa de contato da equipe. O "SIM" já foi registrado no Amigo automaticamente.`;
}
