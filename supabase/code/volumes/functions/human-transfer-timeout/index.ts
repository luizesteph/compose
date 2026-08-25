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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
