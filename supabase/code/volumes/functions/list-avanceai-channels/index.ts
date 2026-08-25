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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const clinicId = url.searchParams.get("clinic_id");
    if (!clinicId) return jsonResponse({ error: "clinic_id is required" }, 400);

    // Fetch clinic AvanceAI credentials
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: clinic, error: clinicError } = await serviceClient
      .from("clinic_tokens")
      .select("avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_enabled")
      .eq("id", clinicId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (clinicError || !clinic) return jsonResponse({ error: "Clinic not found" }, 404);
    if (!clinic.avanceai_enabled) return jsonResponse({ error: "AvanceAI not enabled" }, 400);
    if (!clinic.avanceai_base_url || !clinic.avanceai_api_id || !clinic.avanceai_bearer_token) {
      return jsonResponse({ error: "AvanceAI configuration incomplete" }, 400);
    }

    const apiUrl = `${clinic.avanceai_base_url}/v2/api/external/${clinic.avanceai_api_id}/listChannels`;
    console.log("[AvanceAI] Fetching channels from:", apiUrl);

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${clinic.avanceai_bearer_token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[AvanceAI] Error fetching channels:", errorText);
      return jsonResponse({ error: `AvanceAI error: ${response.status}` }, response.status);
    }

    const result = await response.json();
    const channels = Array.isArray(result) ? result : (result.channels || result.data || []);
    console.log("[AvanceAI] Channels fetched:", JSON.stringify(channels).substring(0, 500));
    return jsonResponse({ success: true, channels });
  } catch (e) {
    console.error("[AvanceAI ListChannels] Error:", e);
    return jsonResponse({ error: (e as Error).message || "Internal error" }, 500);
  }
});
