import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// DE ONDE VEIO O AGENDAMENTO DO SITE (28/08) ─────────────────────────────────
// O link que a Julia manda no WhatsApp carrega
// `?utm_source=julia&utm_medium=whatsapp&utm_campaign=atendimento-ia`, mas o UTM
// morria na página: o widget roda em iframe CROSS-ORIGIN e não enxerga a query
// string de quem o embute. Resultado: todo agendamento do site era
// `booking_source: "widget"`, sem distinguir quem veio de uma conversa da Julia
// de quem achou a página no Google.
//
// Agora a página repassa o UTM no src do iframe e ele chega até aqui.
// Sanitizado de propósito: isto vai para uma coluna do banco e vem da URL, que
// é digitável por qualquer um.
export function origemDoAgendamento(utmSource: unknown): string {
  const bruto = String(utmSource ?? "").toLowerCase().trim();
  const limpo = bruto.replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return limpo ? `widget_${limpo}` : "widget";
}


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const API_URLS = [
  "https://amigobot-api.amigoapp.com.br",
  "https://api2.amigoapp.com.br",
  "https://api.amigoapp.com.br",
];

// Per-request 404 data tracked via tryFetch return value (not global state)

// FAIL-SAFE: returns "open"/"pending"/"closed"/"unknown" — "unknown" blocks send.
async function checkTicketStatusInline(
  baseUrl: string,
  apiId: string,
  bearerToken: string,
  phone: string,
): Promise<string> {
  try {
    const cleanPhone = String(phone).replace(/\D/g, "");
    const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/v2/api/external/${apiId}/showticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ number: fullPhone }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      return (data?.status as string) || "";
    }
  } catch (_) {
    // fail-safe
  }
  return "unknown";
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token JWT inválido");
  let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return JSON.parse(atob(base64));
}

async function tryFetch(
  endpoint: string,
  amigoToken: string,
  method: string = "GET",
  body?: unknown
): Promise<{ data: unknown; status: number; all404Data?: unknown }> {
  let last404Data: unknown = null;
  const isGenericRoute404 = (error: unknown) => {
    const message = String((error as any)?.message || (error as any)?.error || "").toLowerCase();
    return message.includes("route not found") || message.includes("rota não encontrada");
  };
  for (const baseUrl of API_URLS) {
    try {
      const url = `${baseUrl}/${endpoint}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const options: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${amigoToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      };

      if (body && (method === "POST" || method === "PUT")) {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(url, options);
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        return { data, status: res.status };
      }

      const errorText = await res.text();
      let parsedError: unknown;
      try { parsedError = JSON.parse(errorText); } catch { parsedError = { error: errorText }; }

      if (res.status === 404) {
        // Preserve business errors from Amigo (ex: "Convênio não encontrado") over
        // generic fallback-domain "Route Not found" responses, otherwise retry logic
        // cannot see the real rejection reason.
        if (!last404Data || !isGenericRoute404(parsedError)) {
          last404Data = parsedError;
        }
        console.log(`[tryFetch] 404 from ${baseUrl}/${endpoint} body=${errorText.slice(0, 500)}`);
        continue;
      }

      if (res.status >= 400 && res.status < 500) {
        console.log(`[tryFetch] ${res.status} from ${baseUrl}/${endpoint} body=${errorText.slice(0, 500)}`);
        return { data: parsedError, status: res.status };
      }
    } catch (e) {
      console.log(`Error ${baseUrl}/${endpoint}: ${(e as Error).message}`);
    }
  }
  console.log(`[tryFetch] ALL URLs failed for ${endpoint} method=${method} last404=${JSON.stringify(last404Data).slice(0, 500)}`);
  return { data: last404Data || { error: "Todas as URLs da API falharam" }, status: last404Data ? 404 : 502, all404Data: last404Data };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ============================================================================
// canalDeEnvio — o widget mandava TODA confirmação pelo canal DESATIVADO (03/09).
// ============================================================================
// As colunas planas de clinic_tokens (avanceai_api_id etc.) apontam para o canal
// 143, que está com enabled=false. O canal vivo é o 144, e ele só existe dentro
// de avanceai_active_channel. Resultado medido no log: 15 "AvanceAI send failed:
// 400" em 48h — TODA pessoa que agendou pelo site da clínica ficou sem a
// confirmação no WhatsApp, embora a consulta tenha sido criada no Amigo.
//
// A mesma lição já tinha custado a Fase 2 do human-transfer-timeout (19/07 e
// 30/08). Filtra por enabled explicitamente: o parseChannels do transfer-ticket
// pega o primeiro da lista e só acerta por causa da ordem atual do array.
function canalDeEnvio(
  clinic: Record<string, unknown> | null | undefined,
): { baseUrl: string; apiId: string; bearerToken: string } | null {
  if (!clinic) return null;
  const planoBase = String(clinic.avanceai_base_url || "");
  const planoToken = String(clinic.avanceai_bearer_token || "");
  try {
    const bruto = clinic.avanceai_active_channel;
    const lista = typeof bruto === "string" ? JSON.parse(bruto) : bruto;
    if (Array.isArray(lista)) {
      const vivo = lista.find(
        (c: Record<string, unknown>) => c && c.apiId && c.enabled !== false && c.enabled !== "false",
      );
      if (vivo) {
        const baseUrl = String((vivo as Record<string, unknown>).baseUrl || planoBase);
        const apiId = String((vivo as Record<string, unknown>).apiId);
        const bearerToken = String((vivo as Record<string, unknown>).bearerToken || planoToken);
        if (baseUrl && apiId && bearerToken) return { baseUrl, apiId, bearerToken };
      }
    }
  } catch {
    /* cai no plano abaixo */
  }
  const apiId = String(clinic.avanceai_api_id || "");
  if (planoBase && apiId && planoToken) {
    return { baseUrl: planoBase, apiId, bearerToken: planoToken };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const widgetKey = url.searchParams.get("key");
    const action = url.searchParams.get("action");

    if (!widgetKey || !action) {
      return jsonResponse({ error: "Parâmetros 'key' e 'action' são obrigatórios" }, 400);
    }

    // Use service role to look up widget + clinic token
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: widget, error: widgetError } = await supabase
      .from("booking_widgets")
      .select("*, clinic_tokens(token, clinic_name, user_id, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_active_channel)")
      .eq("widget_key", widgetKey)
      .eq("is_active", true)
      .maybeSingle();

    if (widgetError || !widget) {
      return jsonResponse({ error: "Widget não encontrado ou inativo" }, 404);
    }

    const amigoToken = widget.clinic_tokens?.token;
    if (!amigoToken) {
      return jsonResponse({ error: "Token da clínica não configurado" }, 500);
    }

    let companyId: string;
    try {
      const payload = decodeJwtPayload(amigoToken);
      companyId = String(payload.company_id);
    } catch {
      return jsonResponse({ error: "Token da clínica inválido" }, 500);
    }

    let result: { data: unknown; status: number };

    switch (action) {
      case "style": {
        // Return widget style config (no Amigo API call needed)
        return jsonResponse({
          data: {
            primary_color: widget.primary_color,
            secondary_color: widget.secondary_color,
            background_color: widget.background_color,
            font_family: widget.font_family,
            border_radius: widget.border_radius,
            opacity: widget.opacity,
            style_mode: widget.style_mode,
          },
          status: 200,
        });
      }
      case "doctors": {
        result = await tryFetch(`doctors?company_id=${companyId}`, amigoToken);
        break;
      }
      case "events": {
        result = await tryFetch(`events?company_id=${companyId}`, amigoToken);
        break;
      }
      case "places": {
        result = await tryFetch(`places?company_id=${companyId}`, amigoToken);
        break;
      }
      case "insurances": {
        result = await tryFetch(`insurances?company_id=${companyId}`, amigoToken);
        break;
      }
      case "calendar": {
        const placeId = url.searchParams.get("place_id");
        const eventId = url.searchParams.get("event_id");
        if (!placeId || !eventId) {
          return jsonResponse({ error: "place_id e event_id são obrigatórios" }, 400);
        }
        result = await tryFetch(
          `calendar?company_id=${companyId}&place_id=${placeId}&event_id=${eventId}`,
          amigoToken
        );
        break;
      }
      case "search_patient": {
        const cpf = url.searchParams.get("cpf");
        if (!cpf) {
          return jsonResponse({ error: "cpf é obrigatório" }, 400);
        }
        console.log(`[BookingWidget] search_patient: cpf=${cpf}, company_id=${companyId}`);
        result = await tryFetch(
          `patients/exists?company_id=${companyId}&cpf=${encodeURIComponent(cpf)}`,
          amigoToken
        );
        console.log(`[BookingWidget] search_patient result: status=${result.status}, data=${JSON.stringify(result.data).substring(0, 1000)}`);
        // If all URLs returned 404 (patient not found), return 200 with found:false
        if (result.status === 502 && result.all404Data) {
          console.log(`[BookingWidget] All URLs returned 404 for CPF, treating as not found`);
          result = { data: { found: false, data: null }, status: 200 };
        }
        // Return early WITHOUT normalization — frontend handles all formats.
        // BUT: try to enrich with full patient record so we have insurance_id/name (patients/exists doesn't return convênio).
        if (result.status >= 200 && result.status < 300) {
          try {
            // Extract patient id from any common shape
            const extractId = (obj: unknown): string | null => {
              if (!obj || typeof obj !== "object") return null;
              const o = obj as Record<string, unknown>;
              if (o.id) return String(o.id);
              if (o.patient_id) return String(o.patient_id);
              if (o.data && typeof o.data === "object") {
                const inner: any = o.data;
                if (Array.isArray(inner) && inner.length > 0) return extractId(inner[0]);
                return extractId(inner);
              }
              if (o.patient && typeof o.patient === "object") return extractId(o.patient);
              return null;
            };
            const pid = extractId(result.data);
            if (pid) {
              const fullRes = await tryFetch(`patients/${pid}?company_id=${companyId}`, amigoToken);
              if (fullRes.status >= 200 && fullRes.status < 300 && fullRes.data) {
                let fullPatient: any = fullRes.data;
                if (fullPatient && typeof fullPatient === "object" && "data" in fullPatient) fullPatient = (fullPatient as any).data;
                if (Array.isArray(fullPatient)) fullPatient = fullPatient[0];
                if (fullPatient && typeof fullPatient === "object") {
                  console.log(`[BookingWidget] search_patient enriched: insurance_id=${(fullPatient as any).insurance_id || "none"}, name=${(fullPatient as any).insurance?.name || (fullPatient as any).insurance_name || "none"}`);
                  return jsonResponse({ data: fullPatient, status: result.status });
                }
              } else {
                console.log(`[BookingWidget] search_patient enrichment failed (status ${fullRes.status}) — returning exists payload as-is`);
              }
            }
          } catch (enrichErr) {
            console.log(`[BookingWidget] search_patient enrichment error: ${(enrichErr as Error).message}`);
          }
          return jsonResponse({ data: result.data, status: result.status });
        }
        // TRANSIENT (bug 01/07): instabilidade do Amigo (5xx/502 apos retries) virava
        // found:false e o paciente com CPF CORRETO caia no formulario de RECADASTRO.
        // Distingue: transiente -> 503 com mensagem de retry (frontend exibe e o
        // paciente tenta de novo); nao-encontrado genuino (2xx vazio/404/4xx) segue
        // com found:false para o fluxo de cadastro.
        if (result.status >= 500) {
          console.log(`[BookingWidget] search_patient TRANSIENT failure (status ${result.status}) — returning 503 retry`);
          return jsonResponse(
            { error: "Sistema momentaneamente instável. Aguarde alguns segundos e tente de novo. 🙏", transient: true },
            503,
          );
        }
        // On error, also return early with found:false so frontend doesn't throw
        return jsonResponse({ data: { found: false, data: null }, status: result.status, error: "Paciente não encontrado" });
      }
      case "create_attendance": {
        if (req.method !== "POST") {
          return jsonResponse({ error: "Método POST necessário" }, 405);
        }
        const attendanceBody = await req.json();

        // Extract WhatsApp confirmation fields (not sent to Amigo API)
        const patientPhone = attendanceBody.patient_phone;
        const patientName = attendanceBody.patient_name;
        const doctorName = attendanceBody.doctor_name;
        // UTM da página que embute o widget — só para atribuição, NUNCA vai para
        // o Amigo (por isso o delete, igual aos outros campos de uso interno).
        const _utmWidget =
          attendanceBody.utm && typeof attendanceBody.utm === "object" ? attendanceBody.utm : null;
        const _origemWidget = origemDoAgendamento(_utmWidget?.source);
        delete attendanceBody.patient_phone;
        delete attendanceBody.patient_name;
        delete attendanceBody.doctor_name;
        delete attendanceBody.utm;

        // Só id numérico vale como convênio. O <Select> do formulário usa value="none"
        // para "Particular", e esse texto chegava aqui como insurance_id.
        if (attendanceBody.insurance_id && !/^\d+$/.test(String(attendanceBody.insurance_id).trim())) {
          console.log(`[BookingWidget] create_attendance: insurance_id "${attendanceBody.insurance_id}" não é numérico — removido`);
          delete attendanceBody.insurance_id;
        }

        // BILLING FIX: if frontend didn't send insurance_id but patient has one in Amigo, auto-resolve.
        if (!attendanceBody.insurance_id && attendanceBody.patient_id) {
          try {
            const fullRes = await tryFetch(`patients/${attendanceBody.patient_id}?company_id=${companyId}`, amigoToken);
            if (fullRes.status >= 200 && fullRes.status < 300 && fullRes.data) {
              let fp: any = fullRes.data;
              if (fp && typeof fp === "object" && "data" in fp) fp = (fp as any).data;
              if (Array.isArray(fp)) fp = fp[0];
              // Lê tolerando o formato do cadastro (insurance_id, insurance.id,
              // convenio_id…). Ler só `insurance_id` é o que fez 84% dos
              // agendamentos do WhatsApp saírem como particular.
              const numOk = (v: unknown) =>
                (typeof v === "number" && Number.isFinite(v) && v > 0) ||
                (typeof v === "string" && /^\d+$/.test(v.trim()) && Number(v) > 0);
              let insId: unknown = null;
              for (const k of ["insurance_id", "insurance_plan_id", "health_insurance_id", "convenio_id", "plan_id"]) {
                if (numOk(fp?.[k])) { insId = fp[k]; break; }
              }
              if (!insId) {
                for (const k of ["insurance", "insurance_plan", "health_insurance", "convenio", "plan"]) {
                  const nested = fp?.[k];
                  if (nested && typeof nested === "object" && numOk((nested as any).id)) {
                    insId = (nested as any).id;
                    break;
                  }
                }
              }
              if (insId) {
                attendanceBody.insurance_id = Number(insId);
                console.log(`[BookingWidget] create_attendance auto-resolved insurance_id=${insId} for patient ${attendanceBody.patient_id}`);
              } else {
                console.log(`[BookingWidget] create_attendance: patient ${attendanceBody.patient_id} has no insurance — booking as particular`);
              }
            }
          } catch (insErr) {
            console.log(`[BookingWidget] create_attendance insurance lookup error (non-blocking): ${(insErr as Error).message}`);
          }
        }

        console.log(`[BookingWidget] create_attendance received: phone=${patientPhone}, name=${patientName}, doctor=${doctorName}, insurance_id=${attendanceBody.insurance_id || "none"}`);

        // CARÊNCIA DE CONVÊNIO REMOVIDA DE VEZ (16/08). Decisão do dono, textual:
        // "vamos tirar essa regra de carência do convênio. Não quero que funcione
        // mais nada." Aqui vivia o bloqueio do widget, que recusava a marcação NA
        // CONFIRMAÇÃO com "as datas disponíveis começam a partir de DD/MM" — sem
        // poder explicar o motivo, porque o pedido original era nunca contar ao
        // paciente que existe carência. O widget agora aceita qualquer data que a
        // agenda do Amigo ofereça. Ver a nota longa em whatsapp-webhook/index.ts.

        // FERIADOS/DIAS FECHADOS (10/07): não deixar marcar PARA um dia em que a
        // clínica estará fechada (feriado/emenda), mesmo com agenda aberta no Amigo.
        if (attendanceBody.start_date && widget.clinic_token_id) {
          try {
            const _sdStr = String(attendanceBody.start_date);
            const _targetDate = (_sdStr.split("T")[0] || _sdStr.split(" ")[0] || "").trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(_targetDate)) {
              const { data: _closedRow } = await supabase
                .from("clinic_closed_days")
                .select("closed_date, reason")
                .eq("clinic_token_id", widget.clinic_token_id)
                .eq("closed_date", _targetDate)
                .maybeSingle();
              if (_closedRow) {
                console.log(`[BookingWidget] create_attendance BLOQUEADO: ${_targetDate} é dia fechado (${(_closedRow as any).reason || "feriado"})`);
                return jsonResponse(
                  { error: `A clínica estará fechada nesse dia (${(_closedRow as any).reason || "feriado"}). Por favor, escolha outra data. 🙏` },
                  400,
                );
              }
            }
          } catch (cdErr) {
            console.log(`[BookingWidget] closed-day check error (non-blocking): ${(cdErr as Error).message}`);
          }
        }

        // DUPLICATE GUARD: block if patient already has an active future attendance on the same day.
        // Frontend should have intercepted via the reschedule dialog; this is a server-side fail-safe.
        if (attendanceBody.patient_id && attendanceBody.start_date && !attendanceBody.allow_duplicate) {
          try {
            const startStr = String(attendanceBody.start_date);
            const newDate = (startStr.split("T")[0] || startStr.split(" ")[0] || "").trim();
            const dupRes = await tryFetch(
              `attendances/${attendanceBody.patient_id}?company_id=${companyId}`,
              amigoToken
            );
            let listData: any = dupRes.data;
            if (listData && typeof listData === "object" && "data" in listData) listData = (listData as any).data;
            const list: any[] = Array.isArray(listData) ? listData : [];
            const conflicts = list.filter((att: any) => {
              const status = String(att.status || att.attendance_status || "").toLowerCase();
              if (["cancelled", "canceled", "cancelado"].includes(status)) return false;
              const raw = String(att.start_date || att.date || "");
              const cleaned = raw.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
              const datePart = (cleaned.split("T")[0] || cleaned.split(" ")[0] || "").trim();
              return datePart === newDate;
            });
            if (conflicts.length > 0) {
              console.log(`[BookingWidget] create_attendance BLOCKED — duplicate on ${newDate} (${conflicts.length} existing)`);
              return jsonResponse(
                {
                  error: "duplicate_booking",
                  message: `Paciente já possui ${conflicts.length} consulta(s) ativa(s) em ${newDate}.`,
                  existing: conflicts,
                },
                409
              );
            }
          } catch (dupErr) {
            console.log(`[BookingWidget] duplicate-check error (non-blocking): ${(dupErr as Error).message}`);
          }
        }
        delete attendanceBody.allow_duplicate;

        result = await tryFetch(
          `attendances?company_id=${companyId}`,
          amigoToken,
          "POST",
          attendanceBody
        );

        // RETRY: API rejected insurance_id ("Convênio não encontrado"). Fall back to particular.
        const errBody: any = result.data;
        const insuranceRejected =
          result.status >= 400 &&
          attendanceBody.insurance_id &&
          (errBody?.code === "001" ||
            String(errBody?.message || "").toLowerCase().includes("convênio") ||
            String(errBody?.message || "").toLowerCase().includes("convenio"));
        if (insuranceRejected) {
          console.log(`[BookingWidget] Insurance ${attendanceBody.insurance_id} rejected by API — retrying as particular`);
          const retryBody = { ...attendanceBody };
          delete retryBody.insurance_id;
          result = await tryFetch(
            `attendances?company_id=${companyId}`,
            amigoToken,
            "POST",
            retryBody
          );
        }


        // Log widget booking in webhook_messages for tracking
        if (result.status >= 200 && result.status < 300) {
          try {
            const startDate = attendanceBody.start_date || "";

            // Lookup conversation_id by phone suffix (last 8 digits) within this clinic
            let resolvedConversationId: string | null = null;
            if (patientPhone && widget.clinic_token_id) {
              try {
                const cleanWidgetPhone = String(patientPhone).replace(/\D/g, "");
                const suffix = cleanWidgetPhone.slice(-8);
                if (suffix.length === 8) {
                  const { data: convs } = await supabase
                    .from("chat_conversations")
                    .select("id, phone, last_message_at")
                    .eq("clinic_token_id", widget.clinic_token_id)
                    .order("last_message_at", { ascending: false })
                    .limit(500);
                  const match = (convs ?? []).find((c: any) =>
                    String(c.phone || "").replace(/\D/g, "").endsWith(suffix)
                  );
                  if (match) resolvedConversationId = match.id;
                }
              } catch (lookupErr) {
                console.log(`[BookingWidget] conversation_id lookup failed: ${(lookupErr as Error).message}`);
              }
            }

            // Convite de lista de espera (auditoria 10/07): o widget é o canal
            // PRINCIPAL de agendamento e nunca convidava. Se a consulta ficou a 7+
            // dias, grava o contexto do convite (waitlist_invite) — é dele que a
            // keyword "lista de espera" no WhatsApp recupera o médico.
            let _wlInviteCtx: Record<string, unknown> | null = null;
            try {
              const _bookedISO = String(startDate).split(" ")[0].split("T")[0];
              const _todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
              if (/^\d{4}-\d{2}-\d{2}$/.test(_bookedISO) && _bookedISO >= _todayISO) {
                const _days = Math.round(
                  (Date.parse(_bookedISO + "T12:00:00Z") - Date.parse(_todayISO + "T12:00:00Z")) / 86400000,
                );
                const _docId = attendanceBody.user_id ?? attendanceBody.doctor_id;
                if (_days >= 7 && _docId) {
                  _wlInviteCtx = {
                    doctor_id: String(_docId),
                    doctor_name: doctorName || "",
                    booked_date: _bookedISO,
                  };
                }
              }
            } catch (wlErr) {
              console.log(`[BookingWidget] waitlist invite calc error (non-blocking): ${(wlErr as Error).message}`);
            }

            await supabase.from("webhook_messages").insert({
              clinic_token_id: widget.clinic_token_id,
              user_id: widget.clinic_tokens?.user_id || null,
              conversation_id: resolvedConversationId,
              sender_phone: patientPhone || null,
              sender_name: patientName || null,
              message_text: `Agendamento via widget: ${patientName || "Paciente"} com ${doctorName || "médico"} em ${startDate}`,
              direction: "incoming",
              ai_intent: "agendar",
              action_status: "success",
              booking_source: _origemWidget,
              ai_entities: {
                doctor_name: doctorName || null,
                start_date: startDate,
                source: _origemWidget,
                ...(_utmWidget ? { utm: _utmWidget } : {}),
                ...(_wlInviteCtx ? { waitlist_invite: _wlInviteCtx } : {}),
              },
            });
            if (_wlInviteCtx) (attendanceBody as any).__waitlist_invite = _wlInviteCtx;
            console.log(`[BookingWidget] Widget booking logged in webhook_messages (conv=${resolvedConversationId ?? "none"})`);
          } catch (logErr) {
            console.log(`[BookingWidget] Failed to log widget booking: ${(logErr as Error).message}`);
          }
        }

        // Send WhatsApp confirmation if attendance was created successfully
        if (result.status >= 200 && result.status < 300 && !patientPhone) {
          console.log("[BookingWidget] Attendance created but no patient phone provided, skipping WhatsApp");
        }
        if (result.status >= 200 && result.status < 300 && patientPhone) {
          try {
            const clinicName = widget.clinic_tokens?.clinic_name || "Clínica";
            const _canal = canalDeEnvio(widget.clinic_tokens as Record<string, unknown>);
            const avanceaiBaseUrl = _canal?.baseUrl;
            const avanceaiApiId = _canal?.apiId;
            const avanceaiBearerToken = _canal?.bearerToken;

            if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken) {
              // Parse date/time from start_date (format: "yyyy-MM-dd HH:mm")
              const startDate2 = attendanceBody.start_date || "";
              const [datePart, timePart] = startDate2.split(" ");
              let formattedDate = datePart;
              let formattedTime = timePart || "";
              if (datePart) {
                const [y, m, d] = datePart.split("-");
                if (y && m && d) formattedDate = `${d}/${m}/${y}`;
              }

              // Convite de lista de espera anexado quando a consulta ficou a 7+ dias
              // (calculado no log acima) — responder "lista de espera" cai no webhook.
              const _wlSuffix = (attendanceBody as any).__waitlist_invite
                ? `\n\n💡 Como sua consulta ficou um pouco distante, se quiser eu te coloco na *lista de espera*: se abrir uma vaga antes com ${doctorName || "o médico"}, te aviso por aqui e a gente antecipa. É só responder *lista de espera*.`
                : "";
              const message = `Olá, ${patientName || "paciente"}! Sua consulta foi agendada com sucesso.\n\nClínica: ${clinicName}\nMédico(a): ${doctorName || "N/A"}\nData: ${formattedDate}\nHorário: ${formattedTime}${_wlSuffix}\n\nEm caso de dúvidas, entre em contato conosco. Obrigado!`;

              // Clean phone number
              const cleanPhone = String(patientPhone).replace(/\D/g, "");
              const fullPhone = cleanPhone.length <= 11 ? `55${cleanPhone}` : cleanPhone;

              const sendCtrl = new AbortController();
              const sendTimeout = setTimeout(() => sendCtrl.abort(), 10000);
              const res = await fetch(`${avanceaiBaseUrl}/v2/api/external/${avanceaiApiId}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${avanceaiBearerToken}`,
                },
                body: JSON.stringify({ number: fullPhone, body: message, externalKey: crypto.randomUUID(), isClosed: false }),
                signal: sendCtrl.signal,
              }).finally(() => clearTimeout(sendTimeout));

              if (res.ok) {
                console.log(`[BookingWidget] WhatsApp confirmation sent to ${fullPhone} via AvanceAI`);
              } else {
                console.log(`[BookingWidget] AvanceAI send failed: ${res.status}`);
              }
            } else {
              console.log("[BookingWidget] No AvanceAI configured, skipping WhatsApp");
            }
          } catch (e) {
            console.log(`[BookingWidget] WhatsApp confirmation error: ${(e as Error).message}`);
          }
        }

        // === MENSAGEM 2 — Júlia confirma o agendamento (só se conversa veio do WhatsApp) ===
        // Non-blocking: runs in background so the HTTP response returns immediately to the patient
        if (result.status >= 200 && result.status < 300 && patientPhone) {
          const _msg2ClinicTokenId = widget.clinic_token_id;
          const _msg2UserId = widget.clinic_tokens?.user_id || null;
          const _msg2Phone = patientPhone;
          const _msg2PatientName = patientName;
          const _msg2DoctorName = doctorName;
          const _msg2StartDate = attendanceBody.start_date || "";
          const _msg2Canal = canalDeEnvio(widget.clinic_tokens as Record<string, unknown>);
          const _msg2AvanceaiBaseUrl = _msg2Canal?.baseUrl;
          const _msg2AvanceaiApiId = _msg2Canal?.apiId;
          const _msg2AvanceaiBearerToken = _msg2Canal?.bearerToken;
          // Wrap in EdgeRuntime.waitUntil so the 30s sleep + send is not killed when
          // the runtime returns the HTTP response. Falls back to plain IIFE on local dev.
          const _msg2Job = (async () => {
          try {
            const avanceaiBaseUrl = _msg2AvanceaiBaseUrl;
            const avanceaiApiId = _msg2AvanceaiApiId;
            const avanceaiBearerToken = _msg2AvanceaiBearerToken;

            if (avanceaiBaseUrl && avanceaiApiId && avanceaiBearerToken) {
              const cleanPhoneForLookup = String(_msg2Phone).replace(/\D/g, "");
              const phoneSuffix = cleanPhoneForLookup.slice(-8);

              // 1. Júlia mandou widget_link nas últimas 2h? (match por sufixo de 8 dígitos)
              const cutoff2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
              let linkSentMsg: any = null;
              if (phoneSuffix.length === 8) {
                const { data: candidates } = await supabase
                  .from("webhook_messages")
                  .select("id, created_at, sender_phone")
                  .eq("clinic_token_id", _msg2ClinicTokenId)
                  .eq("direction", "outgoing")
                  .eq("ai_intent", "widget_link_sent")
                  .gte("created_at", cutoff2h)
                  .order("created_at", { ascending: false })
                  .limit(50);
                linkSentMsg = (candidates ?? []).find((m: any) =>
                  String(m.sender_phone || "").replace(/\D/g, "").endsWith(phoneSuffix)
                ) || null;
              }

              if (!linkSentMsg) {
                console.log("[BookingWidget] Mensagem 2 skip: nenhum widget_link enviado nas últimas 2h (paciente agendou direto pelo site)");
              } else {
                // 2. Aguardar 30s para vir DEPOIS da confirmação automática
                await new Promise((resolve) => setTimeout(resolve, 30000));

                // 3. Re-checar status do ticket
                const ticketStatus = await checkTicketStatusInline(
                  avanceaiBaseUrl, avanceaiApiId, avanceaiBearerToken, _msg2Phone
                );
                if (ticketStatus === "open" || ticketStatus === "unknown") {
                  console.log(`[BookingWidget] Mensagem 2 skip: ticket="${ticketStatus}"`);
                } else {
                  // 4. Montar e enviar
                  const startDate3 = _msg2StartDate;
                  const [datePart3, timePart3] = startDate3.split(" ");
                  const formattedTime3 = timePart3 || "";
                  const [y3, m3, d3] = (datePart3 || "").split("-");
                  const dataFormatada = (y3 && m3 && d3) ? `${d3}/${m3}` : datePart3;
                  const firstName = String(_msg2PatientName || "").split(" ")[0] || "";
                  const greeting = firstName ? `${firstName}, vi` : "Vi";

                  const msg2 =
                    `${greeting} aqui que você acabou de agendar com ${_msg2DoctorName || "o médico"} ` +
                    `para ${dataFormatada} às ${formattedTime3} ✅\n\n` +
                    `Que bom que deu tudo certo! Se surgir qualquer dúvida antes da consulta — sobre exames, ` +
                    `documentos, convênio, localização — é só me chamar por aqui que te ajudo. 😊`;

                  const cleanPhone2 = String(_msg2Phone).replace(/\D/g, "");
                  const fullPhone2 = cleanPhone2.length <= 11 ? `55${cleanPhone2}` : cleanPhone2;
                  const send2Ctrl = new AbortController();
                  const send2Timeout = setTimeout(() => send2Ctrl.abort(), 10000);
                  const send2Res = await fetch(`${avanceaiBaseUrl}/v2/api/external/${avanceaiApiId}`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${avanceaiBearerToken}`,
                    },
                    body: JSON.stringify({
                      number: fullPhone2,
                      body: msg2,
                      externalKey: crypto.randomUUID(),
                      isClosed: false,
                    }),
                    signal: send2Ctrl.signal,
                  }).finally(() => clearTimeout(send2Timeout));

                  if (send2Res.ok) {
                    await supabase.from("webhook_messages").insert({
                      clinic_token_id: _msg2ClinicTokenId,
                      user_id: _msg2UserId,
                      sender_phone: _msg2Phone,
                      sender_name: _msg2PatientName,
                      message_text: msg2,
                      direction: "outgoing",
                      ai_intent: "post_widget_booking_confirmation",
                      action_status: "success",
                      booking_source: "whatsapp",
                    });
                    console.log(`[BookingWidget] Mensagem 2 (Júlia confirmação calorosa) enviada para ${fullPhone2}`);

                    // 5. CANCELAR follow-up de 15min (paciente já agendou) — match por sufixo
                    if (phoneSuffix.length === 8) {
                      const { data: pendingRows } = await supabase
                        .from("pending_followups")
                        .select("id, phone")
                        .eq("clinic_token_id", _msg2ClinicTokenId)
                        .eq("type", "widget_link")
                        .eq("status", "pending")
                        .limit(200);
                      const idsToCancel = (pendingRows ?? [])
                        .filter((r: any) => String(r.phone || "").replace(/\D/g, "").endsWith(phoneSuffix))
                        .map((r: any) => r.id);
                      if (idsToCancel.length > 0) {
                        await supabase
                          .from("pending_followups")
                          .update({
                            status: "cancelled",
                            cancelled_reason: "patient_booked_via_widget",
                            processed_at: new Date().toISOString(),
                          })
                          .in("id", idsToCancel);
                      }
                    }
                  } else {
                    console.log(`[BookingWidget] Mensagem 2 envio falhou: HTTP ${send2Res.status}`);
                  }
                }
              }
            }
          } catch (msg2Err) {
            console.log(`[BookingWidget] Mensagem 2 error (non-blocking): ${(msg2Err as Error).message}`);
          }
          })();
          try { (globalThis as any).EdgeRuntime?.waitUntil?.(_msg2Job); } catch { /* not available — IIFE still runs */ }
        }
        break;
      }
      case "create_patient": {
        if (req.method !== "POST") {
          return jsonResponse({ error: "Método POST necessário" }, 405);
        }
        const patientBody = await req.json();

        // Resolve insurance plan ID if insurance_id is a group ID
        if (patientBody.insurance_id && patientBody.insurance_id !== "none") {
          try {
            const plansResult = await tryFetch(
              `insurances/plans/${patientBody.insurance_id}?company_id=${companyId}`,
              amigoToken
            );
            if (plansResult.status >= 200 && plansResult.status < 300) {
              const plansData = plansResult.data;
              let plans: unknown[] = [];
              if (Array.isArray(plansData)) {
                plans = plansData;
              } else if (plansData && typeof plansData === "object" && "data" in (plansData as Record<string, unknown>)) {
                const inner = (plansData as Record<string, unknown>).data;
                if (Array.isArray(inner)) plans = inner;
              }
              if (plans.length > 0) {
                const plan = plans[0] as Record<string, unknown>;
                patientBody.insurance_id = plan.id;
              }
            }
          } catch (e) {
            console.log(`Failed to resolve insurance plan: ${(e as Error).message}`);
          }
        } else {
          delete patientBody.insurance_id;
        }

        result = await tryFetch(
          `patients?company_id=${companyId}`,
          amigoToken,
          "POST",
          patientBody
        );
        break;
      }
      case "patient_attendances": {
        const patientId = url.searchParams.get("patient_id");
        if (!patientId) {
          return jsonResponse({ error: "patient_id é obrigatório" }, 400);
        }
        result = await tryFetch(
          `attendances/${patientId}?company_id=${companyId}`,
          amigoToken
        );
        break;
      }
      case "cancel_attendance": {
        const cancelId = url.searchParams.get("attendance_id");
        if (!cancelId) {
          return jsonResponse({ error: "attendance_id é obrigatório" }, 400);
        }
        console.log(`[BookingWidget] cancel_attendance: id=${cancelId}`);
        result = await tryFetch(
          `attendances/cancel/${cancelId}?company_id=${companyId}`,
          amigoToken,
          "PUT"
        );
        console.log(`[BookingWidget] cancel_attendance result: status=${result.status}, data=${JSON.stringify(result.data)}`);
        break;
      }
      case "reschedule_attendance": {
        if (req.method !== "POST") {
          return jsonResponse({ error: "Método POST necessário" }, 405);
        }
        const rescheduleId = url.searchParams.get("attendance_id");
        if (!rescheduleId) {
          return jsonResponse({ error: "attendance_id é obrigatório" }, 400);
        }
        const rescheduleBody = await req.json();
        console.log(`[BookingWidget] reschedule_attendance: id=${rescheduleId}, body=${JSON.stringify(rescheduleBody)}`);
        result = await tryFetch(
          `attendances/${rescheduleId}/reschedule?company_id=${companyId}`,
          amigoToken,
          "PUT",
          rescheduleBody
        );
        console.log(`[BookingWidget] reschedule_attendance result: status=${result.status}, data=${JSON.stringify(result.data)}`);
        break;
      }
      default:
        return jsonResponse({ error: `Ação '${action}' não suportada` }, 400);
    }

    // Normalize response
    let responseData = result.data;
    if (result.status >= 200 && result.status < 300) {
      if (responseData && typeof responseData === "object" && !Array.isArray(responseData)) {
        const obj = responseData as Record<string, unknown>;
        if ("data" in obj) {
          responseData = obj.data;
        }
      }
    }

    return jsonResponse(
      { data: responseData, status: result.status },
      result.status >= 200 && result.status < 300 ? 200 : result.status
    );
  } catch (e) {
    console.error("Booking widget error:", e);
    return jsonResponse({ error: (e as Error).message || "Erro interno" }, 500);
  }
});
