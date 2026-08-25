import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// ── Date/time canonicalization helpers (BUG-1 FIX) ──
// Duplicated from whatsapp-webhook/index.ts so this Edge function stays self-contained.
// Both halves of the booking pipeline must agree on the canonical YYYY-MM-DD / HH:mm format.

/** Normalize a date string to canonical YYYY-MM-DD. Returns "" if unparseable. */
function normalizeDateToISO(input: string): string {
  if (!input) return "";
  const s = String(input).trim();
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const brMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (brMatch) {
    const [, d, m, y] = brMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return "";
}

/**
 * Robust extraction of {date, time} from a start_date in ANY common format the Amigo API echoes:
 *   "2026-04-09 14:30:00", "2026-04-09T14:30:00Z", "2026-04-09T14:30:00-03:00",
 *   "09/04/2026 14:30", "2026-04-09 14:30", etc.
 * Returns canonical {date: "YYYY-MM-DD", time: "HH:mm"} or empty strings if it cannot parse.
 */
function extractDateAndTime(startDateStr: string): { date: string; time: string } {
  if (!startDateStr) return { date: "", time: "" };
  const s = String(startDateStr).trim();
  // ISO-style "YYYY-MM-DD[T ]HH:mm"
  const isoMatch = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (isoMatch) {
    const [, y, mo, d, h, mi] = isoMatch;
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  }
  // Brazilian "DD/MM/YYYY HH:mm"
  const brMatch = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (brMatch) {
    const [, d, mo, y, h, mi] = brMatch;
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  }
  // Last-resort: split on "T" or whitespace and normalize each half
  const parts = s.split(/[T ]/);
  return {
    date: normalizeDateToISO(parts[0] || ""),
    time: parts[1]?.match(/^(\d{1,2}):(\d{2})/)
      ? `${parts[1].match(/^(\d{1,2}):(\d{2})/)![1].padStart(2, "0")}:${parts[1].match(/^(\d{1,2}):(\d{2})/)![2]}`
      : "",
  };
}

const API_URLS = [
  "https://amigobot-api.amigoapp.com.br",
  "https://api.amigoapp.com.br",
];

async function tryFetchAmigo(
  endpoint: string,
  amigoToken: string
): Promise<{ data: unknown; status: number }> {
  for (const baseUrl of API_URLS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${baseUrl}/${endpoint}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${amigoToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        return { data, status: res.status };
      }
      if (res.status === 404) continue;
      return { data: null, status: res.status };
    } catch (e) {
      console.log(`[VerifyBooking] Error ${baseUrl}/${endpoint}: ${(e as Error).message}`);
    }
  }
  return { data: null, status: 502 };
}

function normalizeApiResponse(result: { data: unknown; status: number }): unknown {
  let responseData = result.data;
  if (result.status >= 200 && result.status < 300 && responseData && typeof responseData === "object" && !Array.isArray(responseData)) {
    const obj = responseData as Record<string, unknown>;
    if ("data" in obj) responseData = obj.data;
  }
  return responseData;
}

// Returns "open", "pending", "closed", or "unknown" (fail-safe — treat as human-owned)
async function checkTicketStatus(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  phone: string,
  channelId?: string | null
): Promise<string> {
  try {
    const cleanPhone = phone.replace(/\D/g, "");
    const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const payload: Record<string, unknown> = { number: fullPhone };
    if (channelId) {
      payload.channelId = Number(channelId);
      payload.whatsappId = Number(channelId);
    }
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}/showticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      return (data?.status as string) || "";
    }
    console.log(`[VerifyBooking] checkTicketStatus returned ${res.status} — treating as unknown (fail-safe)`);
  } catch (e) {
    console.log(`[VerifyBooking] checkTicketStatus error: ${(e as Error).message} — treating as unknown (fail-safe)`);
  }
  // FAIL-SAFE: if we can't determine status, return "unknown" so callers can block
  return "unknown";
}

async function sendAvanceaiMessage(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  phone: string,
  text: string,
  channelId?: string | null
): Promise<boolean> {
  // Check ticket status BEFORE sending — never send if human agent is active
  const ticketStatus = await checkTicketStatus(baseUrl, apiId, bearerToken, phone, channelId);
  if (ticketStatus === "open" || ticketStatus === "unknown") {
    console.log(`[VerifyBooking] ⛔ Ticket status="${ticketStatus}" — suppressing message to ${phone}`);
    return false;
  }

  const cleanPhone = phone.replace(/\D/g, "");
  const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
  try {
    const payload: Record<string, unknown> = {
      number: fullPhone,
      body: text,
      externalKey: crypto.randomUUID(),
      isClosed: false,
    };
    if (channelId) {
      payload.channelId = Number(channelId);
      payload.whatsappId = Number(channelId);
    }
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[VerifyBooking] AvanceAI send to ${fullPhone}: ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`[VerifyBooking] AvanceAI send error: ${(e as Error).message}`);
    return false;
  }
}

async function fetchSlotsForDate(
  date: string,
  doctorId: string,
  placeId: string,
  eventId: string,
  companyId: string,
  amigoToken: string
): Promise<string[]> {
  try {
    const isoDate = date.includes("/")
      ? (() => { const [d, m, y] = date.split("/"); return `${y}-${m}-${d}`; })()
      : date;
    const calUrl = `calendar?place_id=${placeId}&event_id=${eventId}&user_id=${doctorId}&date=${isoDate}&company_id=${companyId}`;
    const calResult = await tryFetchAmigo(calUrl, amigoToken);
    const calData = normalizeApiResponse(calResult);
    if (Array.isArray(calData)) {
      const times: string[] = [];
      for (const dayObj of calData) {
        const dayDate = String((dayObj as any).date || (dayObj as any).day || "");
        if (dayDate && dayDate !== isoDate) continue;
        const slotsByUser = (dayObj as any).slotsByUser || (dayObj as any).slots_by_user;
        if (slotsByUser && Array.isArray(slotsByUser)) {
          for (const userSlots of slotsByUser) {
            const user = userSlots.user;
            const userId = user?.id || userSlots.user_id;
            if (userId && String(userId) !== String(doctorId)) continue;
            const slots = userSlots.slots || userSlots.available_slots;
            if (slots && Array.isArray(slots)) {
              for (const slot of slots) {
                const raw = String(slot.start_time || slot.startTime || slot.start || slot.time || "");
                const match = raw.match(/(\d{2}:\d{2})/);
                if (match) times.push(match[1]);
              }
            }
          }
        } else {
          const directSlots = (dayObj as any).slots || (dayObj as any).available_slots;
          if (directSlots && Array.isArray(directSlots)) {
            for (const slot of directSlots) {
              const raw = String(slot.start_time || slot.startTime || slot.time || "");
              const match = raw.match(/(\d{2}:\d{2})/);
              if (match) times.push(match[1]);
            }
          }
        }
      }
      return [...new Set(times)].sort().slice(0, 10);
    }
  } catch (e) {
    console.log(`[VerifyBooking] fetchSlots error: ${(e as Error).message}`);
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cronSecret = req.headers.get("x-cron-secret");
  if (!cronSecret || cronSecret !== Deno.env.get("CRON_SECRET")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, key);

    // Fetch pending verifications that are due
    const { data: pending, error } = await admin
      .from("pending_booking_verifications")
      .select("*")
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(20);

    if (error) {
      console.error("[VerifyBooking] Query error:", error.message);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), { status: 200, headers: corsHeaders });
    }

    console.log(`[VerifyBooking] Processing ${pending.length} pending verifications`);
    let verified = 0;
    let failed = 0;
    let retried = 0;

    for (const record of pending) {
      const { id, patient_id, doctor_id, doctor_name, target_date, company_id, amigo_token, attempts, max_attempts } = record;
      // Normalize target_time to HH:MM (strip seconds if present)
      const target_time = (record.target_time || "").substring(0, 5);

      console.log(`[VerifyBooking] Checking #${id}: patient=${patient_id} doctor=${doctor_id} date=${target_date} time=${target_time} attempt=${attempts + 1}/${max_attempts}`);

      // Try to fetch patient's attendances
      let found = false;
      try {
        // Use path param (same pattern as booking-widget)
        const result = await tryFetchAmigo(
          `attendances/${patient_id}?company_id=${company_id}`,
          amigo_token
        );

        if (result.status >= 200 && result.status < 300) {
          const data = normalizeApiResponse(result);
          const attendances = Array.isArray(data) ? data : [];

          // BUG-1 FIX: canonicalize target_date to ISO regardless of how it was stored
          const isoTargetDate = normalizeDateToISO(target_date) || target_date;

          // Log first 3 attendances for diagnostics
          console.log(`[VerifyBooking] Total attendances returned: ${attendances.length}`);
          for (let i = 0; i < Math.min(3, attendances.length); i++) {
            const a = attendances[i] as any;
            console.log(`[VerifyBooking] Att[${i}]: start_date=${a.start_date || a.date}, user_id=${a.user_id || a.user?.id}, status=${a.status || a.attendance_status || "N/A"}`);
          }

          found = attendances.some((att: any) => {
            const status = String(att.status || att.attendance_status || "").toLowerCase();
            // Ignore cancelled attendances
            if (status === "cancelled" || status === "canceled") return false;

            const startDateStr = String(att.start_date || att.date || "");
            // BUG-1 FIX: robust parser handles every format the Amigo API may echo back
            const { date: attDate, time: attTime } = extractDateAndTime(startDateStr);
            const attDoctorId = String(att.user_id || att.user?.id || "");
            return attDate === isoTargetDate && attTime === target_time && attDoctorId === String(doctor_id);
          });

          console.log(`[VerifyBooking] Verification result: found=${found}, looking for date=${isoTargetDate} time=${target_time} doctor=${doctor_id}`);
        } else {
          console.log(`[VerifyBooking] API returned ${result.status}, will retry`);
        }
      } catch (e) {
        console.log(`[VerifyBooking] Fetch error: ${(e as Error).message}`);
      }

      if (found) {
        // ✅ Verified — silently mark as done
        await admin.from("pending_booking_verifications")
          .update({ status: "verified", attempts: attempts + 1 })
          .eq("id", id);
        verified++;
        console.log(`[VerifyBooking] ✅ Verified #${id}`);
        continue;
      }

      // Not found — check if we've exhausted attempts
      const newAttempts = attempts + 1;
      if (newAttempts >= max_attempts) {
        // ❌ Failed — notify patient
        console.log(`[VerifyBooking] ❌ Max attempts reached for #${id}, notifying patient`);

        // Pre-check: if ticket is open (human agent active), suppress notification entirely
        let suppressedByTicket = false;
        if (record.avanceai_base_url && record.avanceai_api_id && record.avanceai_bearer_token) {
          const currentTicketStatus = await checkTicketStatus(
            record.avanceai_base_url, record.avanceai_api_id, record.avanceai_bearer_token, record.phone, record.channel_id
          );
          if (currentTicketStatus === "open" || currentTicketStatus === "unknown") {
            console.log(`[VerifyBooking] ⛔ Ticket status="${currentTicketStatus}" — suppressing failed-booking notification for #${id}`);
            suppressedByTicket = true;
          }
        }

        if (suppressedByTicket) {
          await admin.from("pending_booking_verifications")
            .update({
              status: "failed",
              attempts: newAttempts,
              last_error: "Agendamento não encontrado. Notificação suprimida: ticket open (atendente humano ativo).",
            })
            .eq("id", id);
          failed++;
        } else {
          let message = `Olá! Pedimos desculpas, mas identificamos um problema com seu agendamento${doctor_name ? ` com ${doctor_name}` : ""} para ${target_date} às ${target_time}. `;

          // Try to fetch fresh slots
          if (record.place_id && record.event_id) {
            const freshSlots = await fetchSlotsForDate(
              target_date, doctor_id, record.place_id, record.event_id, company_id, amigo_token
            );
            if (freshSlots.length > 0) {
              message += `Os horários disponíveis são: ${freshSlots.join(", ")}. Por favor, escolha um novo horário.`;
            } else {
              message += `Por favor, entre em contato conosco para reagendar.`;
            }
          } else {
            message += `Por favor, entre em contato conosco para reagendar.`;
          }

          // Send message via AvanceAI (sendAvanceaiMessage also re-checks ticket status)
          let messageSent = false;
          if (record.avanceai_base_url && record.avanceai_api_id && record.avanceai_bearer_token) {
            messageSent = await sendAvanceaiMessage(
              record.avanceai_base_url,
              record.avanceai_api_id,
              record.avanceai_bearer_token,
              record.phone,
              message,
              record.channel_id
            );
          }

          await admin.from("pending_booking_verifications")
            .update({
              status: "failed",
              attempts: newAttempts,
              last_error: messageSent
                ? "Agendamento não encontrado após verificação. Paciente notificado."
                : "Agendamento não encontrado. Falha ao notificar paciente via WhatsApp.",
            })
            .eq("id", id);
          failed++;
        }
      } else {
        // BUG-1 FIX: gentler backoff on the first 2 attempts to absorb Amigo API propagation latency
        // Sequence: 20s, 65s (cumulative), then 30s * attempt for the rest.
        const backoffSeconds = newAttempts === 1 ? 20 : newAttempts === 2 ? 45 : 30 * newAttempts;
        const nextAttempt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

        await admin.from("pending_booking_verifications")
          .update({
            attempts: newAttempts,
            next_attempt_at: nextAttempt,
            last_error: `Attempt ${newAttempts}: booking not found yet`,
          })
          .eq("id", id);
        retried++;
        console.log(`[VerifyBooking] Retry #${id} scheduled for ${nextAttempt} (attempt ${newAttempts})`);
      }
    }

    console.log(`[VerifyBooking] Done: ${verified} verified, ${retried} retried, ${failed} failed`);
    return new Response(
      JSON.stringify({ processed: pending.length, verified, retried, failed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[VerifyBooking] Fatal error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
