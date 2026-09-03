// _shared/llm.ts — O PROVEDOR DE LLM DA JULIA
//
// ============================================================================
// 24/08: SAÍDA DO LOVABLE, ENTRADA DO OPENROUTER
// ============================================================================
// Até aqui as chamadas de LLM iam para `ai.gateway.lovable.dev` (e uma, na
// patient-recovery, para `api.lovable.dev` — dois hosts diferentes, o que já
// tinha feito uma delas ficar para trás em trocas anteriores). Sair do Supabase
// Cloud NÃO desligava essa dependência: mesmo com a infra própria no ar, a conta
// do Lovable precisava continuar com crédito ou a Julia parava de responder
// paciente. Decisão do dono: desvincular totalmente.
//
// O OpenRouter é compatível com a API da OpenAI, que é o mesmo formato que o
// gateway do Lovable falava. Por isso a troca é de ENDEREÇO e CHAVE, não de
// formato: corpo, `messages`, `tools`, `usage` e os códigos de erro (429 cota,
// 402 sem crédito) continuam iguais. Nada do prompt precisou mudar.
//
// Os ids de modelo também seguem a convenção `provedor/modelo`, a mesma que o
// código já usava (`google/gemini-...`). CONFIRA os ids exatos em
// https://openrouter.ai/models antes do corte — id errado faz o gateway
// devolver 400, o fallback entra, e se os DOIS estiverem errados a Julia
// emudece. `ehErroDeModeloDesconhecido` abaixo detecta esse caso e o log diz
// exatamente o que trocar.
//
// Trocar de modelo ou até de provedor continua sendo variável de ambiente, sem
// deploy: LLM_MODEL, LLM_MODEL_FALLBACK e LLM_GATEWAY_URL.

// `typeof Deno` em vez de `Deno.env` direto: a suíte de testes roda em Node e
// importa este módulo. Sem o guard, o import explode antes de qualquer teste.
const env = (nome: string): string | undefined =>
  typeof (globalThis as any).Deno !== "undefined" ? (globalThis as any).Deno.env.get(nome) : undefined;

// Endpoint. Compatível com a API da OpenAI — trocar de provedor de novo no futuro
// é só apontar esta variável para outro endpoint que fale o mesmo dialeto.
export const LLM_GATEWAY = env("LLM_GATEWAY_URL") || "https://openrouter.ai/api/v1/chat/completions";

// Chave. OPENROUTER_API_KEY é o nome esperado; LLM_API_KEY existe para o dia em
// que o provedor mudar e o nome específico deixar de fazer sentido.
// DE PROPÓSITO não lê LOVABLE_API_KEY: a saída é definitiva, e um fallback
// silencioso para o Lovable esconderia uma migração incompleta.
export function llmApiKey(): string {
  return env("OPENROUTER_API_KEY") || env("LLM_API_KEY") || "";
}

// Cabeçalhos padrão de toda chamada. HTTP-Referer e X-Title são opcionais no
// OpenRouter, mas é com eles que o consumo aparece identificado no painel deles —
// sem isso, todo gasto vira uma linha anônima e fica impossível saber o que gastou.
export function llmHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${llmApiKey()}`,
    "HTTP-Referer": env("LLM_APP_URL") || "https://cbtortopedia.com.br",
    "X-Title": env("LLM_APP_NAME") || "Julia - CBT Ortopedia",
  };
}

// 3.7 Flash. Medido no próprio OpenRouter em 24/08, com o mesmo prompt real de
// atendimento e max_tokens=1500: 3.7 custou US$ 0,000798 contra US$ 0,001743 do
// 3.6 — menos da METADE, e com menos tokens de saída (417 contra 456). É o modelo
// que o dono queria desde 16/08; na época o gateway do Lovable não o servia e
// ficamos no 3.6. No OpenRouter ele existe.
//
// ATENÇÃO ao trocar: 3.6 e 3.7 são modelos de RACIOCÍNIO, e os tokens de
// pensamento contam como saída. `reasoning: { enabled: false }` é RECUSADO pelo
// endpoint ("Reasoning is mandatory for this endpoint and cannot be disabled") —
// testado, não suposto. Por isso max_tokens continua alto: com max_tokens=60 o
// 3.7 devolve finish_reason=length e a frase sai pela metade, que foi exatamente
// o incidente de 17/08 (58% das mensagens da Julia cortadas).
export const LLM_MODEL = env("LLM_MODEL") || "google/gemini-3.7-flash";

// Rede de segurança: se o gateway recusar o id, os caminhos que o PACIENTE vê
// caem sozinhos para o modelo alternativo, em vez de deixar a conversa sem
// resposta. Vale para qualquer troca futura de modelo, não só para esta.
//
// Escolha deliberada: este NÃO é modelo de raciocínio. No mesmo teste de 24/08 ele
// respondeu "ok" gastando 1 token de saída, enquanto 3.6 e 3.7 gastaram 16-17 só
// pensando. Como fallback isso é uma qualidade: se o modelo principal falhar, o
// substituto responde rápido e barato, sem risco de estourar max_tokens.
export const LLM_MODEL_FALLBACK = env("LLM_MODEL_FALLBACK") || "google/gemini-3-flash-preview";

// O gateway recusa modelo desconhecido com 400/404 e o texto citando o modelo.
// Erro de cota (429) ou queda (5xx) NÃO é caso de trocar de modelo — trocar ali
// só esconderia o problema real e gastaria no modelo errado.
export function ehErroDeModeloDesconhecido(status: number, corpo: string): boolean {
  if (status !== 400 && status !== 404) return false;
  const t = String(corpo || "").toLowerCase();
  return t.includes("model") && (t.includes("not found") || t.includes("not_found") ||
    t.includes("unsupported") || t.includes("invalid") || t.includes("does not exist"));
}

// ── Custo ───────────────────────────────────────────────────────────────────
// A tabela de preços estava COPIADA em quatro arquivos (whatsapp-webhook,
// ai-script-editor, organize-clinic-data, patient-recovery). Cada troca de modelo
// exigia lembrar dos quatro, e na prática eles divergiam.
//
// Agora há um caminho melhor: o OpenRouter devolve o custo REAL da chamada quando
// o corpo pede `usage: { include: true }` — em `usage.cost`, já em dólares. Com
// isso o número no painel para de depender de uma tabela que envelhece sozinha.
// A tabela continua como último recurso, para quando o provedor não informar.
export const LLM_USAGE_INCLUDE = { include: true } as const;

// Preços LIDOS de https://openrouter.ai/api/v1/models em 24/08, não copiados da
// tabela antiga do Lovable — que estava errada no preview (dizia 0,15/0,60, que
// na verdade custa 0,50/3,00). O 3.7 eu mesmo errei em 24/08, anotando o preço da
// variante :batch; corrigido em 02/09. Só serve de estimativa quando não devolve
// `usage.cost`; com `usage: { include: true }` o número é o real.
const PRECO_POR_TOKEN: Record<string, { input: number; output: number }> = {
  "google/gemini-3-flash-preview": { input: 0.50 / 1e6, output: 3.00 / 1e6 },
  "google/gemini-3.6-flash":       { input: 0.75 / 1e6, output: 3.75 / 1e6 },
  // ATENÇÃO (02/09): 0,375/1,875 é o preço do `google/gemini-3.7-flash:batch`,
  // NÃO do modelo síncrono. O `:batch` custa metade porque não responde na hora —
  // chamá-lo pelo /chat/completions devolve 404 ("This model is only available
  // through the Batch API. Use the /api/beta/batches endpoint instead."). Quem
  // atende paciente no WhatsApp não pode usar. Se esta tabela voltar a marcar
  // metade, o custo estimado sai pela metade. (Na prática ela quase nunca roda:
  // o OpenRouter devolve `usage.cost` e custoDaChamada prefere sempre esse valor —
  // 1.183 chamadas em 7 dias, zero caíram na estimativa.)
  "google/gemini-3.7-flash":       { input: 0.75 / 1e6, output: 3.75 / 1e6 },
  "google/gemini-2.5-flash":       { input: 0.30 / 1e6, output: 2.50 / 1e6 },
};

/**
 * Custo em dólares de uma chamada. Prefere SEMPRE o valor informado pelo
 * provedor (`usage.cost`); só estima pela tabela quando ele não vier.
 */
export function custoDaChamada(model: string, usage: any): number {
  const informado = Number(usage?.cost);
  if (Number.isFinite(informado) && informado > 0) return informado;
  const p = PRECO_POR_TOKEN[model] || { input: 0.50 / 1e6, output: 1.50 / 1e6 };
  const pt = Number(usage?.prompt_tokens) || 0;
  const ct = Number(usage?.completion_tokens) || 0;
  return pt * p.input + ct * p.output;
}
