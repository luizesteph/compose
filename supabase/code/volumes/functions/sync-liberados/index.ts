// Cron (5 min): copia a lista de infiltração liberada do PDF Visco e completa com os dados do
// paciente no Amigo. Só lê dos dois lados. Regras do casamento em _shared/liberados.ts.
//
// Corpo opcional, com o segredo do cron:
//   {"agenda_mes":"2026-10"}                   varre um mês da agenda do Amigo para o índice
//   {"conferir":[{"nome":"…","medico":"…"}]}   conta como os nomes casariam, sem gravar
//   {"so_casar":true}                          procura no Amigo quem já está na lista, sem ler o PDF Visco
//   {"simular_aviso":true}                     diz quem receberia o aviso agora, sem enviar
//
// Erro ao ler o PDF Visco não mexe na lista: só resposta boa tira alguém de lá.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { chamadaDeCronAutorizada } from "../_shared/cron.ts";
import { ehFeriado } from "../_shared/confirmacao.ts";
import { canalVivo, enviarTexto, situacaoDoTicket } from "../_shared/zpro.ts";
import { getPhoneVariants, telefoneSemJulia } from "../whatsapp-webhook/helpers.ts";
import {
  AGENDA_DIAS_ANTES,
  AGENDA_DIAS_DEPOIS,
  agendamentoDoLiberado,
  casarPaciente,
  celularParaEnvio,
  convenioDaFicha,
  INTENT_AVISO_DE_LIBERACAO,
  linhasDaAgenda,
  podeAvisarAgora,
  prepararAgenda,
  recebeAviso,
  textoAvisoDeLiberacao,
  type LinhaDaAgenda,
} from "../_shared/liberados.ts";

const AMIGO = "https://amigobot-api.amigoapp.com.br";
const TAMANHO_DO_LOTE = 500;
const NOVA_TENTATIVA_MS = 6 * 3600000;
const AGENDA_VELHA_MS = 6 * 3600000;
const MAX_CASAR_POR_RODADA = 30;
const TENTATIVAS_DE_AVISO_POR_RODADA = 5;
const CONVERSA_ATIVA_MS = 2 * 3600000;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

const hojeSP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

function somaDias(iso: string, dias: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
}

function ultimoDiaDoMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

function companyDoToken(tok: string): string {
  try {
    const b = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(b + "===".slice((b.length + 3) % 4))).company_id ?? "");
  } catch {
    return "";
  }
}

async function lerAtendimentos(tok: string, ini: string, fim: string): Promise<any[] | null> {
  const url = `${AMIGO}/attendances?company_id=${companyDoToken(tok)}&start_date=${ini}&end_date=${fim}&status=ALL`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) {
      console.error(`[Liberados] GET attendances ${r.status}`);
      return null;
    }
    const j = await r.json();
    return Array.isArray(j?.data) ? j.data : [];
  } catch (e) {
    console.error(`[Liberados] GET attendances falhou: ${(e as Error).message}`);
    return null;
  }
}

async function varrerAgenda(supabase: any, clinicId: string, tok: string, ini: string, fim: string): Promise<number | null> {
  const atendimentos = await lerAtendimentos(tok, ini, fim);
  if (!atendimentos) return null;
  try {
    const linhas = linhasDaAgenda(atendimentos);
    let gravadas = 0;
    for (let i = 0; i < linhas.length; i += TAMANHO_DO_LOTE) {
      const { data, error } = await supabase.rpc("amigo_agenda_gravar", {
        p_clinic: clinicId,
        p_linhas: linhas.slice(i, i + TAMANHO_DO_LOTE),
      });
      if (error) {
        console.error(`[Liberados] gravar agenda: ${error.message}`);
        return null;
      }
      gravadas += Number(data) || 0;
    }
    return gravadas;
  } catch (e) {
    console.error(`[Liberados] agenda falhou: ${(e as Error).message}`);
    return null;
  }
}

async function agendaInteira(supabase: any, clinicId: string): Promise<LinhaDaAgenda[]> {
  const todas: LinhaDaAgenda[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase
      .from("amigo_agenda")
      .select("amigo_patient_id, medico_id, medico_nome, nome, celular, ultima_data, realizada")
      .eq("clinic_token_id", clinicId)
      .order("amigo_patient_id")
      .order("medico_id")
      .range(de, de + 999);
    if (error) throw new Error(error.message);
    todas.push(...((data || []) as LinhaDaAgenda[]));
    if (!data || data.length < 1000) return todas;
  }
}

async function lerLiberados(c: { url: string; anon: string; token: string }): Promise<any[] | null> {
  const todos: any[] = [];
  try {
    for (let de = 0; ; de += 1000) {
      const r = await fetch(`${c.url}/rest/v1/liberados_para_julia?select=*&order=liberado_em.desc&limit=1000&offset=${de}`, {
        headers: { apikey: c.anon, Authorization: `Bearer ${c.token}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        console.error(`[Liberados] PDF Visco ${r.status}`);
        return null;
      }
      const lista = await r.json();
      if (!Array.isArray(lista)) return null;
      todos.push(...lista);
      if (lista.length < 1000) return todos;
    }
  } catch (e) {
    console.error(`[Liberados] PDF Visco falhou: ${(e as Error).message}`);
    return null;
  }
}

async function fichaDoAmigo(tok: string, patientId: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${AMIGO}/patients/${patientId}?company_id=${companyDoToken(tok)}`, {
      headers: { Authorization: `Bearer ${tok}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j?.data ?? j;
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

async function sincronizar(supabase: any, clinica: any) {
  const lista = await lerLiberados(clinica.pdfvisco_leitura);
  if (!lista) return { visco: "falhou" };

  const agora = new Date().toISOString();
  if (lista.length) {
    const { error } = await supabase.from("infiltracao_liberados").upsert(
      lista.map((l) => ({
        clinic_token_id: clinica.id,
        liberacao_id: l.liberacao_id,
        visco_patient_id: l.patient_id,
        paciente_nome: l.patient_name,
        medico_nome: l.doctor_name,
        convenio: l.provider_name,
        articulacao: l.target_joint,
        bilateral: l.is_bilateral,
        medicamento: l.medication,
        quantidade: l.quantity,
        data_exame: l.exam_date,
        validade_guia: l.validade_guia,
        liberado_em: l.liberado_em,
        liberado_por: l.liberado_por_email,
        ativo: true,
        saiu_em: null,
        updated_at: agora,
      })),
      { onConflict: "clinic_token_id,liberacao_id" },
    );
    if (error) throw new Error(error.message);
  }

  const { data: nossos, error: eNossos } = await supabase
    .from("infiltracao_liberados")
    .select("id, liberacao_id, ativo, casamento, casado_em, paciente_nome, medico_nome")
    .eq("clinic_token_id", clinica.id)
    .eq("ativo", true);
  if (eNossos) throw new Error(eNossos.message);

  const naLista = new Set(lista.map((l) => String(l.liberacao_id)));
  const sairam = (nossos || []).filter((n: any) => !naLista.has(String(n.liberacao_id)));
  if (sairam.length) {
    await supabase
      .from("infiltracao_liberados")
      .update({ ativo: false, saiu_em: agora, updated_at: agora })
      .in("id", sairam.map((n: any) => n.id));
  }

  const casados = await casarPendentes(
    supabase,
    clinica,
    (nossos || []).filter((n: any) => naLista.has(String(n.liberacao_id))),
  );
  return { visco: lista.length, sairam: sairam.length, casados };
}

async function casarPendentes(supabase: any, clinica: any, linhas: any[]): Promise<number> {
  // agenda fresca antes de casar: o paciente pode ter passado aqui hoje
  const { data: recente } = await supabase
    .from("amigo_agenda")
    .select("atualizada_em")
    .eq("clinic_token_id", clinica.id)
    .order("atualizada_em", { ascending: false })
    .limit(1);
  const ultima = Date.parse(recente?.[0]?.atualizada_em ?? "") || 0;
  if (Date.now() - ultima > AGENDA_VELHA_MS) {
    const hoje = hojeSP();
    await varrerAgenda(supabase, clinica.id, clinica.token, somaDias(hoje, -AGENDA_DIAS_ANTES), somaDias(hoje, AGENDA_DIAS_DEPOIS));
  }

  const limite = Date.now() - NOVA_TENTATIVA_MS;
  const aCasar = linhas
    .filter((n: any) => n.casamento === "pendente" || (n.casamento !== "exato" && (Date.parse(n.casado_em ?? "") || 0) < limite))
    .slice(0, MAX_CASAR_POR_RODADA);
  if (!aCasar.length) return 0;

  const agora = new Date().toISOString();
  const agenda = prepararAgenda(await agendaInteira(supabase, clinica.id));
  for (const n of aCasar) {
    const r = casarPaciente(n.paciente_nome, n.medico_nome, agenda);
    const ficha = r.amigo_patient_id ? await fichaDoAmigo(clinica.token, r.amigo_patient_id) : null;
    const { error } = await supabase
      .from("infiltracao_liberados")
      .update({
        casamento: r.casamento,
        amigo_patient_id: r.amigo_patient_id,
        nome_amigo: r.nome_amigo,
        telefone: String(ficha?.contact_cellphone ?? "").replace(/\D/g, "") || r.celular,
        cpf: ficha?.cpf ? String(ficha.cpf) : null,
        email: ficha?.email ? String(ficha.email) : null,
        convenio_amigo: convenioDaFicha(ficha?.health_insurance),
        medico_confere: r.medico_confere,
        medico_amigo_id: r.medico_amigo_id,
        ultima_consulta_medico: r.ultima_consulta_medico,
        candidatos: r.candidatos,
        casado_em: agora,
        updated_at: agora,
      })
      .eq("id", n.id);
    if (error) console.error(`[Liberados] gravar casamento: ${error.message}`);
  }
  return aCasar.length;
}

async function acharOuCriarConversa(supabase: any, clinica: any, telefone: string, nome: string): Promise<string | null> {
  const { data } = await supabase
    .from("chat_conversations")
    .select("id")
    .eq("clinic_token_id", clinica.id)
    .in("phone", getPhoneVariants(telefone))
    .order("last_message_at", { ascending: false })
    .limit(1);
  if (data?.[0]?.id) return data[0].id;
  const { data: nova } = await supabase
    .from("chat_conversations")
    .insert({ user_id: clinica.user_id, clinic_token_id: clinica.id, phone: telefone, contact_name: nome || "" })
    .select("id")
    .single();
  return nova?.id ?? null;
}

function agoraEmSP() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const diaDaSemana = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(v("weekday"));
  return { diaDaSemana, minutos: (Number(v("hour")) % 24) * 60 + Number(v("minute")) };
}

/** Uma mensagem por telefone: o Mauri tem duas guias e recebe um aviso só. */
function porTelefone(linhas: any[], hoje: string): any[][] {
  const grupos = new Map<string, any[]>();
  for (const l of linhas) {
    if (!recebeAviso(l, hoje)) continue;
    const tel = celularParaEnvio(l.telefone) as string;
    if (telefoneSemJulia(tel)) continue;
    grupos.set(tel, [...(grupos.get(tel) || []), l]);
  }
  return [...grupos.values()];
}

async function enviarUmAviso(supabase: any, clinica: any, grupos: any[][]) {
  const canal = canalVivo(clinica);
  if (!canal) return { enviado: false, motivo: "sem_canal_vivo" };
  const desde = new Date(Date.now() - CONVERSA_ATIVA_MS).toISOString();

  for (const grupo of grupos.slice(0, TENTATIVAS_DE_AVISO_POR_RODADA)) {
    const telefone = celularParaEnvio(grupo[0].telefone) as string;
    // em conversa, ou com atendente na ficha: a equipe já está com ele
    const { data: falou } = await supabase
      .from("webhook_messages")
      .select("id")
      .eq("clinic_token_id", clinica.id)
      .eq("direction", "incoming")
      .in("sender_phone", getPhoneVariants(telefone))
      .gte("created_at", desde)
      .limit(1);
    if (falou?.length) continue;
    if ((await situacaoDoTicket(canal, telefone)) !== "livre") continue;

    // marca ANTES de enviar: envio que falha não repete (lição do lembrete do link, 25/09)
    const { data: travadas } = await supabase
      .from("infiltracao_liberados")
      .update({ aviso_enviado_em: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in("id", grupo.map((l) => l.id))
      .is("aviso_enviado_em", null)
      .select("id");
    if (!travadas?.length) continue;
    const ids = travadas.map((t: any) => t.id);

    const nome = grupo[0].nome_amigo || grupo[0].paciente_nome;
    const texto = textoAvisoDeLiberacao(nome, grupo.map((l) => l.medico_nome));
    const convId = await acharOuCriarConversa(supabase, clinica, telefone, nome);
    const { data: saida } = await supabase.from("webhook_messages").insert({
      clinic_token_id: clinica.id, user_id: clinica.user_id || null,
      sender_phone: telefone, sender_name: nome || null,
      message_text: texto, direction: "outgoing",
      ai_intent: INTENT_AVISO_DE_LIBERACAO, action_status: "success",
      conversation_id: convId, verified_schedule: true,
      ai_entities: { liberacao_ids: grupo.map((l) => l.liberacao_id) },
    }).select("id").single();

    const env = await enviarTexto(canal, telefone, texto);
    if (!env.ok) {
      await supabase.from("infiltracao_liberados").update({ aviso_erro: env.detalhe.slice(0, 200) }).in("id", ids);
      if (saida?.id) {
        await supabase.from("webhook_messages")
          .update({ action_status: "failed", ai_intent: `${INTENT_AVISO_DE_LIBERACAO}_falhou`, action_error: env.detalhe.slice(0, 200) })
          .eq("id", saida.id);
      }
      console.error(`[Liberados] aviso falhou ...${telefone.slice(-4)}: ${env.detalhe}`);
      return { enviado: false, motivo: "envio_falhou" };
    }
    if (convId) {
      await supabase.from("chat_conversations")
        .update({ last_message: texto.slice(0, 200), last_message_at: new Date().toISOString() })
        .eq("id", convId);
    }
    console.log(`[Liberados] aviso enviado ...${telefone.slice(-4)}`);
    return { enviado: true };
  }
  return { enviado: false, motivo: "ninguem_livre" };
}

/** Lê do Amigo quem já marcou e, com o aviso ligado, avisa um paciente por rodada. */
async function acompanharLiberados(supabase: any, clinica: any, simular = false) {
  const { data: linhas, error } = await supabase
    .from("infiltracao_liberados")
    .select("id, liberacao_id, paciente_nome, nome_amigo, medico_nome, medico_amigo_id, amigo_patient_id, liberado_em, casamento, telefone, validade_guia, aviso_enviado_em, agendado_para, feita_em")
    .eq("clinic_token_id", clinica.id)
    .eq("ativo", true)
    .is("feita_em", null);
  if (error) throw new Error(error.message);
  if (!linhas?.length) return { liberados: 0 };

  const hoje = hojeSP();
  const agora = agoraEmSP();
  const podeAvisar = clinica.liberados_aviso === "on" &&
    podeAvisarAgora({ ...agora, feriado: ehFeriado(hoje) }) && porTelefone(linhas, hoje).length > 0;
  // a cada 30 min basta; antes de avisar, sempre, para não oferecer a quem acabou de marcar
  if (!simular && !podeAvisar && agora.minutos % 30 >= 5) return { liberados: linhas.length };

  const atendimentos = await lerAtendimentos(clinica.token, somaDias(hoje, -AGENDA_DIAS_ANTES), somaDias(hoje, AGENDA_DIAS_DEPOIS));
  if (!atendimentos) return { liberados: linhas.length, amigo: "falhou" };

  const atualizadas = [];
  for (const l of linhas) {
    const achado = agendamentoDoLiberado(l, atendimentos);
    // consulta que já saiu da janela lida continua valendo
    const vencida = l.agendado_para && String(l.agendado_para).slice(0, 10) < somaDias(hoje, -AGENDA_DIAS_ANTES);
    const novo = achado ?? (vencida ? { agendado_para: l.agendado_para, agendado_tipo: undefined } : { agendado_para: null, agendado_tipo: null });
    if (String(novo.agendado_para ?? "").slice(0, 16) !== String(l.agendado_para ?? "").slice(0, 16) && !simular) {
      await supabase.from("infiltracao_liberados")
        .update({ agendado_para: novo.agendado_para, agendado_tipo: novo.agendado_tipo, updated_at: new Date().toISOString() })
        .eq("id", l.id);
    }
    atualizadas.push({ ...l, agendado_para: novo.agendado_para });
  }

  const grupos = porTelefone(atualizadas, hoje);
  if (simular) {
    return {
      modo: clinica.liberados_aviso,
      podeAvisarAgora: podeAvisarAgora({ ...agora, feriado: ehFeriado(hoje) }),
      receberiam: grupos.map((g) => ({
        nome: g[0].nome_amigo || g[0].paciente_nome,
        final: String(g[0].telefone).slice(-4),
        texto: textoAvisoDeLiberacao(g[0].nome_amigo || g[0].paciente_nome, g.map((l) => l.medico_nome)),
      })),
    };
  }
  if (podeAvisar && grupos.length) return { liberados: linhas.length, aviso: await enviarUmAviso(supabase, clinica, grupos) };
  return { liberados: linhas.length };
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const chave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!chamadaDeCronAutorizada(req, Deno.env.get("CRON_SECRET"), chave)) return json({ error: "unauthorized" }, 401);

  const supabase = createClient(supabaseUrl, chave);
  const corpo = await req.json().catch(() => ({}));

  const { data: clinicas, error } = await supabase
    .from("clinic_tokens")
    .select("id, token, user_id, pdfvisco_leitura, liberados_aviso, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel")
    .eq("is_active", true)
    .not("token", "is", null);
  if (error) return json({ error: error.message }, 500);

  if (typeof corpo?.agenda_mes === "string" && /^\d{4}-\d{2}$/.test(corpo.agenda_mes)) {
    const saida: Record<string, number | null> = {};
    for (const c of clinicas || []) {
      saida[c.id] = await varrerAgenda(supabase, c.id, c.token, `${corpo.agenda_mes}-01`, ultimoDiaDoMes(corpo.agenda_mes));
    }
    return json({ ok: true, saida });
  }

  if (Array.isArray(corpo?.conferir)) {
    const contagem: Record<string, number> = {};
    for (const c of clinicas || []) {
      const linhas = await agendaInteira(supabase, c.id);
      if (!linhas.length) continue;
      const agenda = prepararAgenda(linhas);
      for (const p of corpo.conferir) {
        const r = casarPaciente(String(p?.nome ?? ""), String(p?.medico ?? ""), agenda);
        contagem[r.casamento] = (contagem[r.casamento] || 0) + 1;
      }
    }
    return json({ ok: true, contagem });
  }

  if (corpo?.so_casar === true) {
    const saida: Record<string, number> = {};
    for (const c of clinicas || []) {
      const { data, error: e } = await supabase
        .from("infiltracao_liberados")
        .select("id, casamento, casado_em, paciente_nome, medico_nome")
        .eq("clinic_token_id", c.id)
        .eq("ativo", true);
      if (e) return json({ error: e.message }, 500);
      saida[c.id] = await casarPendentes(supabase, c, data || []);
    }
    return json({ ok: true, saida });
  }

  if (corpo?.simular_aviso === true) {
    const saida: unknown[] = [];
    for (const c of clinicas || []) saida.push(await acompanharLiberados(supabase, c, true));
    return json({ ok: true, saida });
  }

  const resumo: unknown[] = [];
  for (const c of clinicas || []) {
    try {
      const lista = c.pdfvisco_leitura ? await sincronizar(supabase, c) : null;
      resumo.push({ lista, acompanhamento: await acompanharLiberados(supabase, c) });
    } catch (e) {
      console.error(`[Liberados] clínica ${c.id}: ${(e as Error).message}`);
      resumo.push({ erro: true });
    }
  }
  return json({ ok: true, resumo });
});
