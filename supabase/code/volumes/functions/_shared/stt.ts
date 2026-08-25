// _shared/stt.ts — TRANSCRIÇÃO DE ÁUDIO (Whisper)
//
// ============================================================================
// 24/08: SAÍDA DO GROQ, ENTRADA DO DEEPINFRA
// ============================================================================
// Paciente manda áudio no WhatsApp o tempo todo; sem transcrição a Julia não
// entende nada e a conversa morre. Isso rodava no Groq (`api.groq.com`); passa a
// rodar no DeepInfra, junto com a saída do Lovable, para concentrar o que é de
// terceiros em menos fornecedores.
//
// A API do DeepInfra é compatível com a da OpenAI — o mesmo dialeto que o Groq
// falava. Por isso a troca é de ENDEREÇO, CHAVE e ID DE MODELO: o corpo continua
// multipart/form-data com `file`, `model`, `language` e `response_format`, e a
// resposta continua trazendo `text`.
//
// CONFIRA o id do modelo em https://deepinfra.com/models/automatic-speech-recognition
// antes do corte. O DeepInfra prefixa os modelos com o dono (`openai/whisper-...`),
// enquanto o Groq usava o nome cru (`whisper-large-v3-turbo`) — é justamente o
// tipo de detalhe que faz a transcrição falhar em silêncio, com o paciente
// mandando áudio e a Julia respondendo como se não tivesse recebido nada.
//
// Tudo é variável de ambiente: trocar de modelo ou de provedor não precisa deploy.

const env = (nome: string): string | undefined =>
  typeof (globalThis as any).Deno !== "undefined" ? (globalThis as any).Deno.env.get(nome) : undefined;

export const STT_ENDPOINT =
  env("STT_ENDPOINT_URL") || "https://api.deepinfra.com/v1/openai/audio/transcriptions";

// DEEPINFRA_API_KEY é o nome esperado; STT_API_KEY existe para o dia em que o
// provedor mudar. DE PROPÓSITO não lê GROQ_API_KEY: a saída é definitiva, e um
// fallback silencioso esconderia uma migração pela metade.
export function sttApiKey(): string {
  return env("DEEPINFRA_API_KEY") || env("STT_API_KEY") || "";
}

export const STT_MODEL = env("STT_MODEL") || "openai/whisper-large-v3-turbo";

// Fixo em português: a clínica atende no Brasil, e deixar o Whisper adivinhar o
// idioma piora a transcrição de áudio curto ("oi", "sim") — ele às vezes chuta
// espanhol e devolve palavra errada.
export const STT_LANGUAGE = env("STT_LANGUAGE") || "pt";

// verbose_json é o que traz `duration`, usada para (a) contabilizar custo e
// (b) decidir se o áudio é longo o bastante para valer um resumo (>60s).
// Se o provedor não devolver duration, nada quebra: o custo deixa de ser
// registrado e áudio longo deixa de ser resumido — degradação silenciosa, então
// quem chama deve avisar no log quando vier zero.
export const STT_RESPONSE_FORMAT = env("STT_RESPONSE_FORMAT") || "verbose_json";
