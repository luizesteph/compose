// confirmacao-insistencia — segunda mensagem de confirmação para quem não respondeu
// (20/10/2026, pedido do dono). Regras e textos em _shared/confirmacao.ts.
//
// Roda a cada minuto (pg_cron, seg–sex 19h–20h59 UTC = 16h–17h59 em SP) e só age
// dentro da janela 16h–18h de São Paulo:
//   1. PLANEJA uma vez por dia: lê no Amigo (GET /attendances) as consultas do
//      próximo dia útil que ainda esperam confirmação e grava uma linha por
//      consulta em `confirmacao_insistencia`, com o horário de envio espalhado
//      pela janela (nunca menos de 90 s entre duas, com folga aleatória).
//   2. ENVIA no máximo UMA mensagem por rodada: relê a lista no Amigo (quem
//      confirmou nesse meio-tempo sai), trava a linha (agendada → enviando) ANTES
//      de enviar — lição de 25/09: o cron de 1 min reenviou 52 cópias quando o
//      estado só mudava depois do envio —, grava a saída no webhook_messages
//      (o eco do Z-PRO cai na deduplicação de 30 s) e envia.
// O "SIM" é tratado no whatsapp-webhook (bloco RESPOSTA À CONFIRMAÇÃO).
//
// Interruptor: clinic_tokens.confirmacao_insistencia
//   'off'   → nada
//   'teste' → planeja só na memória e manda UM resumo ao dono (uma vez por dia); paciente nenhum recebe nada
//   'on'    → envia aos pacientes
// clinic_tokens.confirmacao_insistencia_so_medico: só as consultas desse médico
// (primeiro teste, 20/10: "LUCAS MIOTTO"); NULL = todos.
// Simulação a qualquer hora (com o segredo do cron): POST {"simular": true} devolve
// o plano sem gravar nem enviar.
//
// DESFAZER (sem deploy, efeito no minuto seguinte):
//   update clinic_tokens set confirmacao_insistencia = 'off';

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { chamadaDeCronAutorizada } from "../_shared/cron.ts";
import { canalVivo, enviarTexto } from "../_shared/zpro.ts";
import {
  HORAS_EM_CONVERSA,
  HORAS_MARCOU_AGORA,
  marcouNaConversa,
  INTERVALO_MINIMO_S,
  ULTIMO_ENVIO_MIN,
  chaveDoTelefone,
  ehDomingo,
  precisaDeRepescagem,
  esperaConfirmacao,
  itemDaConsulta,
  janelaAberta,
  medicoDoFiltro,
  planejarHorarios,
  proximoDiaUtil,
  textoDaInsistencia,
  type ConsultaDoAmigo,
  type ItemDaInsistencia,
} from "../_shared/confirmacao.ts";
import { telefoneSemJulia } from "../whatsapp-webhook/helpers.ts";
import { montarRelatorio, textoParaAMardila, type LinhaDoRelatorio } from "../_shared/relatorio-confirmacao.ts";
import { enviarDMNoSlack } from "../_shared/slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const AMIGO = "https://amigobot-api.amigoapp.com.br";
const TELEFONE_DO_DONO = "11983354622";

function agoraSP(): { hojeISO: string; minutos: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return { hojeISO: `${g("year")}-${g("month")}-${g("day")}`, minutos: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}

/** epoch de HH:MM de hoje em SP (SP = UTC−3, sem horário de verão desde 2019) */
function msDeHojeSP(hojeISO: string, minutos: number): number {
  return Date.parse(`${hojeISO}T00:00:00-03:00`) + minutos * 60000;
}

function companyDoToken(tok: string): string {
  try {
    const b = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(b + "===".slice((b.length + 3) % 4))).company_id ?? "");
  } catch {
    return "";
  }
}

async function consultasAConfirmar(tok: string, dataISO: string): Promise<ConsultaDoAmigo[] | null> {
  const company = companyDoToken(tok);
  const url = `${AMIGO}/attendances?company_id=${company}&start_date=${dataISO}&end_date=${dataISO}`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      console.error(`[Insistencia] GET attendances ${r.status}`);
      return null;
    }
    const j = await r.json();
    const lista = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : null;
    return lista ? (lista as ConsultaDoAmigo[]).filter((c) => String(c.start_date ?? "").slice(0, 10) === dataISO) : null;
  } catch (e) {
    console.error(`[Insistencia] GET attendances falhou: ${(e as Error).message}`);
    return null;
  }
}

/** chaves dos telefones que escreveram à clínica nas últimas N horas */
async function telefonesEmConversa(supabase: any, clinicId: string, horas: number): Promise<Set<string>> {
  const desde = new Date(Date.now() - horas * 3600000).toISOString();
  const { data } = await supabase
    .from("webhook_messages")
    .select("sender_phone")
    .eq("clinic_token_id", clinicId)
    .eq("direction", "incoming")
    .gte("created_at", desde)
    .limit(5000);
  const s = new Set<string>();
  for (const r of data || []) {
    const k = chaveDoTelefone(r.sender_phone);
    if (k) s.add(k);
  }
  return s;
}

/** chaves dos telefones cuja conversa marcou consulta nas últimas N horas (equipe, site ou Julia) */
async function telefonesQueMarcaramAgora(supabase: any, clinicId: string, horas: number): Promise<Set<string>> {
  const desde = new Date(Date.now() - horas * 3600000).toISOString();
  // três buscas pequenas, filtradas no banco (o PostgREST corta resposta grande em silêncio)
  const base = () => supabase
    .from("webhook_messages")
    .select("sender_phone, direction, ai_intent, message_text, ai_entities")
    .eq("clinic_token_id", clinicId)
    .gte("created_at", desde)
    .limit(1000);
  const [equipe, site, julia] = await Promise.all([
    base().eq("ai_intent", "manual_reply").or("message_text.ilike.%agendad%,message_text.ilike.%marcad%"),
    base().eq("direction", "incoming").ilike("message_text", "Agendamento via widget:%"),
    base().not("ai_entities->>booked_event_id", "is", null),
  ]);
  const s = new Set<string>();
  for (const r of [...(equipe.data || []), ...(site.data || []), ...(julia.data || [])]) {
    const booked = !!(r.ai_entities && (r.ai_entities as Record<string, unknown>).booked_event_id);
    if (!marcouNaConversa({ ...r, booked })) continue;
    const k = chaveDoTelefone(r.sender_phone);
    if (k) s.add(k);
  }
  return s;
}

type Plano = { linhas: Array<ItemDaInsistencia & { status: string; motivo: string | null; agendada_para: string | null }> };

function montarPlano(
  consultas: ConsultaDoAmigo[],
  emConversa: Set<string>,
  marcouAgora: Set<string>,
  inicioMs: number,
  fimMs: number,
  soMedico: string | null,
): Plano {
  const linhas: Plano["linhas"] = [];
  const grupos = new Map<string, ItemDaInsistencia[]>();
  for (const c of consultas) {
    if (!esperaConfirmacao(c)) continue;
    if (!medicoDoFiltro(c.user?.name, soMedico)) continue;
    const it = itemDaConsulta(c);
    if (!it.attendance_id || !it.patient_id) continue;
    let motivo: string | null = null;
    if (!it.telefone || !it.telefone_chave) motivo = "sem_celular";
    else if (telefoneSemJulia(it.telefone)) motivo = "numero_sem_julia";
    else if (emConversa.has(it.telefone_chave)) motivo = "em_conversa";
    if (motivo) {
      linhas.push({ ...it, status: "pulada", motivo, agendada_para: null });
      continue;
    }
    // marcou nas últimas 24 h: envia igual (pedido do dono, 21/10), a marca muda só a abertura do texto
    if (marcouAgora.has(it.telefone_chave)) (it as ItemDaInsistencia & { recente?: boolean }).recente = true;
    const g = grupos.get(it.telefone_chave!) || [];
    g.push(it);
    grupos.set(it.telefone_chave!, g);
  }
  // um envio por telefone, na ordem do horário da primeira consulta
  const ordem = [...grupos.values()].sort((a, b) => a[0].hora.localeCompare(b[0].hora));
  const horarios = planejarHorarios(ordem.length, inicioMs, fimMs);
  ordem.forEach((g, i) => {
    const t = horarios[i];
    for (const comMarca of g) {
      // `recente` não é coluna da tabela: sai do objeto antes de gravar
      const { recente, ...it } = comMarca as ItemDaInsistencia & { recente?: boolean };
      linhas.push(t == null
        ? { ...it, status: "pulada", motivo: "sem_tempo", agendada_para: null }
        : { ...it, status: "agendada", motivo: recente ? "marcou_hoje" : null, agendada_para: new Date(t).toISOString() });
    }
  });
  return { linhas };
}

function resumoDoPlano(p: Plano) {
  const porStatus: Record<string, number> = {};
  for (const l of p.linhas) {
    const k = l.status === "pulada" ? `pulada:${l.motivo}` : l.status;
    porStatus[k] = (porStatus[k] || 0) + 1;
  }
  const envios = [...new Set(p.linhas.filter((l) => l.agendada_para).map((l) => l.agendada_para!))].sort();
  return { consultas: p.linhas.length, envios: envios.length, primeiro: envios[0] ?? null, ultimo: envios[envios.length - 1] ?? null, porStatus };
}

async function acharOuCriarConversa(supabase: any, clinic: any, telefone: string, nome: string): Promise<string | null> {
  const chave = chaveDoTelefone(telefone);
  if (!chave) return null;
  const { data } = await supabase
    .from("chat_conversations")
    .select("id, phone")
    .eq("clinic_token_id", clinic.id)
    .ilike("phone", `%${chave.slice(-8)}`)
    .order("last_message_at", { ascending: false })
    .limit(10);
  const achada = (data || []).find((c: any) => chaveDoTelefone(c.phone) === chave);
  if (achada) return achada.id;
  const { data: nova } = await supabase
    .from("chat_conversations")
    .insert({ user_id: clinic.user_id, clinic_token_id: clinic.id, phone: telefone, contact_name: nome || "" })
    .select("id")
    .single();
  return nova?.id ?? null;
}

async function processarClinica(supabase: any, clinic: any, simular: boolean, foraDaJanela = false) {
  const { hojeISO, minutos } = agoraSP();
  const modo = String(clinic.confirmacao_insistencia || "off");
  // `foraDaJanela` (pedido do dono, 21/10 19h40: "mesmo com o horário, mande"): só ENVIA as
  // linhas já 'agendada' do dia — nunca planeja fora da janela. Chamada manual, com o segredo do cron.
  if (!simular && !foraDaJanela && !janelaAberta(hojeISO, minutos)) return { clinica: clinic.id, fora_da_janela: true };
  const alvo = proximoDiaUtil(hojeISO);
  const tok = String(clinic.token || "");

  // ── 1. PLANEJAR ────────────────────────────────────────────────────────────
  const { count: jaPlanejado } = await supabase
    .from("confirmacao_insistencia")
    .select("id", { count: "exact", head: true })
    .eq("clinic_token_id", clinic.id)
    .eq("data_consulta", alvo);

  if (foraDaJanela && !simular && !jaPlanejado) return { clinica: clinic.id, fora_da_janela: "nada planejado hoje" };

  // ── 1b. REPESCAGEM DE DOMINGO (22/10) ───────────────────────────────────────
  // A sexta planejou as consultas de segunda. No domingo, uma vez (marca attendance_id = -2),
  // quem ainda não confirmou e não respondeu nada depois da mensagem de sexta volta para a fila.
  if (ehDomingo(hojeISO) && jaPlanejado && !simular && !foraDaJanela && modo === "on") {
    const { data: marcaDom } = await supabase.from("confirmacao_insistencia").select("id")
      .eq("clinic_token_id", clinic.id).eq("data_consulta", alvo).eq("attendance_id", -2).maybeSingle();
    if (!marcaDom) {
      const consultas = await consultasAConfirmar(tok, alvo);
      if (!consultas) return { clinica: clinic.id, erro: "amigo_indisponivel" };
      const { data: existentes } = await supabase.from("confirmacao_insistencia")
        .select("attendance_id, status, enviada_em, telefone_chave")
        .eq("clinic_token_id", clinic.id).eq("data_consulta", alvo).gt("attendance_id", 0);
      const porId = new Map((existentes || []).map((e: any) => [Number(e.attendance_id), e]));
      const envios = (existentes || []).map((e: any) => e.enviada_em).filter(Boolean).sort();
      const { data: entradas } = envios.length
        ? await supabase.from("webhook_messages").select("sender_phone, created_at")
          .eq("clinic_token_id", clinic.id).eq("direction", "incoming").gte("created_at", envios[0]).limit(1000)
        : { data: [] as any[] };
      const respondeuDepois = (e: any) => !!e?.enviada_em && (entradas || []).some((m: any) =>
        chaveDoTelefone(m.sender_phone) === e.telefone_chave && Date.parse(m.created_at) > Date.parse(e.enviada_em));
      const candidatas = consultas.filter((c) => {
        const e = porId.get(Number(c.id));
        return precisaDeRepescagem(e, respondeuDepois(e));
      });
      const emConversa = await telefonesEmConversa(supabase, clinic.id, HORAS_EM_CONVERSA);
      const marcouAgora = await telefonesQueMarcaramAgora(supabase, clinic.id, HORAS_MARCOU_AGORA);
      const inicio = Math.max(Date.now() + 60000, msDeHojeSP(hojeISO, 16 * 60));
      const plano = montarPlano(candidatas, emConversa, marcouAgora, inicio, msDeHojeSP(hojeISO, ULTIMO_ENVIO_MIN), clinic.confirmacao_insistencia_so_medico || null);
      const resumo = resumoDoPlano(plano);
      // linhas de sexta voltam para 'agendada' (enviada_em zera); as novas entram
      const agendadas = plano.linhas.filter((l) => l.status === "agendada")
        .map((l) => ({ clinic_token_id: clinic.id, ...l, enviada_em: null, confirmada_em: null }));
      if (agendadas.length) {
        const { error: upErr } = await supabase.from("confirmacao_insistencia")
          .upsert(agendadas, { onConflict: "clinic_token_id,data_consulta,attendance_id" });
        if (upErr) return { clinica: clinic.id, erro: `repescagem não gravada: ${upErr.message}` };
      }
      const puladas = plano.linhas.filter((l) => l.status !== "agendada").map((l) => ({ clinic_token_id: clinic.id, ...l }));
      if (puladas.length) {
        await supabase.from("confirmacao_insistencia")
          .upsert(puladas, { onConflict: "clinic_token_id,data_consulta,attendance_id", ignoreDuplicates: true });
      }
      await supabase.from("confirmacao_insistencia").insert({
        clinic_token_id: clinic.id, data_consulta: alvo, attendance_id: -2, patient_id: 0,
        status: "repescagem", motivo: JSON.stringify(resumo).slice(0, 500),
      });
      console.log(`[Insistencia] repescagem de domingo ${alvo}: ${JSON.stringify(resumo)}`);
      return { clinica: clinic.id, repescagem: resumo };
    }
  }
  if (simular || modo === "teste" || (!jaPlanejado && !foraDaJanela)) {
    if (modo === "teste" && !simular && jaPlanejado) return { clinica: clinic.id, teste: "resumo já enviado hoje" };
    const consultas = await consultasAConfirmar(tok, alvo);
    if (!consultas) return { clinica: clinic.id, erro: "amigo_indisponivel" };
    const emConversa = await telefonesEmConversa(supabase, clinic.id, HORAS_EM_CONVERSA);
    const marcouAgora = await telefonesQueMarcaramAgora(supabase, clinic.id, HORAS_MARCOU_AGORA);
    const inicio = Math.max(Date.now() + 60000, msDeHojeSP(hojeISO, 16 * 60));
    const plano = montarPlano(consultas, emConversa, marcouAgora, inicio, msDeHojeSP(hojeISO, ULTIMO_ENVIO_MIN), clinic.confirmacao_insistencia_so_medico || null);
    const resumo = resumoDoPlano(plano);
    console.log(`[Insistencia] plano ${alvo} modo=${modo}${simular ? " (simulação)" : ""}: ${JSON.stringify(resumo)}`);
    if (simular) return { clinica: clinic.id, alvo, simulacao: resumo };

    if (modo === "teste") {
      // marca o dia (attendance_id 0) para mandar o resumo uma vez só
      const { error: mErr } = await supabase.from("confirmacao_insistencia").insert({
        clinic_token_id: clinic.id, data_consulta: alvo, attendance_id: 0, patient_id: 0,
        status: "teste", motivo: JSON.stringify(resumo).slice(0, 500),
      });
      if (mErr) return { clinica: clinic.id, teste: `marca não gravada: ${mErr.message}` };
      const ex = plano.linhas.find((l) => l.status === "agendada");
      const exemplo = ex ? textoDaInsistencia([{ ...ex, paciente_nome: "PACIENTE EXEMPLO" }], hojeISO) : "(nenhum envio)";
      const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : "-");
      const puladas = Object.entries(resumo.porStatus).filter(([k]) => k.startsWith("pulada")).map(([k, v]) => `${k.slice(7)} ${v}`).join(", ") || "nenhuma";
      const msg = `[TESTE — confirmação] Consultas de ${alvo.slice(8, 10)}/${alvo.slice(5, 7)} ainda sem confirmação: ${resumo.consultas}.\n` +
        `Seriam ${resumo.envios} mensagens, de ${hm(resumo.primeiro)} a ${hm(resumo.ultimo)} (uma a cada ${Math.max(INTERVALO_MINIMO_S, 0) / 60}+ min, espaçadas).\n` +
        `Ficariam de fora: ${puladas}.\n\nExemplo do texto:\n${exemplo}\n\nNenhum paciente recebeu nada.`;
      const canal = canalVivo(clinic);
      const env = canal ? await enviarTexto(canal, TELEFONE_DO_DONO, msg) : { ok: false, detalhe: "sem canal vivo" };
      return { clinica: clinic.id, teste: env.ok ? "resumo enviado ao dono" : `resumo falhou: ${env.detalhe}`, resumo };
    }

    if (modo !== "on") return { clinica: clinic.id, modo };
    const linhas = plano.linhas.map((l) => ({ clinic_token_id: clinic.id, ...l }));
    if (linhas.length) {
      const { error: insErr } = await supabase
        .from("confirmacao_insistencia")
        .upsert(linhas, { onConflict: "clinic_token_id,data_consulta,attendance_id", ignoreDuplicates: true });
      if (insErr) return { clinica: clinic.id, erro: `plano não gravado: ${insErr.message}` };
    }
    return { clinica: clinic.id, planejado: resumo };
  }
  if (modo !== "on") return { clinica: clinic.id, modo };

  // ── 2. ENVIAR (uma por rodada) ─────────────────────────────────────────────
  const { data: ultimo } = await supabase
    .from("confirmacao_insistencia")
    .select("enviada_em")
    .eq("clinic_token_id", clinic.id)
    .not("enviada_em", "is", null)
    .order("enviada_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ultimo?.enviada_em && Date.now() - Date.parse(ultimo.enviada_em) < INTERVALO_MINIMO_S * 1000) {
    return { clinica: clinic.id, aguardando_intervalo: true };
  }
  const { data: proxima } = await supabase
    .from("confirmacao_insistencia")
    .select("*")
    .eq("clinic_token_id", clinic.id)
    .eq("data_consulta", alvo)
    .eq("status", "agendada")
    .lte("agendada_para", new Date().toISOString())
    .order("agendada_para", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!proxima) return { clinica: clinic.id, nada_a_enviar: true };

  const { data: grupo } = await supabase
    .from("confirmacao_insistencia")
    .select("*")
    .eq("clinic_token_id", clinic.id)
    .eq("data_consulta", alvo)
    .eq("status", "agendada")
    .eq("telefone_chave", proxima.telefone_chave);

  // quem confirmou (ou cancelou) depois do plano sai
  const consultas = await consultasAConfirmar(tok, alvo);
  if (!consultas) return { clinica: clinic.id, erro: "amigo_indisponivel" };
  const ainda = new Set(consultas.filter(esperaConfirmacao).map((c) => Number(c.id)));
  const vivos = (grupo || []).filter((g: any) => ainda.has(Number(g.attendance_id)));
  const mortos = (grupo || []).filter((g: any) => !ainda.has(Number(g.attendance_id)));
  if (mortos.length) {
    await supabase.from("confirmacao_insistencia")
      .update({ status: "ja_confirmada", motivo: "confirmada ou cancelada antes do envio" })
      .in("id", mortos.map((m: any) => m.id)).eq("status", "agendada");
  }
  if (!vivos.length) return { clinica: clinic.id, ja_confirmada: mortos.length };

  // o paciente escreveu nesse meio-tempo: a equipe está com ele
  const emConversa = await telefonesEmConversa(supabase, clinic.id, HORAS_EM_CONVERSA);
  if (emConversa.has(String(proxima.telefone_chave))) {
    await supabase.from("confirmacao_insistencia")
      .update({ status: "pulada", motivo: "em_conversa" })
      .in("id", vivos.map((v: any) => v.id)).eq("status", "agendada");
    return { clinica: clinic.id, pulada: "em_conversa" };
  }

  // trava ANTES de enviar
  const { data: travadas } = await supabase
    .from("confirmacao_insistencia")
    .update({ status: "enviando", enviada_em: new Date().toISOString() })
    .in("id", vivos.map((v: any) => v.id))
    .eq("status", "agendada")
    .select("*");
  if (!travadas || travadas.length === 0) return { clinica: clinic.id, outra_rodada_pegou: true };

  const canal = canalVivo(clinic);
  const texto = textoDaInsistencia(travadas as ItemDaInsistencia[], hojeISO, {
    marcouAgora: travadas.every((t: any) => t.motivo === "marcou_hoje"),
  });
  const telefone = String(travadas[0].telefone);
  const ids = travadas.map((t: any) => t.id);
  if (!canal) {
    await supabase.from("confirmacao_insistencia").update({ status: "falhou", motivo: "sem canal vivo" }).in("id", ids);
    return { clinica: clinic.id, erro: "sem_canal_vivo" };
  }
  const convId = await acharOuCriarConversa(supabase, clinic, telefone, travadas[0].paciente_nome);
  const { data: saida } = await supabase.from("webhook_messages").insert({
    clinic_token_id: clinic.id, user_id: clinic.user_id || null,
    sender_phone: telefone, sender_name: travadas[0].paciente_nome || null,
    message_text: texto, direction: "outgoing",
    ai_intent: "confirmacao_insistencia", action_status: "success",
    conversation_id: convId, verified_schedule: true,
    ai_entities: { attendance_ids: travadas.map((t: any) => Number(t.attendance_id)), data_consulta: alvo },
  }).select("id").single();

  const env = await enviarTexto(canal, telefone, texto);
  if (!env.ok) {
    await supabase.from("confirmacao_insistencia").update({ status: "falhou", motivo: env.detalhe.slice(0, 200) }).in("id", ids);
    if (saida?.id) {
      await supabase.from("webhook_messages")
        .update({ action_status: "failed", ai_intent: "confirmacao_insistencia_falhou", action_error: env.detalhe.slice(0, 200) })
        .eq("id", saida.id);
    }
    console.error(`[Insistencia] envio falhou ...${telefone.slice(-4)}: ${env.detalhe}`);
    return { clinica: clinic.id, erro: "envio_falhou" };
  }
  await supabase.from("confirmacao_insistencia")
    .update({ status: "enviada", conversation_id: convId, mensagem_id: saida?.id ?? null })
    .in("id", ids);
  if (convId) {
    await supabase.from("chat_conversations")
      .update({ last_message: texto.slice(0, 200), last_message_at: new Date().toISOString() })
      .eq("id", convId);
  }
  console.log(`[Insistencia] enviada ...${telefone.slice(-4)} (${ids.length} consulta(s))`);
  return { clinica: clinic.id, enviada: ids.length };
}

// ── RELATÓRIO DIÁRIO NO SLACK (21/10, pedido do dono) ─────────────────────────
// pg_cron às 18h10 de SP chama com {"relatorio": true}. Uma vez por dia (marca na
// própria tabela: attendance_id = -1, data_consulta = dia do envio, status 'relatorio');
// `destino` só serve para teste (manda a outra pessoa e não marca o dia).
async function enviarRelatorio(supabase: any, clinic: any, destinoTeste: string | null) {
  const { hojeISO } = agoraSP();
  const token = String(clinic.slack_bot_token || "");
  const destino = destinoTeste || String(clinic.slack_relatorio_para || "");
  if (!token) return { clinica: clinic.id, relatorio: "sem token do Slack (clinic_tokens.slack_bot_token)" };
  if (!destino) return { clinica: clinic.id, relatorio: "sem destino (clinic_tokens.slack_relatorio_para)" };

  if (!destinoTeste) {
    const { data: marca } = await supabase.from("confirmacao_insistencia").select("id, status")
      .eq("clinic_token_id", clinic.id).eq("data_consulta", hojeISO).eq("attendance_id", -1).maybeSingle();
    if (marca?.status === "relatorio") return { clinica: clinic.id, relatorio: "já enviado hoje" };
    const { error: mErr } = await supabase.from("confirmacao_insistencia").upsert({
      clinic_token_id: clinic.id, data_consulta: hojeISO, attendance_id: -1, patient_id: 0, status: "relatorio_enviando",
    }, { onConflict: "clinic_token_id,data_consulta,attendance_id" });
    if (mErr) return { clinica: clinic.id, relatorio: `marca não gravada: ${mErr.message}` };
  }

  const { data: linhas } = await supabase.from("confirmacao_insistencia")
    .select("id, status, motivo, paciente_nome, medico_nome, telefone, telefone_chave, hora, data_consulta, enviada_em")
    .eq("clinic_token_id", clinic.id).gt("attendance_id", 0).eq("data_consulta", proximoDiaUtil(hojeISO))
    .order("hora", { ascending: true }).limit(500);
  const rows = (linhas || []) as Array<LinhaDoRelatorio & { id: string; telefone_chave: string | null }>;

  // o que cada um escreveu depois do envio
  const respostas = new Map<string, string[]>();
  // a equipe falou com o paciente depois da mensagem: o caso já está com ela (22/10 — o
  // "Sim" do Eduardo respondia à Caroline e saiu como "respondeu outra coisa")
  const equipe = new Set<string>();
  const enviados = rows.filter((r) => r.enviada_em);
  if (enviados.length) {
    const desde = enviados.map((r) => String(r.enviada_em)).sort()[0];
    const { data: msgs } = await supabase.from("webhook_messages")
      .select("sender_phone, message_text, created_at")
      .eq("clinic_token_id", clinic.id).eq("direction", "incoming").gte("created_at", desde)
      .order("created_at", { ascending: true }).limit(1000);
    const { data: falas } = await supabase.from("webhook_messages")
      .select("sender_phone, created_at")
      .eq("clinic_token_id", clinic.id).eq("direction", "outgoing").eq("ai_intent", "manual_reply").gte("created_at", desde)
      .limit(1000);
    for (const r of enviados) {
      const t = Date.parse(String(r.enviada_em));
      const dele = (msgs || []).filter((m: any) => chaveDoTelefone(m.sender_phone) === r.telefone_chave && Date.parse(m.created_at) > t);
      if (dele.length) respostas.set(r.id, dele.map((m: any) => String(m.message_text || "")));
      // fala da equipe 2 min depois do envio (antes disso pode ser o eco da própria mensagem)
      if ((falas || []).some((f: any) => chaveDoTelefone(f.sender_phone) === r.telefone_chave && Date.parse(f.created_at) > t + 120000)) equipe.add(r.id);
    }
  }
  const texto = textoParaAMardila(montarRelatorio(rows, respostas, hojeISO, rows.map((r) => r.id), equipe));
  const env = await enviarDMNoSlack(token, destino, texto);
  if (!destinoTeste) {
    await supabase.from("confirmacao_insistencia")
      .update({ status: env.ok ? "relatorio" : "relatorio_falhou", motivo: env.ok ? null : env.detalhe.slice(0, 200) })
      .eq("clinic_token_id", clinic.id).eq("data_consulta", hojeISO).eq("attendance_id", -1);
  }
  console.log(`[Insistencia] relatório ${env.ok ? "enviado" : "falhou: " + env.detalhe} (${rows.length} consultas)`);
  return { clinica: clinic.id, relatorio: env.ok ? "enviado" : `falhou: ${env.detalhe}`, consultas: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!chamadaDeCronAutorizada(req, Deno.env.get("CRON_SECRET"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });
  }
  let simular = false;
  let foraDaJanela = false;
  let relatorio = false;
  let destinoTeste: string | null = null;
  try {
    const b = await req.json();
    simular = b?.simular === true;
    foraDaJanela = b?.enviar_fora_da_janela === true;
    relatorio = b?.relatorio === true;
    destinoTeste = typeof b?.destino === "string" && /^[UW][A-Z0-9]{6,}(,[UW][A-Z0-9]{6,}){0,7}$/.test(b.destino) ? b.destino : null;
  } catch { /* sem corpo */ }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let q = supabase
    .from("clinic_tokens")
    .select("id, user_id, token, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel, confirmacao_insistencia, confirmacao_insistencia_so_medico, slack_bot_token, slack_relatorio_para")
    .eq("is_active", true);
  if (!simular) q = q.in("confirmacao_insistencia", ["teste", "on"]);
  const { data: clinicas, error } = await q;
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });

  const out: unknown[] = [];
  for (const c of clinicas || []) {
    if (!c.token) continue;
    try {
      out.push(relatorio ? await enviarRelatorio(supabase, c, destinoTeste) : await processarClinica(supabase, c, simular, foraDaJanela));
    } catch (e) {
      console.error(`[Insistencia] clínica ${c.id}: ${(e as Error).message}`);
      out.push({ clinica: c.id, erro: (e as Error).message });
    }
  }
  return new Response(JSON.stringify({ ok: true, resultado: out }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
