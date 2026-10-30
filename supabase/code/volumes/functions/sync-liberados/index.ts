// Cron (5 min): copia a lista de infiltração liberada do PDF Visco e completa com os dados do
// paciente no Amigo. Só lê dos dois lados. Regras do casamento em _shared/liberados.ts.
//
// Corpo opcional, com o segredo do cron:
//   {"agenda_mes":"2026-10"}                   varre um mês da agenda do Amigo para o índice
//   {"conferir":[{"nome":"…","medico":"…"}]}   conta como os nomes casariam, sem gravar
//
// Erro ao ler o PDF Visco não mexe na lista: só resposta boa tira alguém de lá.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { chamadaDeCronAutorizada } from "../_shared/cron.ts";
import { casarPaciente, convenioDaFicha, linhasDaAgenda, type LinhaDaAgenda } from "../_shared/liberados.ts";

const AMIGO = "https://amigobot-api.amigoapp.com.br";
const TAMANHO_DO_LOTE = 500;
const NOVA_TENTATIVA_MS = 6 * 3600000;
const AGENDA_VELHA_MS = 6 * 3600000;
const MAX_CASAR_POR_RODADA = 30;

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

async function varrerAgenda(supabase: any, clinicId: string, tok: string, ini: string, fim: string): Promise<number | null> {
  const url = `${AMIGO}/attendances?company_id=${companyDoToken(tok)}&start_date=${ini}&end_date=${fim}&status=ALL`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) {
      console.error(`[Liberados] GET attendances ${r.status}`);
      return null;
    }
    const j = await r.json();
    const linhas = linhasDaAgenda(Array.isArray(j?.data) ? j.data : []);
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
        validade_guia: l.expiration_date,
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
    await varrerAgenda(supabase, clinica.id, clinica.token, somaDias(hoje, -8), somaDias(hoje, 90));
  }

  const limite = Date.now() - NOVA_TENTATIVA_MS;
  const aCasar = (nossos || [])
    .filter((n: any) => naLista.has(String(n.liberacao_id)))
    .filter((n: any) => n.casamento === "pendente" || (n.casamento !== "exato" && (Date.parse(n.casado_em ?? "") || 0) < limite))
    .slice(0, MAX_CASAR_POR_RODADA);
  if (!aCasar.length) return { visco: lista.length, sairam: sairam.length, casados: 0 };

  const agenda = await agendaInteira(supabase, clinica.id);
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
  return { visco: lista.length, sairam: sairam.length, casados: aCasar.length };
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const chave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!chamadaDeCronAutorizada(req, Deno.env.get("CRON_SECRET"), chave)) return json({ error: "unauthorized" }, 401);

  const supabase = createClient(supabaseUrl, chave);
  const corpo = await req.json().catch(() => ({}));

  const { data: clinicas, error } = await supabase
    .from("clinic_tokens")
    .select("id, token, pdfvisco_leitura")
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
      const agenda = await agendaInteira(supabase, c.id);
      if (!agenda.length) continue;
      for (const p of corpo.conferir) {
        const r = casarPaciente(String(p?.nome ?? ""), String(p?.medico ?? ""), agenda);
        contagem[r.casamento] = (contagem[r.casamento] || 0) + 1;
      }
    }
    return json({ ok: true, contagem });
  }

  const resumo: unknown[] = [];
  for (const c of (clinicas || []).filter((x) => x.pdfvisco_leitura)) {
    try {
      resumo.push(await sincronizar(supabase, c));
    } catch (e) {
      console.error(`[Liberados] clínica ${c.id}: ${(e as Error).message}`);
      resumo.push({ erro: true });
    }
  }
  return json({ ok: true, resumo });
});
