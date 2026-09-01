// Cron function: checks pending_human_transfers and reassigns or expires
// transfers where the human didn't respond within the configured timeout.
//
// Triggered by pg_cron every 1-2 minutes. Idempotent (safe to run twice).
//
// Logic:
// 1. Fetch all pending_human_transfers with expected_response_by <= now()
// 2. For each row:
//    a. Re-fetch online attendants for the clinic
//    b. Run selectAttendant() excluding previous_attendants + current
//    c. If new candidate available AND attempts_count < max_reassignment_attempts:
//       - Call transferTicketToHuman to AvanceAI with new attendantId
//       - Update row with new attendant, status stays 'pending', expected_response_by extended
//       - Insert routing_log entry with reason "timeout_reassignment"
//    d. If no candidates left OR reached max attempts:
//       - Mark status='expired', resolved_reason='no_more_candidates' or 'max_attempts_reached'
//       - Insert routing_log entry for audit

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { exigeRespostaDaAtendente, prazoDeRespostaEmMinutos } from "../_shared/atendimento.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

type AttendantUser = { id: any; name: string; online?: boolean; status?: string; profile?: string; role?: string };

async function fetchOnlineAttendants(baseUrl: string, apiId: string, bearerToken: string, excludeNames: string[] = []): Promise<{ all: AttendantUser[]; online: AttendantUser[] }> {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}/listUsers`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(tid));
    if (!res.ok) return { all: [], online: [] };
    const data: any = await res.json();
    let users: AttendantUser[] = [];
    if (Array.isArray(data)) users = data;
    else if (Array.isArray(data?.users)) users = data.users;
    else if (Array.isArray(data?.data)) users = data.data;
    let nonAdmin = users.filter((u) => String((u as any).profile || (u as any).role || "").toLowerCase() !== "admin");
    // Drop users disabled/inactive in AvanceAI
    nonAdmin = nonAdmin.filter((u: any) => {
      if (u.active === false) return false;
      if (u.enabled === false) return false;
      if (u.disabled === true) return false;
      if (u.deletedAt) return false;
      const st = String(u.status || "").toLowerCase();
      if (st === "disabled" || st === "inactive" || st === "blocked") return false;
      return true;
    });
    // Drop vacationing attendants
    if (excludeNames.length > 0) {
      nonAdmin = nonAdmin.filter((u) => {
        const n = stripAccents(String(u.name || "").toLowerCase().trim());
        return !excludeNames.some((v) => n === v || n.includes(v) || v.includes(n));
      });
    }
    const online = nonAdmin.filter((u) => {
      if ((u as any).online === false) return false;
      if (typeof (u as any).status === "string" && String((u as any).status).toLowerCase() === "offline") return false;
      return true;
    });
    return { all: nonAdmin, online };
  } catch {
    return { all: [], online: [] };
  }
}

function parseVacationNames(customNotes?: string | null): string[] {
  if (!customNotes) return [];
  const match = customNotes.match(/Atendentes\s+de\s+F[eé]rias\s*:\s*([^\n]+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((n) => stripAccents(n.trim().replace(/[*_`.;]/g, "").trim().toLowerCase()))
    .filter(Boolean);
}


async function transferTicket(baseUrl: string, apiId: string, bearerToken: string, phone: string, userId: any): Promise<boolean> {
  try {
    const cleanPhone = phone.replace(/\D/g, "");
    const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}/transferTicket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ number: fullPhone, userId }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(tid));
    return res.ok;
  } catch {
    return false;
  }
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}


// ─────────────────────────────────────────────────────────────────────────────
// FASE 2 — DEVOLUÇÃO À FILA POR INATIVIDADE (pedido do dono, 25/08)
// ─────────────────────────────────────────────────────────────────────────────
// Diferente da Fase 1 (que reatribui uma transferência que a Julia iniciou),
// esta olha o atendimento JÁ EM CURSO: a atendente pegou o ticket, o paciente
// perguntou, e ninguém respondeu.
//
// Regra do dono: 10 min para a equipe, 60 para Vânia e Lidiane. Só conta se a
// última mensagem do paciente EXIGE resposta — "obrigada" e documento sem texto
// não devolvem nada.
//
// Desligada por padrão (DEVOLVER_FILA_ENABLED). Ligar é uma variável de
// ambiente, não um deploy — e desligar no meio de um expediente ruim também.
//
// FAIL-CLOSED de propósito: qualquer erro (showticket fora do ar, ticket sem id,
// credencial faltando) PULA aquele ticket em vez de devolver. Devolver por
// engano tira o paciente de quem está resolvendo o caso dele.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO NUNCA DEVOLVEU NADA — medido em 30/08
// ─────────────────────────────────────────────────────────────────────────────
// Entre 25/08 (quando esta fase nasceu) e 30/08 o `transfer_audit` tinha ZERO
// linhas com trigger='inatividade'. Não era falta de caso: na sexta 28/08 dois
// tickets ficaram abertos, com dona, sem uma única resposta — um desde as 14h13,
// outro desde as 16h44 — e ainda estavam assim no domingo de manhã. O cron rodava
// de 2 em 2 minutos, a env estava ligada, e mesmo assim: zero.
//
// Eram DOIS erros somados, os dois calados:
//
//   1. O showticket devolve `{"success":true,"data":{...}}`. O código lia
//      `d.status` e `d.id` — a raiz, não o `data`. Sempre undefined, então o
//      `!== "open"` era sempre verdadeiro e o `continue` levava embora TODA
//      conversa. O caminho da transferência não caiu nessa porque usa o
//      extractTicketIdForTransfer, que procura o ticket dentro de `data`.
//
//   2. A Fase 1 escolhe o canal certo lendo `avanceai_active_channel` (lição
//      19/07, ERR_API_REQUIRES_SESSION). A Fase 2 recebia as credenciais PLANAS
//      da clinic_tokens — que hoje apontam para o canal 143, DESLIGADO. Mesmo
//      com o parse consertado, a chamada iria para a sessão errada.
//
// Um erro escondia o outro, e o silêncio escondia os dois: a função só logava
// quando devolvia alguma coisa. Agora ela loga o resultado SEMPRE, com o motivo
// de cada pulo — zero devoluções passa a ser uma frase no log, não um vazio.
async function devolverInativosAFila(
  supabase: any,
  clinicTokenId: string,
  creds: { baseUrl: string; apiId: string; bearerToken: string; channelId?: string | null },
  prazoPadrao: number,
  prazoEstendido: number,
): Promise<{ avaliados: number; devolvidos: number; detalhes: string[]; pulos: Record<string, number> }> {
  const out = {
    avaliados: 0,
    devolvidos: 0,
    detalhes: [] as string[],
    // Por que cada conversa não virou devolução. Sem isto, "0 devolvidos" não
    // distingue "ninguém estava esperando" de "o parse está quebrado".
    pulos: {} as Record<string, number>,
  };
  const pulou = (motivo: string) => { out.pulos[motivo] = (out.pulos[motivo] || 0) + 1; };

  // Teto por execução: esta fase ficou 5 dias sem rodar de verdade, então a
  // primeira rodada boa encontra atraso acumulado. Devolver 60 tickets de uma
  // vez encheria a fila de casos velhos e esconderia os de hoje. O cron roda de
  // 2 em 2 min: o resto sai na próxima, e o log diz quantos ficaram.
  const TETO_POR_RODADA = 5;

  // ── FREIO DO PINGUE-PONGUE (pedido do dono, 31/08) ──────────────────────────
  // No primeiro dia inteiro com a devolução funcionando, ela devolveu 91 tickets
  // — e 23 dos 36 telefones voltaram MAIS DE UMA VEZ. Um deles oito:
  //
  //   07:58 Vânia   sem responder há 3711min → fila
  //   08:52 Glaucia sem responder há 3765min → fila
  //   09:12 Glaucia ... 10:12 Vânia ... 12:32 ... 16:00 ... 16:02 ... 18:54
  //
  // A atendente pega da fila, não responde, o ticket volta, outra pega, não
  // responde, volta. O dia inteiro, em silêncio, com a paciente esperando desde
  // sexta. Devolver pela nona vez não ia resolver o que oito não resolveram.
  //
  // A partir da 3ª volta o caso PARA de circular e vira uma linha na aba
  // Transferências, para alguém olhar. O ticket fica onde está — com dona — em
  // vez de voltar para uma fila que já provou não resolver este caso.
  //
  // O paciente NÃO recebe mais nada: ele já recebeu o aviso de 15 min, e mandar
  // outra mensagem automática é o caminho do spam de 28/07 (o Mássimo recebeu o
  // mesmo aviso ~50 vezes em 1h43).
  //
  // Medido com os dados de 31/08: 15 das 36 conversas teriam travado, evitando
  // 17 devoluções inúteis. As 21 que rodaram uma ou duas voltas seguem intactas.
  const TETO_DEVOLUCOES = 3;
  const JANELA_FREIO_HORAS = 24;
  const desdeFreio = new Date(Date.now() - JANELA_FREIO_HORAS * 60 * 60 * 1000).toISOString();

  // QUEM ENTRA NA VARREDURA — conversa recente, e SÓ ISSO (30/08).
  //
  // Até agora o filtro era `ticket_status='open' AND assigned_agent_name IS NOT
  // NULL` na chat_conversations. Mas essa tabela é um ESPELHO, e quem a atualiza
  // é o refresh-ticket-status — que não está no pg_cron. Conferido em 30/08 nos
  // dois tickets de sexta que passaram o fim de semana sem resposta: no Z-PRO um
  // estava "open com a Laiz" e o outro "open com a Lidiane"; no espelho, um sem
  // dona e o outro como "pending". Os dois casos que mais precisavam de devolução
  // eram justamente os que o filtro jogava fora.
  //
  // Agora o espelho só serve para ACHAR candidato barato (conversa com mensagem
  // nos últimos dias). Quem diz o status e quem é a dona é o showticket, ao vivo.
  const desde = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: convs } = await supabase
    .from("chat_conversations")
    .select("id, phone, assigned_agent_name, ticket_status, last_message_at")
    .eq("clinic_token_id", clinicTokenId)
    .gte("last_message_at", desde)
    .order("last_message_at", { ascending: false })
    .limit(200);

  for (const c of (convs || [])) {
    // Só para a linha do freio: quem o espelho ACHA que é a dona. A dona de
    // verdade vem do showticket, mais abaixo — mas o freio dispara antes disso,
    // de propósito, para não gastar chamada de API num caso que não vai devolver.
    const nomeEspelho = String(c.assigned_agent_name || "").trim();

    // Última mensagem DO PACIENTE nesta conversa.
    const { data: ultimas } = await supabase
      .from("webhook_messages")
      .select("id, direction, ai_intent, message_text, created_at, raw_payload")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: false })
      .limit(15);

    const msgs = (ultimas || []);
    const ultimaDoPaciente = msgs.find((m: any) => m.direction === "incoming");
    if (!ultimaDoPaciente) { pulou("sem_mensagem_do_paciente"); continue; }

    // Alguém respondeu DEPOIS dela? Conta tanto a atendente (manual_reply)
    // quanto a própria Julia — se a IA respondeu, o paciente não está no vácuo.
    //
    // MENOS O PRÓPRIO AVISO DE TIMEOUT (30/08). "A Fulana está finalizando outro
    // atendimento e já já te responde" não é resposta: é a Julia falando da
    // espera. Contando como resposta, o aviso IMUNIZAVA o caso — mandava a
    // mensagem e, no mesmo movimento, desligava o mecanismo que devolveria o
    // ticket se a resposta não viesse. Medido em 30/08: em 10 conversas dos
    // últimos 7 dias a última mensagem do histórico era esse aviso. Fim de linha.
    const respondeuDepois = msgs.some((m: any) =>
      m.direction === "outgoing" &&
      m.ai_intent !== "human_transfer_warning" &&
      new Date(m.created_at) > new Date(ultimaDoPaciente.created_at)
    );
    if (respondeuDepois) { pulou("ja_respondida"); continue; }

    out.avaliados++;

    // A mensagem pede resposta? "obrigada" e mídia sem texto não pedem.
    const temMidia = !!(ultimaDoPaciente.raw_payload?.mediaUrl || ultimaDoPaciente.raw_payload?.mediaType);
    if (!exigeRespostaDaAtendente(ultimaDoPaciente.message_text, temMidia)) { pulou("nao_exige_resposta"); continue; }

    // PRÉ-FILTRO com o prazo MAIS CURTO dos dois. O prazo de verdade depende de
    // QUEM é a dona (Vânia e Lidiane têm 1h, o resto 10min) e a dona só se sabe
    // depois do showticket. Cortar aqui pelo menor prazo evita bater na API de
    // 2 em 2 minutos para conversa que ainda nem venceu o prazo mais curto.
    const esperandoMin = (Date.now() - new Date(ultimaDoPaciente.created_at).getTime()) / 60000;
    if (esperandoMin < Math.min(prazoPadrao, prazoEstendido)) { pulou("dentro_do_prazo"); continue; }

    if (out.devolvidos >= TETO_POR_RODADA) { pulou("teto_da_rodada"); continue; }

    // Quantas vezes ESTA conversa já rodou a volta nas últimas 24h? A contagem sai
    // do próprio transfer_audit — sem coluna nova, sem migration. Custa uma query
    // por conversa, e só chega aqui quem já passou por todos os filtros: no dia
    // 31/08 isso seria no máximo 5 por rodada, o teto acima.
    const { count: _voltas } = await supabase
      .from("transfer_audit")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", c.id)
      .eq("trigger", "inatividade")
      .gte("created_at", desdeFreio);
    if ((_voltas || 0) >= TETO_DEVOLUCOES) {
      // Avisa UMA vez e cala. Sem esta checagem o cron gravaria a mesma linha de
      // 2 em 2 minutos e a aba Transferências viraria um muro de repetição — o
      // mesmo erro do spam de 28/07, só que na tela em vez de no WhatsApp.
      const { count: _jaAvisado } = await supabase
        .from("transfer_audit")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", c.id)
        .eq("trigger", "inatividade_travada")
        .gte("created_at", desdeFreio);
      if (!_jaAvisado) {
        // Quem estava com o caso na ULTIMA volta. O espelho quase sempre esta
        // vazio aqui (a propria devolucao limpa o assigned_agent_name), e uma
        // linha de alerta sem nome nao ajuda quem vai olhar a aba. O nome bom
        // esta na ultima devolucao desta conversa.
        const { data: _ultimaVolta } = await supabase
          .from("transfer_audit")
          .select("from_attendant")
          .eq("conversation_id", c.id)
          .eq("trigger", "inatividade")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const _quemSegurava = String((_ultimaVolta as { from_attendant?: string } | null)?.from_attendant || "").trim();
        await supabase.from("transfer_audit").insert({
          clinic_token_id: clinicTokenId,
          conversation_id: c.id,
          phone: c.phone,
          from_attendant: _quemSegurava || nomeEspelho || null,
          to_attendant: null,
          initiated_by: "sistema",
          trigger: "inatividade_travada",
          reason: "limite_de_devolucoes",
          detail: `${_voltas} devoluções em 24h sem ninguém responder${_quemSegurava ? ` (última: ${_quemSegurava})` : ""} — parei de devolver, precisa de gente`,
        } as any).then(() => {}, () => {});
        console.log(`[devolver-fila] 🛑 FREIO: conversa ${c.id} já rodou ${_voltas} voltas em 24h — parei de devolver`);
        out.detalhes.push(`conversa ${String(c.id).slice(0, 8)}: ${_voltas} voltas — TRAVADA, precisa de gente`);
      }
      pulou("freio_de_devolucoes");
      continue;
    }

    // Confere no Z-PRO antes de mexer: o espelho local pode estar defasado, e a
    // atendente pode ter respondido por um caminho que não gerou webhook.
    let ticketId: number | null = null;
    let nome = "";
    try {
      const tel = String(c.phone || "").replace(/\D/g, "");
      const full = tel.length <= 11 ? `55${tel}` : tel;
      const r = await fetch(`${creds.baseUrl}/v2/api/external/${creds.apiId}/showticket`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          number: full,
          ...(creds.channelId ? { channelId: Number(creds.channelId), whatsappId: Number(creds.channelId) } : {}),
        }),
      });
      // 404 aqui é ERR_TICKET_NOT_FOUND: o showticket só devolve ticket ABERTO.
      // Ticket que já foi fechado ou já está pendente cai aqui — e não é caso de
      // devolução, é caso que saiu do atendimento sozinho.
      if (!r.ok) { pulou(`showticket_${r.status}`); continue; } // fail-closed
      const d = await r.json();
      // O ticket vem em `data`, NÃO na raiz. Ler d.status/d.id (como estava até
      // 30/08) dava undefined e matava a fase inteira — ver o bloco no topo.
      const tk = d?.data ?? d?.ticket ?? d;
      if (String(tk?.status || "") !== "open") { pulou("nao_esta_open"); continue; } // já saiu do atendimento
      // A DONA VEM DAQUI, não do espelho: é este nome que decide o prazo e é este
      // que vai para a auditoria. Ticket aberto SEM dona já está disponível para
      // quem quiser pegar — não há de quem tirar.
      nome = String(tk?.user?.name || "").trim();
      if (!nome) { pulou("open_sem_dona"); continue; }
      ticketId = Number(tk?.id ?? tk?.ticketId ?? 0) || null;
    } catch { pulou("showticket_erro"); continue; }
    if (!ticketId) { pulou("sem_ticket_id"); continue; }

    // Agora sim o prazo da dona de verdade.
    const prazoMin = prazoDeRespostaEmMinutos(nome, prazoPadrao, prazoEstendido);
    if (esperandoMin < prazoMin) { pulou("dentro_do_prazo_da_dona"); continue; }

    // Devolve para a fila: status pending, sem dono.
    try {
      const r = await fetch(`${creds.baseUrl}/v2/api/external/${creds.apiId}/updateticketinfo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketId,
          status: "pending",
          userId: null,
          ...(creds.channelId ? { channelId: Number(creds.channelId), whatsappId: Number(creds.channelId) } : {}),
        }),
      });
      if (!r.ok) {
        out.detalhes.push(`ticket ${ticketId}: updateticketinfo ${r.status}`);
        pulou(`updateticketinfo_${r.status}`);
        continue;
      }
      out.devolvidos++;
      out.detalhes.push(`ticket ${ticketId} (${nome}, ${Math.round(esperandoMin)}min) → fila`);

      await supabase.from("chat_conversations")
        .update({ assigned_agent_name: null, ticket_status: "pending" })
        .eq("id", c.id);

      // Trilha de auditoria: sem isto ninguém entende por que o ticket voltou.
      await supabase.from("transfer_audit").insert({
        clinic_token_id: clinicTokenId,
        conversation_id: c.id,
        phone: c.phone,
        from_attendant: nome,
        to_attendant: null,              // volta para a fila, sem dono
        initiated_by: "sistema",
        trigger: "inatividade",
        reason: "devolvido_a_fila",
        detail: `${nome} sem responder ha ${Math.round(esperandoMin)}min (prazo ${prazoMin}min)`,
      } as any).then(() => {}, () => {});   // auditoria nunca derruba a ação
    } catch (e) {
      out.detalhes.push(`ticket ${ticketId}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  return out;
}

// Envio ao paciente, no MESMO contrato que a Fase 1 usa e que funciona:
// externalKey (dedup do lado do Z-PRO) + isClosed + o canal certo. Omitir
// qualquer um deles deixa o comportamento do ticket indefinido.
async function sendWhats(
  creds: { baseUrl: string; apiId: string; bearerToken: string; channelId?: string | null },
  phone: string,
  msg: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const limpo = String(phone || "").replace(/\D/g, "");
    if (!limpo) return { ok: false, detail: "telefone vazio" };
    const full = limpo.length <= 11 ? `55${limpo}` : limpo;
    const payload: Record<string, unknown> = {
      number: full, body: msg, externalKey: crypto.randomUUID(), isClosed: false,
    };
    if (creds.channelId) {
      payload.channelId = Number(creds.channelId);
      payload.whatsappId = Number(creds.channelId);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`${creds.baseUrl}/v2/api/external/${creds.apiId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.bearerToken}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    return { ok: res.ok, detail: res.ok ? "" : `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
  } catch (e) {
    return { ok: false, detail: `exceção: ${(e as Error).message.slice(0, 120)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 3 — A MENSAGEM ENGOLIDA NÃO MORRE MAIS EM SILÊNCIO (auditoria 01/09)
// ─────────────────────────────────────────────────────────────────────────────
// O guard "Humano ativo" existe por um bom motivo: enquanto uma atendente está no
// ticket, a Julia cala a boca e não responde por cima dela. O problema nunca foi
// calar — foi que ninguém NUNCA reprocessa o que ficou calado. Se a atendente não
// vir o card, aquela mensagem morre ali, para sempre.
//
// Medido em 7 dias no banco de produção:
//   1191 mensagens engolidas pelo guard, em 278 conversas
//    178 nunca receberam NENHUMA resposta
//     68 dessas eram substantivas — ~10 por dia que somem
//
// E entre elas, o que mais dói:
//   26/08 17:17  Rapha    "Desculpe, vou ter que cancelar a consulta"   sem resposta
//   28/08 07:39  Andreia  "imprevisto e não poderei fazer a infiltração" (era às 8h20
//                          do MESMO dia) — sem resposta, no-show certo
//   28/08 11:22  Juliana  "Não poderei ir obrigada"                     sem resposta
// A consulta segue de pé no Amigo, o horário não volta para a lista de espera, e
// o paciente fica achando que avisou.
//
// O QUE ESTA FASE FAZ — E O QUE ELA NÃO FAZ.
// Ela NÃO reinjeta a mensagem na IA. A auditoria estudou isso e o risco é real: o
// ticket está genuinamente aberto com dona no Z-PRO, e responder por cima seria
// desfazer a única regra que nunca falhou aqui (zero casos de IA atropelando
// humano em 7 dias). Ela apenas TORNA VISÍVEL: grava a linha na aba Transferências
// para a recepção enxergar. Quem responde continua sendo gente.
//
// A exceção é o pedido de cancelar/remarcar, e só ele: aí o paciente recebe UMA
// confirmação de recebimento, com texto neutro que não afirma cancelamento (metade
// dos casos é remarcação, e "não poderei chegar antes das 15h" também casa a
// palavra). A Julia NUNCA cancela sozinha no Amigo — quem efetiva é a equipe,
// lendo o texto original.
const JANELA_ENGOLIDAS_DIAS = 3;
const IDADE_MINIMA_MIN = 45;      // menos que isso, a atendente ainda pode estar digitando
const TETO_SINALIZAR = 10;        // por rodada; o cron roda de 2 em 2 min
const TETO_AVISAR = 3;            // mensagens ao paciente por rodada — teto apertado de propósito
const SILENCIO_INICIO = 20;       // 20h–7h (SP): sem mensagem ao paciente. A sinalização
const SILENCIO_FIM = 7;           // interna roda sempre — a equipe vê de manhã.

// Pedido de desmarcar/remarcar. Deliberadamente largo: falso positivo aqui custa uma
// linha a mais na aba e uma mensagem neutra; falso negativo custa um no-show.
const PEDIDO_DE_DESMARCAR_RE =
  /\b(cancelar|cancelamento|desmarcar|remarcar|reagendar|n[ãa]o\s+(vou\s+)?poder|n[ãa]o\s+consigo\s+ir|n[ãa]o\s+poderei|imprevisto)\b/i;

// Marcas idempotentes gravadas no proprio action_error. Sem coluna nova, e a
// consulta que busca engolidas ja filtra por elas — rodar duas vezes nao duplica.
const MARCA_SINALIZADA = "| sinalizada";
const MARCA_AVISADA = "| paciente avisado";

async function varrerEngolidas(
  supabase: any,
  clinicTokenId: string,
  creds: { baseUrl: string; apiId: string; bearerToken: string; channelId?: string | null },
): Promise<{ achadas: number; sinalizadas: number; avisadas: number; pulos: Record<string, number> }> {
  const out = { achadas: 0, sinalizadas: 0, avisadas: 0, pulos: {} as Record<string, number> };
  const pulou = (m: string) => { out.pulos[m] = (out.pulos[m] || 0) + 1; };

  const desde = new Date(Date.now() - JANELA_ENGOLIDAS_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const ate = new Date(Date.now() - IDADE_MINIMA_MIN * 60 * 1000).toISOString();

  const { data: engolidas } = await supabase
    .from("webhook_messages")
    .select("id, conversation_id, sender_phone, sender_name, message_text, created_at, action_error, raw_payload")
    .eq("clinic_token_id", clinicTokenId)
    .eq("direction", "incoming")
    .ilike("action_error", "Humano ativo%")
    .gte("created_at", desde)
    .lte("created_at", ate)
    .order("created_at", { ascending: true })
    .limit(120);

  const horaSP = Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })
      .format(new Date()),
  );
  const emSilencio = horaSP >= SILENCIO_INICIO || horaSP < SILENCIO_FIM;

  for (const m of (engolidas || []) as any[]) {
    const jaSinalizada = String(m.action_error || "").includes(MARCA_SINALIZADA);
    const jaAvisada = String(m.action_error || "").includes(MARCA_AVISADA);
    if (jaSinalizada && jaAvisada) continue;

    // Alguém falou com o paciente DEPOIS? Então não morreu — a atendente viu o card.
    const { count: _respostas } = await supabase
      .from("webhook_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", m.conversation_id)
      .eq("direction", "outgoing")
      .gt("created_at", m.created_at);
    if ((_respostas || 0) > 0) { pulou("respondida_depois"); continue; }

    // "ok", "obrigada", documento sem texto: não é pergunta, não vira alerta. É o
    // mesmo helper que a Fase 2 usa — uma regra só para as duas.
    const temMidia = !!(m.raw_payload?.mediaUrl || m.raw_payload?.mediaType);
    if (!exigeRespostaDaAtendente(m.message_text, temMidia)) { pulou("nao_exige_resposta"); continue; }

    out.achadas++;
    const ehDesmarcar = PEDIDO_DE_DESMARCAR_RE.test(String(m.message_text || ""));
    const esperaMin = Math.round((Date.now() - new Date(m.created_at).getTime()) / 60000);

    // ── 1. Sinalizar (sempre; roda inclusive de madrugada) ────────────────────
    if (!jaSinalizada) {
      if (out.sinalizadas >= TETO_SINALIZAR) { pulou("teto_sinalizar"); continue; }
      await supabase.from("transfer_audit").insert({
        clinic_token_id: clinicTokenId,
        conversation_id: m.conversation_id,
        phone: m.sender_phone,
        patient_name: m.sender_name || null,
        from_attendant: null,
        to_attendant: null,
        initiated_by: "sistema",
        trigger: ehDesmarcar ? "cancelamento_engolido" : "mensagem_engolida",
        reason: "guard_humano_ativo",
        detail:
          (ehDesmarcar ? "PEDIDO DE DESMARCAR/REMARCAR " : "Mensagem ") +
          `sem resposta há ${esperaMin}min: "${String(m.message_text || "").replace(/\s+/g, " ").slice(0, 90)}"`,
      } as any).then(() => {}, () => {});
      await supabase.from("webhook_messages")
        .update({ action_error: `${String(m.action_error || "")} ${MARCA_SINALIZADA}`.slice(0, 480) })
        .eq("id", m.id);
      out.sinalizadas++;
      console.log(`[engolidas] ${ehDesmarcar ? "🔴 DESMARCAR" : "⚠️"} ${String(m.sender_phone).slice(-4)} há ${esperaMin}min — sinalizado na aba`);
    }

    // ── 2. Avisar o paciente — SÓ pedido de desmarcar, e só fora do silêncio ──
    // O resto não recebe nada: seria a Julia falando por cima de uma atendente que
    // está no ticket, e mensagem automática a mais foi o incidente de 28/07.
    if (ehDesmarcar && !jaAvisada) {
      if (emSilencio) { pulou("silencio_noturno"); continue; }
      if (out.avisadas >= TETO_AVISAR) { pulou("teto_avisar"); continue; }
      const primeiro = String(m.sender_name || "").trim().split(/\s+/)[0];
      // Texto NEUTRO de propósito: metade dos casos é remarcação, não cancelamento,
      // e "não poderei chegar antes das 15h" também casa a palavra. Confirmar
      // recebimento sem afirmar o que vai acontecer é o único texto sempre verdadeiro.
      const msg =
        `${primeiro ? `${primeiro}, ` : ""}recebi a sua mensagem sobre a consulta e já passei para a nossa equipe. 🙏 ` +
        `Alguém te responde para confirmar — se for urgente, é só chamar por aqui.`;
      const env = await sendWhats(creds, String(m.sender_phone || ""), msg);
      if (env.ok) {
        await supabase.from("webhook_messages")
          .update({ action_error: `${String(m.action_error || "")} ${MARCA_SINALIZADA} ${MARCA_AVISADA}`.slice(0, 480) })
          .eq("id", m.id);
        out.avisadas++;
        console.log(`[engolidas] ✉️ confirmação de recebimento enviada para ...${String(m.sender_phone).slice(-4)}`);
      } else {
        console.log(`[engolidas] envio falhou (${env.detail}) — fica para a próxima rodada`);
        pulou("envio_falhou");
      }
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // GUARD DE CRON — sem ele esta função executava com um POST vazio de qualquer
  // origem. Em 25/08 um teste assim disparou 7 avisos de WhatsApp para pacientes
  // reais, sobre transferências de 4 a 8 dias antes. O header x-cron-secret já
  // estava declarado no CORS, o que dava aparência de proteção; ninguém o lia.
  //
  // Mesmo formato das outras seis funções de cron: aceita o segredo compartilhado
  // OU uma chamada que já passou pelo gateway com apikey/Authorization (o Kong
  // valida a chave antes de chegar aqui).
  const cronSecret = req.headers.get("x-cron-secret");
  const expectedSecret = Deno.env.get("CRON_SECRET");
  const hasApiKey = !!(req.headers.get("apikey") || req.headers.get("authorization"));
  const cronSecretOk = !!cronSecret && !!expectedSecret && cronSecret === expectedSecret;
  if (!cronSecretOk && !hasApiKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const summary = { checked: 0, reassigned: 0, expired: 0, errors: 0 };

  try {
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await supabase
      .from("pending_human_transfers")
      .select("id, clinic_token_id, conversation_id, phone, intent, assigned_attendant_name, assigned_attendant_id, attempts_count, previous_attendants, expected_response_by")
      .eq("status", "pending")
      .lte("expected_response_by", nowIso)
      .limit(50);

    if (error) throw error;
    summary.checked = (rows || []).length;

    for (const row of rows || []) {
      try {
        const [{ data: token }, { data: config }, { data: clinicInfo }] = await Promise.all([
          supabase
            .from("clinic_tokens")
            .select("avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, user_id")
            .eq("id", row.clinic_token_id)
            .single(),
          supabase
            .from("clinic_routing_config")
            .select("human_response_timeout_minutes, max_reassignment_attempts, timeout_enabled")
            .eq("clinic_token_id", row.clinic_token_id)
            .maybeSingle(),
          supabase
            .from("clinic_info")
            .select("custom_notes")
            .eq("clinic_token_id", row.clinic_token_id)
            .maybeSingle(),
        ]);

        // POLÍTICA 21/07 ("versão honesta"): NUNCA mais troca de mão silenciosa.
        // No timeout (15min), a Julia manda UM aviso ao paciente — "a {atendente}
        // está finalizando outro atendimento e já te responde" — e encerra o
        // acompanhamento (status 'warned'). A reatribuição automática foi REMOVIDA.
        // (config.timeout_enabled deixou de ser gate: o aviso é sempre ativo.)
        void config; void clinicInfo; void parseVacationNames; void fetchOnlineAttendants; void transferTicket; void stripAccents;

        if (!token?.avanceai_base_url || !token?.avanceai_api_id || !token?.avanceai_bearer_token) {
          await supabase
            .from("pending_human_transfers")
            .update({ status: "expired", resolved_at: nowIso, resolved_reason: "clinic_missing_avanceai_config" })
            .eq("id", row.id);
          summary.expired++;
          continue;
        }

        // Um aviso só, nunca dois: se já avisamos antes, expira em silêncio.
        if ((row.attempts_count || 1) >= 2) {
          await supabase
            .from("pending_human_transfers")
            .update({ status: "expired", resolved_at: nowIso, resolved_reason: "aviso_ja_enviado" })
            .eq("id", row.id);
          summary.expired++;
          continue;
        }

        // Canal certo (lição 19/07 ERR_API_REQUIRES_SESSION): avanceai_active_channel
        // é ARRAY JSON de canais com credenciais PRÓPRIAS; usa o único habilitado.
        let sendBase = token.avanceai_base_url, sendApi = token.avanceai_api_id, sendBearer = token.avanceai_bearer_token;
        let sendChannel: string | null = null;
        try {
          const parsed = typeof token.avanceai_active_channel === "string"
            ? JSON.parse(token.avanceai_active_channel) : token.avanceai_active_channel;
          const enabled = Array.isArray(parsed)
            ? parsed.filter((c: any) => c && c.apiId && c.baseUrl && c.enabled !== false) : [];
          if (enabled.length === 1) {
            sendBase = String(enabled[0].baseUrl);
            sendApi = String(enabled[0].apiId);
            sendBearer = String(enabled[0].bearerToken || token.avanceai_bearer_token || "");
            sendChannel = enabled[0].id != null ? String(enabled[0].id) : null;
          }
        } catch { /* fica nas credenciais planas */ }

        // SEM DONA (semana 10-14/08): 10 das 23 conversas de urgencia nunca
        // entraram nesta fila porque ninguem estava online para receber. Agora o
        // webhook registra a urgencia mesmo assim, com o marcador "(sem dono)" —
        // e aqui o aviso NAO pode dizer "a Fulana esta finalizando outro
        // atendimento", porque nao existe Fulana nenhuma. Texto neutro e' o unico
        // honesto: diz que o caso continua na fila, sem prometer prazo.
        const _semDona = !row.assigned_attendant_name || String(row.assigned_attendant_name).trim().startsWith("(");
        const attName = String(row.assigned_attendant_name || "nossa atendente").split(/\s+/)[0];
        const warnMsg = _semDona
          ? `Oi! 👋 Só passando pra avisar que seu caso continua na fila da nossa equipe e ainda não foi respondido. ` +
            `Se for uma emergência, por favor não espere por aqui: procure um pronto-socorro. 🙏`
          : `Oi! 👋 Só passando pra avisar: a ${attName} está finalizando outro atendimento e já já te responde. ` +
            `Obrigado pela paciência! 🙏`;

        // ── COMPARE-AND-SWAP ANTES DO ENVIO (spam 28/07) ────────────────────────
        // Até hoje a linha só saía de 'pending' DEPOIS do envio, e o erro do UPDATE
        // não era checado. Como o CHECK da tabela não aceitava 'warned', a gravação
        // falhava calada, a linha continuava 'pending' com o prazo vencido e o cron
        // (*/2min) reenviava o aviso PARA SEMPRE: o Mássimo recebeu ~50 vezes em 1h43,
        // e um segundo paciente da mesma atendente entrou no mesmo ciclo.
        // Agora a linha sai de 'pending' PRIMEIRO e só então enviamos. Se o claim
        // pegar 0 linhas (outra execução já tratou) ou falhar, NÃO enviamos — o pior
        // caso vira "o paciente não recebe o aviso", que é infinitamente melhor que
        // recebê-lo 50 vezes. Silêncio > spam.
        const { data: _claim, error: _claimErr } = await supabase
          .from("pending_human_transfers")
          .update({
            status: "warned",
            attempts_count: (row.attempts_count || 1) + 1,
            resolved_at: nowIso,
            resolved_reason: "aviso_timeout_enviado",
          })
          .eq("id", row.id)
          .eq("status", "pending")
          .select("id");
        if (_claimErr) {
          // Rede de segurança: se nem 'warned' grava (constraint/coluna), força a saída
          // de 'pending' com um status garantidamente válido — nunca deixa em loop.
          console.error(`[human-transfer-timeout] claim falhou (${_claimErr.message}) — expirando p/ não repetir`);
          await supabase
            .from("pending_human_transfers")
            .update({ status: "expired", resolved_at: nowIso, resolved_reason: `claim_falhou: ${_claimErr.message}`.slice(0, 120) })
            .eq("id", row.id);
          summary.errors++;
          continue;
        }
        if (!_claim || _claim.length === 0) { continue; } // outra execução já avisou

        // CARIMBA A HORA DO AVISO EM COLUNA PRÓPRIA (16/08).
        // A partir de agora a linha 'warned' continua viva: quando a atendente
        // responder, o whatsapp-webhook a vira 'responded' e SOBRESCREVE resolved_at
        // com a hora da resposta. Sem warned_at, a hora do aviso sumiria e o painel
        // perderia exatamente a métrica que estamos consertando — o atraso entre
        // aviso e resposta, cuja mediana medida na semana foi 58,5 min.
        //
        // Escrita SEPARADA e best-effort de propósito. O UPDATE do claim acima é o que
        // segura o spam do Mássimo (28/07) e não pode ganhar coluna nova: se a
        // migration ainda não tiver rodado, o claim falharia, cairia na rede de
        // segurança do _claimErr e NENHUM paciente receberia o aviso — o desastre do
        // 28/07 ao contrário. Aqui, se a coluna não existir, só perdemos o carimbo:
        // o aviso sai igual e a resposta humana continua sendo registrada.
        const { error: _warnedAtErr } = await supabase
          .from("pending_human_transfers")
          .update({ warned_at: nowIso })
          .eq("id", row.id);
        if (_warnedAtErr) {
          console.log(`[human-transfer-timeout] warned_at não gravado (non-blocking, migration pendente?): ${_warnedAtErr.message}`);
        }

        const payload: Record<string, unknown> = {
          number: String(row.phone || "").replace(/\D/g, "").replace(/^(?!55)/, "55"),
          body: warnMsg,
          externalKey: crypto.randomUUID(),
          isClosed: false,
        };
        if (sendChannel) { payload.channelId = Number(sendChannel); payload.whatsappId = Number(sendChannel); }
        const res = await fetch(`${sendBase}/v2/api/external/${sendApi}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sendBearer}` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          // A linha JÁ saiu de 'pending' (claim acima). Não reenfileira: o aviso é
          // uma cortesia, não vale arriscar o loop que causou o spam de 28/07.
          console.log(`[human-transfer-timeout] aviso falhou HTTP ${res.status} — NÃO reenvia (linha já marcada)`);
          summary.errors++;
          continue;
        }

        // OBSERVABILIDADE (28/07): esta função nunca registrava seus envios em
        // webhook_messages — por isso o spam ficou INVISÍVEL a qualquer consulta ao
        // banco e só apareceu quando a atendente reclamou olhando o painel do Z-PRO.
        // Toda mensagem que sai para o paciente tem que estar no histórico dele.
        try {
          await supabase.from("webhook_messages").insert({
            clinic_token_id: row.clinic_token_id,
            user_id: token.user_id || null,
            sender_phone: String(row.phone || "").replace(/\D/g, ""),
            message_text: warnMsg,
            direction: "outgoing",
            ai_intent: "human_transfer_warning",
            action_status: "success",
            conversation_id: row.conversation_id,
          });
        } catch (e) {
          console.log(`[human-transfer-timeout] log do aviso falhou (non-blocking): ${(e as Error).message}`);
        }
        // Auditoria: aviso registrado (sem troca de mão — from = to = mesma atendente)
        await supabase.from("transfer_audit").insert({
          clinic_token_id: row.clinic_token_id,
          conversation_id: row.conversation_id,
          phone: String(row.phone || "").replace(/\D/g, "") || null,
          from_attendant: row.assigned_attendant_name || null,
          to_attendant: row.assigned_attendant_name || null,
          initiated_by: "julia",
          trigger: "aviso_timeout",
          reason: "sem_resposta_humana_no_prazo",
          detail: warnMsg.slice(0, 120),
        });
        summary.reassigned++; // métrica reaproveitada: agora conta AVISOS enviados
      } catch (e) {
        console.error(`[human-transfer-timeout] row ${row.id} error: ${(e as Error).message}`);
        summary.errors++;
      }
    }

      // ── FASE 2: devolução à fila por inatividade ────────────────────────────
      // Roda independente da Fase 1: aquela percorre pending_human_transfers
      // (transferências que a Julia iniciou) e pode não ter linha nenhuma; esta
      // olha o atendimento EM CURSO, que existe mesmo sem transferência pendente.
      if ((Deno.env.get("DEVOLVER_FILA_ENABLED") || "").toLowerCase() === "true") {
        const prazoPadrao = Number(Deno.env.get("DEVOLVER_FILA_MINUTOS") || "10") || 10;
        const prazoEstendido = Number(Deno.env.get("DEVOLVER_FILA_MINUTOS_ESTENDIDO") || "60") || 60;
        const { data: clinicas } = await supabase
          .from("clinic_tokens")
          .select("id, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel");
        for (const cl of (clinicas || [])) {
          if (!cl.avanceai_base_url || !cl.avanceai_api_id || !cl.avanceai_bearer_token) continue;

          // CANAL CERTO — mesma lição 19/07 (ERR_API_REQUIRES_SESSION) que a Fase 1
          // já aplicava e esta não. As colunas planas da clinic_tokens hoje apontam
          // para o canal 143, que está DESLIGADO: chamar showticket com elas procura
          // o ticket numa sessão que não tem ticket nenhum, e devolve 404 sempre.
          // O canal vivo mora dentro de avanceai_active_channel, com credencial
          // própria — é dele que a Julia fala com o paciente.
          let cBase = cl.avanceai_base_url, cApi = cl.avanceai_api_id, cBearer = cl.avanceai_bearer_token;
          let cChannel: string | null = null;
          try {
            const parsed = typeof cl.avanceai_active_channel === "string"
              ? JSON.parse(cl.avanceai_active_channel) : cl.avanceai_active_channel;
            const habilitados = Array.isArray(parsed)
              ? parsed.filter((ch: any) => ch && ch.apiId && ch.baseUrl && ch.enabled !== false) : [];
            if (habilitados.length === 1) {
              cBase = String(habilitados[0].baseUrl);
              cApi = String(habilitados[0].apiId);
              cBearer = String(habilitados[0].bearerToken || cl.avanceai_bearer_token || "");
              cChannel = habilitados[0].id != null ? String(habilitados[0].id) : null;
            } else if (habilitados.length > 1) {
              // Com dois canais ligados não dá para adivinhar por qual o paciente
              // falou. Pular é melhor que devolver o ticket no canal errado.
              console.log(`[devolver-fila] clinica ${cl.id}: ${habilitados.length} canais ligados — pulando (ambíguo)`);
              continue;
            }
          } catch { /* fica nas credenciais planas */ }

          try {
            const r = await devolverInativosAFila(
              supabase,
              cl.id,
              { baseUrl: cBase, apiId: cApi, bearerToken: cBearer, channelId: cChannel },
              prazoPadrao,
              prazoEstendido,
            );
            (summary as any).fila_avaliados = ((summary as any).fila_avaliados || 0) + r.avaliados;
            (summary as any).fila_devolvidos = ((summary as any).fila_devolvidos || 0) + r.devolvidos;
            // SEMPRE loga (30/08). Antes só falava quando devolvia algo, e por isso
            // cinco dias devolvendo zero pareceram cinco dias sem caso nenhum.
            const pulos = Object.entries(r.pulos).map(([k, v]) => `${k}=${v}`).join(",") || "nenhum";
            console.log(
              `[devolver-fila] clinica=${cl.id} canal=${cChannel || "plano"} avaliados=${r.avaliados} devolvidos=${r.devolvidos} pulos: ${pulos}`,
            );
            if (r.detalhes.length) console.log(`[devolver-fila] ${r.detalhes.join(" | ")}`);
          } catch (e) {
            console.error(`[devolver-fila] clinica ${cl.id}: ${(e as Error).message}`);
          }

          // ── FASE 3: mensagem engolida pelo guard não morre em silêncio ────────
          // Mesmo canal já resolvido acima. Roda depois da devolução de propósito:
          // se a Fase 2 acabou de devolver o ticket, a conversa volta a ser da fila
          // e a mensagem engolida deixa de precisar de alerta na próxima rodada.
          try {
            const e3 = await varrerEngolidas(
              supabase, cl.id,
              { baseUrl: cBase, apiId: cApi, bearerToken: cBearer, channelId: cChannel },
            );
            (summary as any).engolidas_achadas = ((summary as any).engolidas_achadas || 0) + e3.achadas;
            (summary as any).engolidas_sinalizadas = ((summary as any).engolidas_sinalizadas || 0) + e3.sinalizadas;
            (summary as any).engolidas_avisadas = ((summary as any).engolidas_avisadas || 0) + e3.avisadas;
            const p3 = Object.entries(e3.pulos).map(([k, v]) => `${k}=${v}`).join(",") || "nenhum";
            console.log(
              `[engolidas] clinica=${cl.id} achadas=${e3.achadas} sinalizadas=${e3.sinalizadas} avisadas=${e3.avisadas} pulos: ${p3}`,
            );
          } catch (e) {
            console.error(`[engolidas] clinica ${cl.id}: ${(e as Error).message}`);
          }
        }
      }

    return new Response(JSON.stringify({ ok: true, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[human-transfer-timeout] fatal: ${(e as Error).message}`);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message, summary }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
