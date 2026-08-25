// Cron function: sincroniza local_attendances com Amigo API.
//
// Roda a cada 5min (deve ser agendado em pg_cron pelo admin):
//   SELECT cron.schedule('sync-amigo-cache', '*/5 * * * *',
//     $$ SELECT net.http_post(url:='https://<projeto>.supabase.co/functions/v1/sync-amigo-cache',
//                              headers:='{"Authorization":"Bearer SERVICE_KEY"}'::jsonb) $$);
//
// Estratégia:
// 1. Para cada clinic_token com Amigo configurado:
//    a. Lista patients ativos (com phone) do local_patients
//    b. Para cada um, fetch attendances do Amigo
//    c. Upsert em local_attendances (canonical fields + raw json)
//    d. Mark stale rows (que estavam scheduled mas sumiram do Amigo) como 'canceled_remote'
// 2. Processa sync_jobs pendentes (refresh on-demand).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const AMIGO_BASES = [
  "https://amigobot-api.amigoapp.com.br",
  "https://api2.amigoapp.com.br",
  "https://api.amigoapp.com.br",
];

async function tryAmigoFetch(path: string, token: string): Promise<{ data: any; status: number }> {
  for (const base of AMIGO_BASES) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${base}/${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(tid));
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        return { data: json, status: res.status };
      }
      if (res.status === 404 || res.status === 400) {
        return { data: null, status: res.status };
      }
    } catch { /* try next base */ }
  }
  return { data: null, status: 0 };
}

function normalizeArray(d: any): any[] {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.attendances)) return d.attendances;
  if (Array.isArray(d?.results)) return d.results;
  return [];
}

function parseDateTime(att: any): { date: string; time: string; iso: string } | null {
  const raw = String(att.start_date || att.date || att.scheduledFor || "");
  if (!raw) return null;
  // Accept formats: "2026-06-15", "2026-06-15 14:30", "2026-06-15T14:30:00"
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ]?(\d{2}:\d{2})?/);
  if (!m) return null;
  const date = m[1];
  const time = m[2] || "00:00";
  return { date, time: time + ":00", iso: `${date}T${time}:00-03:00` };
}

async function syncAttendancesForPatient(
  supabase: any,
  clinicTokenId: string,
  amigoToken: string,
  companyId: string,
  patient: { amigo_patient_id?: string; cpf?: string; phone?: string; name?: string },
): Promise<{ inserted: number; updated: number; cancelled: number }> {
  const patientId = patient.amigo_patient_id;
  if (!patientId) return { inserted: 0, updated: 0, cancelled: 0 };
  const { data, status } = await tryAmigoFetch(`attendances/${patientId}?company_id=${companyId}`, amigoToken);
  if (status >= 400 || !data) return { inserted: 0, updated: 0, cancelled: 0 };
  const arr = normalizeArray(data);
  const seenIds = new Set<string>();
  let inserted = 0;
  let updated = 0;
  for (const att of arr) {
    const dt = parseDateTime(att);
    if (!dt) continue;
    const amigoId = String(att.id || att.attendance_id || "");
    if (!amigoId) continue;
    seenIds.add(amigoId);
    const isCanceled = att.canceled === true || String(att.status || "").toLowerCase().includes("cancel");
    const docObj = att.user || {};
    const row = {
      clinic_token_id: clinicTokenId,
      amigo_attendance_id: amigoId,
      amigo_patient_id: patientId,
      amigo_doctor_id: String(att.user_id || att.doctor_id || docObj.id || ""),
      doctor_name: String(att.user_name || att.doctor_name || docObj.name || ""),
      patient_name: patient.name || null,
      patient_phone: patient.phone || null,
      patient_cpf: patient.cpf || null,
      scheduled_for: dt.iso,
      scheduled_date: dt.date,
      scheduled_time: dt.time,
      status: isCanceled ? "canceled" : "scheduled",
      insurance_name: String(att.insurance_name || att.insurance?.name || "") || null,
      insurance_id: att.insurance_id ? String(att.insurance_id) : null,
      raw: att,
      last_synced_at: new Date().toISOString(),
    };
    try {
      const { error } = await supabase
        .from("local_attendances")
        .upsert(row, { onConflict: "clinic_token_id,amigo_attendance_id" });
      if (error) {
        console.warn(`[sync] upsert failed for ${amigoId}: ${error.message}`);
      } else {
        updated++;
      }
    } catch (e) {
      console.warn(`[sync] upsert exception for ${amigoId}: ${(e as Error).message}`);
    }
  }

  // Mark local rows as canceled_remote if Amigo no longer returns them
  let cancelled = 0;
  try {
    const { data: localRows } = await supabase
      .from("local_attendances")
      .select("amigo_attendance_id")
      .eq("clinic_token_id", clinicTokenId)
      .eq("amigo_patient_id", patientId)
      .eq("status", "scheduled");
    const toCancel = (localRows || [])
      .map((r: any) => r.amigo_attendance_id)
      .filter((id: string) => !seenIds.has(id));
    if (toCancel.length > 0) {
      await supabase
        .from("local_attendances")
        .update({ status: "canceled_remote", last_synced_at: new Date().toISOString() })
        .eq("clinic_token_id", clinicTokenId)
        .eq("amigo_patient_id", patientId)
        .in("amigo_attendance_id", toCancel);
      cancelled = toCancel.length;
    }
  } catch (e) {
    console.warn(`[sync] cancel-stale exception: ${(e as Error).message}`);
  }
  return { inserted, updated, cancelled };
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
  const summary = {
    clinics_processed: 0,
    patients_processed: 0,
    attendances_synced: 0,
    canceled_marked: 0,
    jobs_processed: 0,
    errors: 0,
  };

  try {
    // 1. Process pending sync_jobs (priority over scheduled cron sync)
    const { data: jobs } = await supabase
      .from("sync_jobs")
      .select("id, clinic_token_id, job_type, payload, attempts")
      .eq("status", "pending")
      .lte("scheduled_at", new Date().toISOString())
      .limit(20);
    for (const job of jobs || []) {
      try {
        await supabase.from("sync_jobs").update({ status: "running", attempts: job.attempts + 1 }).eq("id", job.id);
        const { data: token } = await supabase
          .from("clinic_tokens")
          .select("amigo_token, company_id")
          .eq("id", job.clinic_token_id)
          .single();
        if (!token?.amigo_token || !token?.company_id) {
          await supabase
            .from("sync_jobs")
            .update({ status: "failed", processed_at: new Date().toISOString(), last_error: "missing amigo creds" })
            .eq("id", job.id);
          continue;
        }
        const p = job.payload as any;
        if (job.job_type === "refresh_attendances_for_patient" && p.amigo_patient_id) {
          const result = await syncAttendancesForPatient(supabase, job.clinic_token_id, token.amigo_token, token.company_id, {
            amigo_patient_id: p.amigo_patient_id,
            phone: p.phone || null,
            cpf: p.cpf || null,
            name: p.name || null,
          });
          summary.attendances_synced += result.updated;
          summary.canceled_marked += result.cancelled;
        }
        await supabase
          .from("sync_jobs")
          .update({ status: "done", processed_at: new Date().toISOString() })
          .eq("id", job.id);
        summary.jobs_processed++;
      } catch (e) {
        summary.errors++;
        await supabase
          .from("sync_jobs")
          .update({ status: "failed", processed_at: new Date().toISOString(), last_error: (e as Error).message })
          .eq("id", job.id);
      }
    }

    // 2. Scheduled background sync: iterate clinics, sync patients with recent activity (24h)
    const { data: clinics } = await supabase
      .from("clinic_tokens")
      .select("id, amigo_token, company_id")
      .not("amigo_token", "is", null);

    for (const clinic of clinics || []) {
      if (!clinic.amigo_token || !clinic.company_id) continue;
      summary.clinics_processed++;
      const { data: recentPatients } = await supabase
        .from("local_patients")
        .select("amigo_patient_id, cpf, phone, name")
        .eq("clinic_token_id", clinic.id)
        .not("amigo_patient_id", "is", null)
        .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(50);

      for (const patient of recentPatients || []) {
        try {
          const result = await syncAttendancesForPatient(supabase, clinic.id, clinic.amigo_token, clinic.company_id, patient as any);
          summary.attendances_synced += result.updated;
          summary.canceled_marked += result.cancelled;
          summary.patients_processed++;
        } catch (e) {
          summary.errors++;
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[sync-amigo-cache] fatal: ${(e as Error).message}`);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message, summary }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
