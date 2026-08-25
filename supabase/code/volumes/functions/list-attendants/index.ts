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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const clinicId = url.searchParams.get("clinic_id");
    if (!clinicId) return jsonResponse({ error: "clinic_id is required" }, 400);

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Dono OU atendente vinculada (28/07): a tela de ausências do dia é operada pela
    // própria equipe, então ela precisa enxergar a lista de atendentes. A checagem de
    // vínculo é feita aqui; nenhum segredo da clínica é devolvido — só nome/id/status.
    const { data: clinic } = await serviceClient
      .from("clinic_tokens")
      .select("avanceai_base_url, avanceai_api_id, avanceai_bearer_token, avanceai_enabled, user_id")
      .eq("id", clinicId)
      .maybeSingle();

    if (!clinic) return jsonResponse({ error: "Clinic not found" }, 404);
    if (String(clinic.user_id) !== String(user.id)) {
      const email = String(user.email || "").toLowerCase();
      const { data: vinculo } = await serviceClient
        .from("clinic_staff")
        .select("id")
        .eq("clinic_token_id", clinicId)
        .ilike("email", email)
        .limit(1);
      if (!vinculo || vinculo.length === 0) return jsonResponse({ error: "Clinic not found" }, 404);
    }
    if (!clinic.avanceai_enabled || !clinic.avanceai_base_url || !clinic.avanceai_api_id || !clinic.avanceai_bearer_token) {
      return jsonResponse({ error: "AvanceAI configuration incomplete" }, 400);
    }

    const apiUrl = `${clinic.avanceai_base_url}/v2/api/external/${clinic.avanceai_api_id}/listUsers`;
    const res = await fetch(apiUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${clinic.avanceai_bearer_token}` },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return jsonResponse({ error: `AvanceAI error ${res.status}`, detail: txt.slice(0, 200) }, res.status);
    }

    const data: any = await res.json();
    let users: any[] = [];
    if (Array.isArray(data)) users = data;
    else if (Array.isArray(data?.users)) users = data.users;
    else if (Array.isArray(data?.data)) users = data.data;

    // Return only non-admin attendant names (active + disabled, so UI can show all)
    const attendants = users
      .filter((u) => String(u?.profile || u?.role || "").toLowerCase() !== "admin")
      .map((u) => ({
        id: u?.id,
        name: String(u?.name || "").trim(),
        active: !(u?.active === false || u?.enabled === false || u?.disabled === true || ["disabled", "inactive", "blocked"].includes(String(u?.status || "").toLowerCase())),
        online: u?.online !== false && String(u?.status || "").toLowerCase() !== "offline",
      }))
      .filter((u) => u.name);

    return jsonResponse({ success: true, attendants });
  } catch (e) {
    console.error("[list-attendants] error:", e);
    return jsonResponse({ error: (e as Error).message || "Internal error" }, 500);
  }
});
