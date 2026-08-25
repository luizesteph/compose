// amigoApi.ts — Modularizacao M2 (04/07).
// TODA a comunicacao HTTP com a API do Amigo (EHR) vive aqui: bases, retries
// com backoff + teto de wall-clock, timeout por requisicao e o cache curto de
// disponibilidade. Extraido byte a byte do index.ts (comportamento identico).
// Modulo SEM @ts-nocheck — tsc estrito no preflight. Unica exportacao: tryFetch;
// API_URLS e caches sao detalhes privados.
import { normalizeApiResponse } from "./helpers.ts";

// API URLs to try in order (same as amigo-proxy)
const API_URLS = ["https://amigobot-api.amigoapp.com.br", "https://api.amigoapp.com.br"];

// AvanceAI is the sole WhatsApp provider


// ─── Availability cache (debounce de buscas de agenda) ─────────────────────
// In-memory por instância da edge function. TTL curto pra evitar disparos
// múltiplos quando o paciente manda várias mensagens em sequência rápida.
// Só cacheia respostas não-vazias, pra nunca devolver "sem horário" stale.
const availCache = new Map<string, { data: unknown; status: number; expiresAt: number }>();
function isCacheableAvailEndpoint(endpoint: string, method: string): boolean {
  if (method !== "GET") return false;
  return endpoint.includes("available-dates") || endpoint.startsWith("calendar?") || endpoint.startsWith("calendar/");
}
function getAvailTTL(endpoint: string): number {
  if (endpoint.startsWith("calendar")) return 45_000;
  if (endpoint.includes("available-dates")) return 45_000;
  return 30_000;
}

export async function tryFetch(
  endpoint: string,
  amigoToken: string,
  method: string = "GET",
  body?: unknown,
  critical: boolean = false,
): Promise<{ data: unknown; status: number }> {
  // Cache curto para endpoints de disponibilidade — evita race do anti-hallucination
  if (isCacheableAvailEndpoint(endpoint, method)) {
    const cached = availCache.get(endpoint);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[availCache] HIT ${endpoint} (expira em ${Math.round((cached.expiresAt - Date.now()) / 1000)}s)`);
      return { data: cached.data, status: cached.status };
    }
  }

  // Critical mode: more retries, longer timeout, exponential backoff
  const MAX_RETRIES = critical ? 4 : 2;
  const TIMEOUT_MS = critical ? 15000 : 8000;
  // LATENCIA (p95 ~430s): pior caso era 4 tentativas x 2 URLs x 15s + backoffs
  // ~134s POR CHAMADA, e um agendar encadeia varias. Teto de wall-clock: a
  // sequencia inteira de retries aborta ao estourar o orcamento.
  const WALL_CLOCK_BUDGET_MS = critical ? 45000 : 20000;
  const modeLabel = critical ? "CRITICAL" : "normal";
  let lastError = "Todas as URLs da API falharam";
  const startTime = Date.now();
  // Bases que responderam "Route Not found" para ESTA chamada — não adianta
  // insistir nelas nas próximas tentativas (ver nota no tratamento do 404).
  const basesSemEstaRota = new Set<string>();
  // 404 de APLICAÇÃO ("Paciente não encontrado.") visto nesta tentativa: fica
  // guardado para ser DEVOLVIDO ao chamador em vez de virar o 502 sintético.
  let resposta404DeAplicacao: { data: unknown; status: number } | null = null;
  // Tentativa em que ALGUMA base falhou de verdade — timeout, erro de rede OU
  // 5xx. Enquanto uma base está caindo, o "não achei" da outra NÃO é palavra
  // final: devolver 404 ali empurraria um paciente já cadastrado pro fluxo de
  // cadastro (Tema 3 ao contrário, risco de duplicata). Fica no ladder.
  let tentativaComFalhaGrave = -1;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (Date.now() - startTime > WALL_CLOCK_BUDGET_MS) {
      console.log(
        `[Amigo][${modeLabel}] ⏱️ Wall-clock budget ${WALL_CLOCK_BUDGET_MS}ms estourado (elapsed ${Date.now() - startTime}ms) — abortando retries`,
      );
      break;
    }
    if (attempt > 0) {
      // Critical: exponential backoff 2s → 4s → 8s; Normal: linear 1.5s → 3s
      const delay = critical ? Math.min(2000 * Math.pow(2, attempt - 1), 8000) : attempt * 1500;
      console.log(
        `[Amigo][${modeLabel}] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (elapsed ${Date.now() - startTime}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    for (const baseUrl of API_URLS) {
      if (basesSemEstaRota.has(baseUrl)) continue;
      try {
        const url = `${baseUrl}/${endpoint}`;
        console.log(
          `[Amigo][${modeLabel}] ${method} ${url} (attempt ${attempt + 1}/${MAX_RETRIES}, elapsed ${Date.now() - startTime}ms)`,
        );

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const options: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${amigoToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        };

        if (body && (method === "POST" || method === "PUT")) {
          options.body = JSON.stringify(body);
        }

        const res = await fetch(url, options);
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          console.log(
            `[Amigo][${modeLabel}] ✅ Success ${url} - ${res.status} (attempt ${attempt + 1}, ${Date.now() - startTime}ms total)`,
          );
          // Cache resposta de disponibilidade apenas se tiver conteúdo útil
          if (isCacheableAvailEndpoint(endpoint, method)) {
            try {
              const normalized = normalizeApiResponse({ data, status: res.status });
              const hasContent = Array.isArray(normalized) ? normalized.length > 0 : !!normalized;
              if (hasContent) {
                const ttl = getAvailTTL(endpoint);
                availCache.set(endpoint, { data, status: res.status, expiresAt: Date.now() + ttl });
                console.log(`[availCache] STORE ${endpoint} ttl=${ttl}ms`);
              }
            } catch (_cacheErr) { /* non-blocking */ }
          }
          return { data, status: res.status };
        }


        const errorText = await res.text();
        console.log(`[Amigo][${modeLabel}] Failed ${url} - ${res.status} - ${errorText.substring(0, 200)}`);

        // ROTA INEXISTENTE ≠ FALHA DA API (11/08). As duas bases servem conjuntos
        // DIFERENTES de rotas: `patients/exists` só existe na legada, e a oficial
        // responde 404 {"message":"Route Not found."} — sempre, por construção.
        // Como `lastError` guardava só o ÚLTIMO erro, toda falha de uma rota legada
        // era reportada como "404: Route Not found" no lugar da causa verdadeira
        // (timeout da base legada). Foi exatamente isso que fez o relatório do dia
        // 10/08 concluir "investigar o 404 no /patients/exists" — um erro que o
        // nosso próprio relato inventou. Agora esse 404 estrutural não vira
        // `lastError`, e a base que não serve a rota é pulada nas tentativas
        // seguintes desta mesma chamada, em vez de gastar o teto de wall-clock
        // batendo numa porta que nunca vai abrir.
        const rotaInexistente = res.status === 404 && /route\s+not\s+found/i.test(errorText);
        if (rotaInexistente) {
          basesSemEstaRota.add(baseUrl);
          console.log(`[Amigo][${modeLabel}] ${baseUrl} não serve esta rota — pulando nas próximas tentativas`);
          continue;
        }

        lastError = `${res.status}: ${errorText.substring(0, 200)}`;

        // 404 COM CORPO ≠ 404 DE ROTA (16/08). Este 404 já passou pelo filtro de
        // "Route Not found" acima, então é o Amigo RESPONDENDO em nível de
        // aplicação — na prática `{"code":"001","message":"Paciente não
        // encontrado."}`, que é exatamente o que o fluxo de cadastro precisa
        // ouvir. O código só guardava em `lastError` e ia para a próxima base:
        // ninguém devolvia esse 404, a chamada percorria o ladder de retry
        // inteiro e terminava no 502 sintético, e o paciente ouvia "Estou com
        // uma instabilidade momentânea no sistema" e o fluxo morria ali.
        // Medido em webhook_messages: 11 msgs / 10 conversas na semana de 10/08,
        // 14 / 11 na de 03/08 e 11 / 10 na de 27/07 — ~10% das ~100 conversas de
        // agendar por semana — e 5 delas terminaram em transferred_transient_loop.
        // Casos reais: Maria Luiza 11/08 (desistiu da Julia e agendou pelo
        // widget) e o caso do Dr. Hugo 14/08 (a paciente perguntou "não foi
        // possível marcar a consulta?" e a Mardila agendou na mão).
        // NÃO devolve aqui dentro: guarda e continua para a outra base, porque
        // se ela responder 2xx o paciente EXISTE e o 404 era só a base errada.
        // Só depois de esgotar as bases o 404 vira retorno (logo após o laço).
        // Corpo vazio segue no comportamento antigo — 404 sem texto pode ser
        // rota ausente que não se identifica, e aí ainda vale tentar de novo.
        if (res.status === 404) {
          if (!resposta404DeAplicacao && errorText.trim().length > 0) {
            resposta404DeAplicacao = { data: { error: errorText, status: 404 }, status: 404 };
          }
          continue;
        }
        // 401/403: auth broken, no retry will fix it — bail immediately
        if (res.status === 401 || res.status === 403) {
          console.log(`[Amigo][${modeLabel}] ❌ Auth error ${res.status}, stopping retries`);
          return { data: { error: errorText, status: res.status }, status: res.status };
        }
        // Other 4xx (400, 422): client error, return for special handling
        if (res.status >= 400 && res.status < 500) {
          return { data: { error: errorText, status: res.status }, status: res.status };
        }
        // 5xx: continue to next URL, will retry on next attempt.
        // MARCA A FALHA GRAVE (16/08). Sem esta linha, o 404 de aplicação
        // guardado numa base curto-circuita o ladder mesmo com a OUTRA base em
        // 500: o chamador ouviria "paciente não cadastrado" no meio de uma queda
        // real do Amigo — o inverso exato do defeito que esta correção conserta,
        // e o cenário que o Tema 3 (index.ts) proíbe por risco de duplicata.
        tentativaComFalhaGrave = attempt;
      } catch (e: any) {
        const errorType = e.name === "AbortError" ? "TIMEOUT" : "NETWORK";
        console.log(
          `[Amigo][${modeLabel}] ${errorType} ${baseUrl}/${endpoint}: ${e.message} (attempt ${attempt + 1}, ${Date.now() - startTime}ms)`,
        );
        lastError = `${errorType}: ${e.message}`;
        tentativaComFalhaGrave = attempt;
      }
    }

    // Nenhuma base devolveu 2xx, mas alguma RESPONDEU 404 de aplicação: isso é
    // resposta, não queda. Retentar não transforma "paciente não cadastrado" em
    // "paciente cadastrado" — só queima o orçamento de wall-clock e termina no
    // 502 sintético, que o chamador lê como instabilidade.
    // Medido: 5 ocorrências PROVADAS em 4 dias (11/08=2, 12/08=1, 14/08=2), todas
    // com {"code":"001","message":"Paciente não encontrado."} em patients/exists.
    // As ~36 anteriores tinham o rótulo "Route Not found" clobbado e são
    // COMPATÍVEIS com este defeito, não provadas.
    // Guard: se NESTA tentativa alguma base deu timeout, erro de rede ou 5xx, o
    // 404 da outra não é palavra final — continua no ladder.
    if (resposta404DeAplicacao && tentativaComFalhaGrave !== attempt) {
      console.log(
        `[Amigo][${modeLabel}] 404 de aplicação em ${endpoint} — RESPOSTA do Amigo, não instabilidade (${Date.now() - startTime}ms)`,
      );
      return resposta404DeAplicacao;
    }

    // Rota ausente em TODAS as bases é erro de configuração/deploy, não queda do
    // Amigo. Sem isto o laço continuava dormindo o backoff inteiro (2s+4s+8s em
    // modo critical) com as duas bases já marcadas e nenhuma requisição a fazer.
    if (basesSemEstaRota.size === API_URLS.length) {
      // NÃO sobrescreve uma causa real já registrada (timeout/5xx de uma
      // tentativa anterior): esse clobber de `lastError` é exatamente o defeito
      // que o fix de 11/08 consertou.
      const detalhe = `rota inexistente em todas as bases (${endpoint})`;
      lastError = lastError === "Todas as URLs da API falharam" ? detalhe : `${lastError} + ${detalhe}`;
      console.log(`[Amigo][${modeLabel}] ❌ ${detalhe} — abortando retries`);
      break;
    }
  }
  console.log(
    `[Amigo][${modeLabel}] ❌ ALL URLs failed after ${MAX_RETRIES} attempts, ${Date.now() - startTime}ms total: ${lastError}`,
  );
  return { data: { error: `Todas as URLs da API falharam após ${MAX_RETRIES} tentativas: ${lastError}` }, status: 502 };
}
