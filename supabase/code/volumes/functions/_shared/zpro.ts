// _shared/zpro.ts — o que as funções de cron precisam do Z-PRO, num lugar só (23/09).
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE EXISTE
// ─────────────────────────────────────────────────────────────────────────────
// Cada cron tinha a sua cópia de "achar o canal", "conferir o ticket" e "mandar
// a mensagem" — e as cópias erravam em lugares diferentes:
//
//   - o lembrete do link do site (process-pending-followups) conferia o ticket e
//     enviava com as credenciais PLANAS da clinic_tokens, que apontam para o canal
//     143, DESLIGADO; e lia o showticket na raiz. Resultado medido em 23/09: ZERO
//     lembretes enviados desde que a tabela existe — todo caso que chegava à
//     conferência morria como "human_active_unknown" (52 em 60 dias);
//   - a Recuperação (process-lost-conversions) achava o canal certo, mas também
//     lia o showticket na raiz: nunca viu atendente no ticket.
//
// O showticket devolve {"success":true,"data":{"status":"open","userId":183}}
// (conferido ao vivo em 23/09, com e sem channelId). Sem ticket aberto — o
// ticket fechado da Fernanda, por exemplo — vem ERR_TICKET_NOT_FOUND. É a mesma
// lição da Fase 2 do human-transfer-timeout (30/08), que lá foi corrigida.

export type CanalZpro = { baseUrl: string; apiId: string; bearerToken: string; channelId: string | null };

type Clinica = {
  avanceai_base_url?: string | null;
  avanceai_api_id?: string | null;
  avanceai_bearer_token?: string | null;
  avanceai_active_channel?: unknown;
};

/**
 * O canal vivo da clínica (lição 19/07, ERR_API_REQUIRES_SESSION).
 *
 * `avanceai_active_channel` é um array JSON de canais, cada um com credencial
 * própria. Um canal ligado → ele. Dois ou mais → null (não dá para adivinhar por
 * qual o paciente fala; agir no canal errado é pior que parar). Nenhum configurado
 * → as colunas planas (legado). Configurado mas todos desligados → null.
 */
export function canalVivo(cl: Clinica | null | undefined): CanalZpro | null {
  if (!cl) return null;
  let parsed: unknown = null;
  try {
    parsed = typeof cl.avanceai_active_channel === "string"
      ? JSON.parse(cl.avanceai_active_channel)
      : cl.avanceai_active_channel;
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    const ligados = parsed.filter(
      (ch) => ch && typeof ch === "object" && (ch as Record<string, unknown>).apiId &&
        (ch as Record<string, unknown>).baseUrl && (ch as Record<string, unknown>).enabled !== false,
    ) as Array<Record<string, unknown>>;
    if (ligados.length !== 1) return null;
    const ch = ligados[0];
    return {
      baseUrl: String(ch.baseUrl),
      apiId: String(ch.apiId),
      bearerToken: String(ch.bearerToken || cl.avanceai_bearer_token || ""),
      channelId: ch.id != null ? String(ch.id) : null,
    };
  }
  if (!cl.avanceai_base_url || !cl.avanceai_api_id || !cl.avanceai_bearer_token) return null;
  return {
    baseUrl: String(cl.avanceai_base_url),
    apiId: String(cl.avanceai_api_id),
    bearerToken: String(cl.avanceai_bearer_token),
    channelId: null,
  };
}

export type SituacaoDoTicket = "atendente" | "livre" | "desconhecida";

/**
 * Lê a resposta do showticket.
 *   "atendente"   → ticket aberto com gente de verdade (userId ou nome)
 *   "livre"       → sem ticket, na fila, fechado, ou aberto sem ninguém (órfão)
 *   "desconhecida"→ erro, sem resposta, formato que não dá para ler
 * Aceita o formato real ({success, data}) e o antigo (na raiz).
 */
export function lerShowticket(httpStatus: number, corpo: unknown): SituacaoDoTicket {
  const c = corpo && typeof corpo === "object" ? (corpo as Record<string, unknown>) : {};
  if (httpStatus === 404 || /TICKET_NOT_FOUND/i.test(String(c.error ?? ""))) return "livre";
  if (httpStatus < 200 || httpStatus >= 300) return "desconhecida";
  const t = c.data && typeof c.data === "object" ? (c.data as Record<string, unknown>) : c;
  const status = String(t.status ?? "").toLowerCase();
  if (!status) return "desconhecida";
  const user = t.user && typeof t.user === "object" ? (t.user as Record<string, unknown>) : null;
  const userId = Number(t.userId ?? user?.id ?? 0) || 0;
  const nome = String(user?.name ?? "").trim();
  if (status === "open" && (userId > 0 || nome.length > 0)) return "atendente";
  return "livre";
}

function numeroCompleto(telefone: string): string {
  const d = String(telefone || "").replace(/\D/g, "");
  return d.length <= 11 ? `55${d}` : d;
}

/** Situação do ticket do paciente AGORA, no canal vivo. Falha de rede → "desconhecida". */
export async function situacaoDoTicket(canal: CanalZpro, telefone: string): Promise<SituacaoDoTicket> {
  const payload: Record<string, unknown> = { number: numeroCompleto(telefone) };
  if (canal.channelId) {
    payload.channelId = Number(canal.channelId);
    payload.whatsappId = Number(canal.channelId);
  }
  try {
    const res = await fetch(`${canal.baseUrl}/v2/api/external/${canal.apiId}/showticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${canal.bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    let corpo: unknown = null;
    try {
      corpo = await res.json();
    } catch {
      corpo = null;
    }
    return lerShowticket(res.status, corpo);
  } catch {
    return "desconhecida";
  }
}

/** Envia texto no contrato que funciona: channelId + whatsappId + externalKey + isClosed. */
export async function enviarTexto(
  canal: CanalZpro,
  telefone: string,
  texto: string,
): Promise<{ ok: boolean; detalhe: string }> {
  const payload: Record<string, unknown> = {
    number: numeroCompleto(telefone),
    body: texto,
    externalKey: crypto.randomUUID(),
    isClosed: false,
  };
  if (canal.channelId) {
    payload.channelId = Number(canal.channelId);
    payload.whatsappId = Number(canal.channelId);
  }
  try {
    const res = await fetch(`${canal.baseUrl}/v2/api/external/${canal.apiId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${canal.bearerToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const detalhe = res.ok ? "" : `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
    return { ok: res.ok, detalhe };
  } catch (e) {
    return { ok: false, detalhe: `exceção: ${(e as Error).message.slice(0, 120)}` };
  }
}
