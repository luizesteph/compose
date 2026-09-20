// _shared/cron.ts — quem pode disparar as funções de cron (auditoria 20/09).
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO QUE ISTO FECHA
// ─────────────────────────────────────────────────────────────────────────────
// Cinco funções (human-transfer-timeout, process-pending-followups,
// process-waitlist, process-lost-conversions, sync-amigo-cache) aceitavam a
// chamada quando o cabeçalho `apikey` OU `authorization` existia — sem olhar o
// VALOR. `VERIFY_JWT=false` no contêiner, então o gateway também não confere
// nada. Testado ao vivo em 20/09:
//
//   curl -X POST .../functions/v1/sync-amigo-cache \
//        -H "Authorization: Bearer lixo-nao-e-chave-de-ninguem"   → HTTP 200
//
// Qualquer pessoa na internet podia rodar os crons da clínica: devolver ticket
// para a fila, acelerar follow-up, disparar oferta da lista de espera, torrar
// chamada da API do Amigo. Não vaza dado (o RLS segura isso), mas é ação no
// sistema sem credencial nenhuma.
//
// AGORA: só passa quem prova quem é — o `x-cron-secret` do pg_cron (os 9 jobs
// HTTP mandam; conferido em 20/09) ou a chave de SERVIÇO no Authorization, que
// é secreta, ao contrário da chave pública que vai no bundle do site.
//
// Comparação em tempo constante: comparar segredo com `===` vaza o tamanho do
// acerto pelo tempo de resposta. Custa nada fazer certo.

function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

/**
 * A chamada pode rodar o cron?
 *
 * @param req            a requisição que chegou
 * @param segredoDoCron  CRON_SECRET do ambiente (o pg_cron manda em x-cron-secret)
 * @param chaveDeServico SUPABASE_SERVICE_ROLE_KEY — para chamada manual do dono
 *
 * Segredo vazio NUNCA autoriza: ambiente sem CRON_SECRET tem que dar 401, não
 * virar porta aberta (foi assim que o `hasApiKey` nasceu — de um fallback que
 * parecia inofensivo).
 */
export function chamadaDeCronAutorizada(
  req: Request,
  segredoDoCron?: string | null,
  chaveDeServico?: string | null,
): boolean {
  const esperado = String(segredoDoCron || "");
  const enviado = String(req.headers.get("x-cron-secret") || "");
  if (iguaisEmTempoConstante(enviado, esperado)) return true;

  const chave = String(chaveDeServico || "");
  const auth = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (iguaisEmTempoConstante(auth, chave)) return true;

  const apikey = String(req.headers.get("apikey") || "").trim();
  return iguaisEmTempoConstante(apikey, chave);
}
