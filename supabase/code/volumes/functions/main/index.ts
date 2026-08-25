// main — o ROTEADOR das edge functions no Supabase self-hosted
//
// ============================================================================
// POR QUE ESTE ARQUIVO EXISTE
// ============================================================================
// No Supabase Cloud não existe nada disso: você roda `functions deploy` e a
// plataforma cuida do resto. No self-hosted, o container `edge-runtime` sobe com
//
//     command: ["start", "--main-service", "/home/deno/functions/main"]
//
// e é ESTE arquivo o `--main-service`. Toda requisição a /functions/v1/<nome>
// cai aqui; é aqui que se decide autenticação e é daqui que um worker é criado
// para a função pedida.
//
// Sem ele, TODA função devolve HTTP 500 com
//     InvalidWorkerCreation: worker boot error: failed to bootstrap runtime:
//     could not find an appropriate entrypoint
// que foi exatamente o que o backend novo estava devolvendo em 24/08.
//
// ============================================================================
// O PROBLEMA QUE ELE RESOLVE (e que a versão de exemplo do Supabase NÃO resolve)
// ============================================================================
// O compose padrão tem uma única variável, FUNCTIONS_VERIFY_JWT, valendo para
// TODAS as funções. Este sistema precisa das duas coisas ao mesmo tempo:
//
//   • 20 funções PÚBLICAS — o whatsapp-webhook e o avanceai-webhook são chamados
//     pelo AvanceAI, que não tem como mandar JWT; o booking-widget é chamado do
//     site da clínica; os 8 crons chamam com service_role. Exigir JWT aqui deixa
//     a Julia MUDA no WhatsApp.
//   • 2 funções PRIVADAS — organize-clinic-data e generate-technical-report.
//     A primeira NÃO valida Authorization no próprio código: sem JWT imposto
//     aqui, ela vira endpoint aberto na internet queimando crédito de LLM.
//
// Com a variável global é escolher uma das duas. Por isso a lista abaixo, que
// reproduz exatamente o que o supabase/config.toml declarava na nuvem.

// ── Quem NÃO exige JWT ──────────────────────────────────────────────────────
// Espelho do `verify_jwt = false` do supabase/config.toml. Ao criar função nova,
// atualize OS DOIS lugares — o config.toml continua valendo como documentação.
const PUBLICAS = new Set([
  "ai-script-editor",
  "amigo-proxy",
  "avanceai-webhook",
  "booking-widget",
  "generate-daily-report",
  "human-transfer-timeout",
  "list-attendants",
  "list-avanceai-channels",
  "manage-staff-account",
  "patient-recovery",
  "process-lost-conversions",
  "process-pending-followups",
  "process-waitlist",
  "refresh-ticket-status",
  "resolve-ticket",
  "send-avanceai-message",
  "sync-amigo-cache",
  "transfer-ticket",
  "verify-booking",
  "whatsapp-webhook",
]);

// ── Limites por função ──────────────────────────────────────────────────────
// O exemplo do Supabase usa 150 MB e 60 s para tudo. Aqui isso não serve:
//   • whatsapp-webhook é um arquivo de ~15 mil linhas e, numa mensagem, pode
//     encadear classificação por LLM, chamadas à API do Amigo com retry e
//     backoff, e geração da resposta. Com 60 s ele é morto no meio e o paciente
//     fica sem resposta — falha que aparece como silêncio, não como erro.
//   • os geradores de relatório mandam o dia inteiro de conversas para o LLM.
// Números folgados de propósito: o custo de um limite alto é memória ociosa; o
// custo de um limite baixo é conversa de paciente cortada pela metade.
const LIMITES: Record<string, { memoriaMb: number; timeoutMs: number }> = {
  "whatsapp-webhook":          { memoriaMb: 512, timeoutMs: 150_000 },
  "booking-widget":            { memoriaMb: 256, timeoutMs: 120_000 },
  "generate-daily-report":     { memoriaMb: 512, timeoutMs: 400_000 },
  "generate-technical-report": { memoriaMb: 512, timeoutMs: 400_000 },
  "process-waitlist":          { memoriaMb: 256, timeoutMs: 180_000 },
  "patient-recovery":          { memoriaMb: 256, timeoutMs: 180_000 },
  "process-lost-conversions":  { memoriaMb: 256, timeoutMs: 180_000 },
  "sync-amigo-cache":          { memoriaMb: 256, timeoutMs: 180_000 },
  "verify-booking":            { memoriaMb: 256, timeoutMs: 120_000 },
};
const LIMITE_PADRAO = { memoriaMb: 256, timeoutMs: 120_000 };

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "";

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64UrlParaBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Verificação HS256 com Web Crypto, que já vem no Deno — de propósito SEM
// importar `jose` de um CDN. O roteador é a peça que precisa funcionar sempre:
// depender de download remoto no boot significa que uma instabilidade de rede
// derruba TODAS as funções de uma vez.
// Só cobre HS256, que é o que o Supabase self-hosted usa com JWT_SECRET. Se um
// dia migrar para chave assimétrica (RS256/ES256), esta função precisa mudar.
async function jwtValido(token: string): Promise<boolean> {
  if (!JWT_SECRET) return false;
  const partes = token.split(".");
  if (partes.length !== 3) return false;
  const [cabecalho, carga, assinatura] = partes;
  try {
    const alg = JSON.parse(new TextDecoder().decode(base64UrlParaBytes(cabecalho)))?.alg;
    if (alg !== "HS256") {
      console.error(`[main] JWT com alg=${alg}; este roteador só valida HS256`);
      return false;
    }
    const chave = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      chave,
      base64UrlParaBytes(assinatura),
      new TextEncoder().encode(`${cabecalho}.${carga}`),
    );
    if (!ok) return false;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlParaBytes(carga)));
    if (payload?.exp && Math.floor(Date.now() / 1000) >= Number(payload.exp)) {
      console.error("[main] JWT expirado");
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[main] JWT inválido: ${(e as Error).message}`);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const { pathname } = new URL(req.url);
  // O Kong tira o prefixo /functions/v1 antes de encaminhar, então o primeiro
  // segmento que chega aqui já é o nome da função.
  const nome = pathname.split("/")[1];

  if (!nome) {
    return json({ msg: "faltou o nome da função na requisição" }, 400);
  }

  // Preflight de CORS passa SEMPRE, sem autenticação. O navegador manda OPTIONS
  // sem Authorization; barrar aqui faria o painel falhar em toda chamada de
  // função, com um erro de CORS que não diz nada sobre JWT.
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type, x-cron-secret",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
      },
    });
  }

  if (!PUBLICAS.has(nome)) {
    const auth = req.headers.get("authorization") || "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token || !(await jwtValido(token))) {
      console.error(`[main] 401 em ${nome}: JWT ausente ou inválido`);
      return json({ msg: "Unauthorized" }, 401);
    }
  }

  const servicePath = `/home/deno/functions/${nome}`;
  const limite = LIMITES[nome] || LIMITE_PADRAO;

  try {
    const ambiente = Deno.env.toObject();
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: limite.memoriaMb,
      workerTimeoutMs: limite.timeoutMs,
      noModuleCache: false,
      importMapPath: null,
      envVars: Object.keys(ambiente).map((k) => [k, ambiente[k]]),
    });
    return await worker.fetch(req);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // Mensagem específica para o erro que mais confunde: função que não existe no
    // volume. O texto cru do runtime ("could not find an appropriate entrypoint")
    // não diz QUAL função nem ONDE ela deveria estar.
    console.error(`[main] falha ao criar worker de "${nome}" em ${servicePath}: ${msg}`);
    return json(
      {
        msg: `Falha ao executar a função "${nome}"`,
        detalhe: msg,
        dica: `Confira se existe ${servicePath}/index.ts dentro do container do edge-runtime.`,
      },
      500,
    );
  }
});
