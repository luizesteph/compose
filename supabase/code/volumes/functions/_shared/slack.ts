// _shared/slack.ts — mensagem direta no Slack pelo bot da clínica (21/10/2026).
// O token (xoxb-…) fica em clinic_tokens.slack_bot_token, gravado pelo DONO; nunca no
// código nem no git. Precisa dos escopos chat:write e im:write.

export async function enviarDMNoSlack(
  token: string,
  usuario: string,
  texto: string,
): Promise<{ ok: boolean; detalhe: string; link?: string }> {
  if (!token || !/^xox[bp]-/.test(token)) return { ok: false, detalhe: "sem token do Slack" };
  if (!/^[UW][A-Z0-9]{6,}$/.test(usuario)) return { ok: false, detalhe: "destino inválido" };
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" };
  try {
    const abre = await fetch("https://slack.com/api/conversations.open", {
      method: "POST", headers: h, body: JSON.stringify({ users: usuario }), signal: AbortSignal.timeout(10000),
    }).then((r) => r.json());
    if (!abre?.ok) return { ok: false, detalhe: `conversations.open: ${abre?.error ?? "?"}` };
    const canal = abre.channel?.id;
    // a mensagem pode passar de 4000 caracteres num dia cheio: vai em pedaços
    const pedacos: string[] = [];
    let atual = "";
    for (const linha of texto.split("\n")) {
      if ((atual + "\n" + linha).length > 3500) { pedacos.push(atual); atual = linha; } else atual = atual ? `${atual}\n${linha}` : linha;
    }
    if (atual) pedacos.push(atual);
    let link: string | undefined;
    for (const p of pedacos) {
      const env = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST", headers: h,
        // link_names/parse desligados: nada do texto vira menção
        body: JSON.stringify({ channel: canal, text: p, mrkdwn: true, unfurl_links: false, unfurl_media: false, parse: "none", link_names: false }),
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.json());
      if (!env?.ok) return { ok: false, detalhe: `chat.postMessage: ${env?.error ?? "?"}` };
      link ??= env.ts ? `${canal}/${env.ts}` : undefined;
    }
    return { ok: true, detalhe: "", link };
  } catch (e) {
    return { ok: false, detalhe: `exceção: ${(e as Error).message.slice(0, 120)}` };
  }
}
