// Uma execução por vez por conversa (16/11/2026, etapa 3 do plano de 15/11).
//
// Cada mensagem do paciente dispara uma execução do webhook. O lote junta as que chegam com
// menos de 8 s entre si; as que chegam DEPOIS disso, com a anterior ainda sendo respondida
// (10 a 25 s), rodavam em paralelo, cada uma sem saber o que a outra fez:
//   • "seu retorno foi agendado…" e, 16 s depois, "entendi que você deseja o retorno…" e
//     "pode me dizer qual é a sua dúvida?" (16/11 11:58) — três respostas, a segunda negando
//     a primeira;
//   • a resposta da mensagem mais velha era suprimida ("anti-responso") e o que ela trazia
//     não chegava à mais nova: o CPF numa mensagem, o nome na seguinte, e a Julia pedindo o
//     CPF três vezes até passar para a fila (Raquel, 13/11). Em 30 dias, 140 mensagens
//     suprimidas, 13 delas com CPF.
//
// A trava: quem chega espera a execução anterior TERMINAR (resposta enviada ou suprimida) e
// só então começa, já com o histórico em dia. E quando começa, leva junto o que ficou sem
// resposta: as mensagens ainda pendentes e as que foram suprimidas logo antes dela.
//
// Segurança: a trava nunca segura a Julia. Erro ao ler ou gravar a trava, tabela ausente ou
// espera além do limite → a execução segue sem trava, como era antes. A trava de quem morreu
// no meio vence sozinha (VEZ_VALIDADE_MS).

/** Depois disso a trava é considerada abandonada (a execução morreu) e outra pode tomá-la. */
export const VEZ_VALIDADE_MS = 60_000;
/** Quanto uma execução espera pela anterior antes de seguir sem trava. */
export const VEZ_ESPERA_MAX_MS = 35_000;
export const VEZ_PASSO_MS = 1_500;
/** Só entra no lote o que chegou há pouco: mensagem velha tem a sua própria história. */
export const VEZ_JANELA_DO_LOTE_MS = 120_000;

export type MotivoDaVez = "livre" | "esperou" | "tempo_esgotado" | "erro";
export interface ResultadoDaVez {
  /** true: esta execução está com a vez. false: segue sem trava (como era antes). */
  pegou: boolean;
  esperouMs: number;
  motivo: MotivoDaVez;
}

interface OpcoesDaVez {
  esperaMaxMs?: number;
  passoMs?: number;
  validadeMs?: number;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

const TABELA = "conversa_em_andamento";

/**
 * Tenta ficar com a vez da conversa. A chave primária da tabela é a conversa: o INSERT de
 * quem chega depois falha (23505) enquanto a linha existir. Qualquer outro erro → sem trava.
 */
// deno-lint-ignore no-explicit-any
export async function pegarVezDaConversa(supabase: any, conversationId: string, messageId: string, opcoes: OpcoesDaVez = {}): Promise<ResultadoDaVez> {
  const esperaMax = opcoes.esperaMaxMs ?? VEZ_ESPERA_MAX_MS;
  const passo = opcoes.passoMs ?? VEZ_PASSO_MS;
  const validade = opcoes.validadeMs ?? VEZ_VALIDADE_MS;
  const agora = opcoes.agora ?? (() => Date.now());
  const dormir = opcoes.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inicio = agora();
  try {
    while (true) {
      // a trava de quem morreu no meio sai do caminho
      await supabase.from(TABELA).delete().eq("conversation_id", conversationId)
        .lt("desde", new Date(agora() - validade).toISOString());
      const { error } = await supabase.from(TABELA).insert({ conversation_id: conversationId, message_id: messageId });
      if (!error) {
        const esperou = agora() - inicio;
        return { pegou: true, esperouMs: esperou, motivo: esperou >= passo ? "esperou" : "livre" };
      }
      if (String((error as { code?: string }).code || "") !== "23505") {
        return { pegou: false, esperouMs: agora() - inicio, motivo: "erro" };
      }
      if (agora() - inicio >= esperaMax) {
        return { pegou: false, esperouMs: agora() - inicio, motivo: "tempo_esgotado" };
      }
      await dormir(passo);
    }
  } catch (_e) {
    return { pegou: false, esperouMs: agora() - inicio, motivo: "erro" };
  }
}

/** Devolve a vez. Só apaga a linha desta execução; erro aqui não interessa (a trava vence sozinha). */
// deno-lint-ignore no-explicit-any
export async function soltarVezDaConversa(supabase: any, conversationId: string, messageId: string): Promise<void> {
  try {
    await supabase.from(TABELA).delete().eq("conversation_id", conversationId).eq("message_id", messageId);
  } catch (_e) { /* a trava vence sozinha */ }
}

export interface LinhaDaConversa {
  id: string;
  direction: string;
  action_status: string | null;
  message_text: string | null;
  created_at: string;
}

export type LoteDaVez =
  | { sair: true }
  | { sair: false; texto: string | null; juntar: string[]; suprimidas: number; pendentes: number };

const ehMidia = (t: string | null) => /^\[(?:🎤|📎)/u.test(String(t || "").trim());

/**
 * Com a vez na mão: o que entra no processamento desta mensagem.
 *
 * `linhas` — as linhas recentes da conversa (entrada e saída), da mais antiga para a mais nova.
 *   • a minha linha já foi juntada por outra execução ("batched") → sair, sem responder;
 *   • mensagens de texto ainda PENDENTES da conversa (mais velhas ou mais novas) entram no meu
 *     lote: quem tem a vez responde por todas, e as execuções delas saem ao ver "batched";
 *   • mensagens SUPRIMIDAS logo antes de mim (a resposta delas não saiu porque eu cheguei)
 *     entram também — é assim que o CPF de uma mensagem e o nome da seguinte viram uma fala só.
 *     A volta para trás para na primeira resposta enviada ou mensagem já respondida.
 * Áudio e arquivo não entram no lote de outra: têm a transcrição e o aviso próprios.
 */
export function montarLoteDaVez(
  meuId: string,
  linhas: ReadonlyArray<LinhaDaConversa>,
  /** o texto que esta execução já tem em mãos (lote consolidado, áudio transcrito); senão vale o da linha */
  meuTexto?: string | null,
  janelaMs = VEZ_JANELA_DO_LOTE_MS,
): LoteDaVez {
  const ordenadas = [...(linhas || [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const i = ordenadas.findIndex((l) => l.id === meuId);
  if (i < 0) return { sair: false, texto: null, juntar: [], suprimidas: 0, pendentes: 0 };
  const minha = ordenadas[i];
  if (minha.action_status === "batched") return { sair: true };
  const meuMs = Date.parse(minha.created_at);
  const naJanela = (l: LinhaDaConversa) => Math.abs(Date.parse(l.created_at) - meuMs) <= janelaMs;

  const pendentes = ordenadas.filter((l) =>
    l.id !== meuId && l.direction === "incoming" && l.action_status === "pending" && naJanela(l) && !ehMidia(l.message_text)
  );

  const suprimidas: LinhaDaConversa[] = [];
  for (let k = i - 1; k >= 0; k--) {
    const l = ordenadas[k];
    if (!naJanela(l)) break;
    if (l.direction !== "incoming") break; // uma resposta saiu: dali para trás já foi conversado
    if (l.action_status === "batched" || l.action_status === "pending") continue; // já está no texto de outra / entra como pendente
    if (l.action_status !== "superseded_by_newer") break; // mensagem respondida ou pulada: para
    if (!ehMidia(l.message_text)) suprimidas.push(l);
  }

  if (pendentes.length === 0 && suprimidas.length === 0) {
    return { sair: false, texto: null, juntar: [], suprimidas: 0, pendentes: 0 };
  }
  const partes = [...suprimidas, ...pendentes, minha].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const texto = partes
    .map((l) => String((l.id === meuId && meuTexto != null ? meuTexto : l.message_text) || "").trim())
    .filter(Boolean)
    .join("\n");
  return {
    sair: false,
    texto,
    juntar: partes.filter((l) => l.id !== meuId).map((l) => l.id),
    suprimidas: suprimidas.length,
    pendentes: pendentes.length,
  };
}
