import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Unauthorized" }, 401);
    const userId = user.id;

    const { phone, message, clinic_id, channel_id } = await req.json();
    if (!phone || !message || !clinic_id) {
      return jsonResponse({ error: "phone, message and clinic_id are required" }, 400);
    }

    // Fetch clinic AvanceAI credentials
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: clinic, error: clinicError } = await serviceClient
      .from("clinic_tokens")
      .select("id, avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_enabled, avanceai_active_channel")
      .eq("id", clinic_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (clinicError || !clinic) return jsonResponse({ error: "Clinic not found" }, 404);
    if (!clinic.avanceai_enabled) return jsonResponse({ error: "AvanceAI not enabled for this clinic" }, 400);

    // === STRICT CREDENTIAL RESOLUTION ===
    let useBaseUrl: string | null = null;
    let useApiId: string | null = null;
    let useBearerToken: string | null = null;
    let resolvedChannelId = channel_id || null;

    // Parse channel configs
    let channelConfigs: any[] = [];
    if (clinic.avanceai_active_channel) {
      try {
      const parsed = JSON.parse(clinic.avanceai_active_channel);
        if (Array.isArray(parsed)) channelConfigs = parsed.filter((ch: any) => ch && ch.apiId && ch.enabled !== false);
      } catch { /* ignore */ }
    }

    if (channel_id) {
      // Explicit channel requested — must match a valid enabled channel
      const match = channelConfigs.find((ch: any) => String(ch.id) === String(channel_id));
      if (match) {
        useBaseUrl = match.baseUrl;
        useApiId = match.apiId;
        useBearerToken = match.bearerToken;
        console.log(`[AvanceAI] Using per-channel credentials for channel ${channel_id}`);
      } else {
        return jsonResponse({ error: `Canal ${channel_id} não encontrado nas configurações habilitadas` }, 400);
      }
    } else if (channelConfigs.length === 1) {
      // No explicit channel but single enabled channel → use it
      const ch = channelConfigs[0];
      useBaseUrl = ch.baseUrl;
      useApiId = ch.apiId;
      useBearerToken = ch.bearerToken;
      resolvedChannelId = String(ch.id);
      console.log(`[AvanceAI] Single channel configured, auto-using channel ${ch.id}`);
    } else if (channelConfigs.length > 1) {
      // Multiple channels and no explicit selection → error
      return jsonResponse({ error: "Múltiplos canais habilitados. Selecione um canal específico para enviar." }, 400);
    } else {
      // No channel config → legacy clinic-level creds
      useBaseUrl = clinic.avanceai_base_url;
      useApiId = clinic.avanceai_api_id;
      useBearerToken = clinic.avanceai_bearer_token;
      console.log(`[AvanceAI] Using legacy clinic-level credentials (no per-channel config)`);
    }

    if (!useBaseUrl || !useApiId || !useBearerToken) {
      return jsonResponse({ error: "AvanceAI configuration incomplete" }, 400);
    }

    // Format phone number (Brazilian standard: 55 + DDD + number)
    let formattedPhone = phone.replace(/\D/g, "");
    if (!formattedPhone.startsWith("55")) {
      formattedPhone = "55" + formattedPhone;
    }

    const externalKey = crypto.randomUUID();
    const apiUrl = `${useBaseUrl}/v2/api/external/${useApiId}`;

    console.log("[AvanceAI] Sending message to:", formattedPhone);

    const payload: Record<string, unknown> = {
      body: message,
      number: formattedPhone,
      externalKey,
      isClosed: false,
    };

    // Always send channelId/whatsappId using the resolved channel
    if (resolvedChannelId) {
      payload.channelId = Number(resolvedChannelId);
      payload.whatsappId = Number(resolvedChannelId);
    }

    const avanceResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${useBearerToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!avanceResponse.ok) {
      const errorText = await avanceResponse.text();
      console.error("[AvanceAI] Error:", errorText);
      return jsonResponse({ error: `AvanceAI error: ${avanceResponse.status} - ${errorText}` }, avanceResponse.status);
    }

    const avanceData = await avanceResponse.json();
    console.log("[AvanceAI] Message sent successfully");
    return jsonResponse({ success: true, data: avanceData });
  } catch (e) {
    console.error("[AvanceAI Send] Error:", e);
    return jsonResponse({ error: (e as Error).message || "Internal error" }, 500);
  }
});
