import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// API URLs to try in order
const API_URLS = [
  "https://amigobot-api.amigoapp.com.br",
  "https://api2.amigoapp.com.br",
  "https://api.amigoapp.com.br",
];

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
): Promise<{ data: unknown; status: number }> {
  for (const baseUrl of API_URLS) {
    try {
      const url = `${baseUrl}/${endpoint}`;
      console.log(`Trying: ${method} ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

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
        console.log(`Success from ${url} - status: ${res.status}`);
        return { data, status: res.status };
      }

      const errorText = await res.text();
      console.log(`Failed ${url} - status: ${res.status} - ${errorText}`);

      // For 404, continue trying next URL (route may exist on another server)
      if (res.status === 404) {
        console.log(`404 on ${url} — trying next URL...`);
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        return { data: { error: errorText, status: res.status }, status: res.status };
      }
    } catch (e) {
      console.log(`Error ${baseUrl}/${endpoint}: ${(e as Error).message}`);
    }
  }
  return { data: { error: "Todas as URLs da API falharam" }, status: 502 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Validate user auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Não autorizado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: claims, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claims?.claims) {
      console.error("Auth error:", claimsError);
      return new Response(
        JSON.stringify({ error: "Token de autenticação inválido" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claims.claims.sub as string;
    console.log(`Authenticated user: ${userId}`);

    // Parse request body
    const { endpoint, method = "GET", body: requestBody, params, clinic_token_id } = await req.json();

    if (!endpoint) {
      return new Response(
        JSON.stringify({ error: "Endpoint é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch the Amigo token - by specific clinic_token_id or fallback to first active
    let tokenQuery = supabase
      .from("clinic_tokens")
      .select("token")
      .eq("user_id", userId)
      .eq("is_active", true);

    if (clinic_token_id) {
      tokenQuery = tokenQuery.eq("id", clinic_token_id);
    }

    tokenQuery = tokenQuery.limit(1);
    const { data: tokenData, error: tokenError } = await tokenQuery.maybeSingle();

    if (tokenError || !tokenData) {
      console.error("Token fetch error:", tokenError);
      return new Response(
        JSON.stringify({ error: "Token do Amigo não configurado. Vá em Configurações para adicionar." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const amigoToken = tokenData.token;

    // Decode the Amigo JWT to extract company_id
    let companyId: string;
    try {
      const payload = decodeJwtPayload(amigoToken);
      companyId = String(payload.company_id);
      console.log(`Company ID from token: ${companyId}`);
    } catch (e) {
      console.error("Failed to decode Amigo token:", (e as Error).message);
      return new Response(
        JSON.stringify({ error: "Token do Amigo inválido. Verifique nas Configurações." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build the full endpoint with company_id
    let fullEndpoint = endpoint;

    const needsCompanyId = [
      "doctors", "insurances", "events", "places",
      "calendar", "patients", "attendances",
    ];

    const baseEndpoint = endpoint.split("?")[0];
    if (needsCompanyId.some((e) => baseEndpoint === e || baseEndpoint.startsWith(e))) {
      const separator = endpoint.includes("?") ? "&" : "?";
      if (!endpoint.includes("company_id")) {
        fullEndpoint = `${endpoint}${separator}company_id=${companyId}`;
      }
    }

    // Merge any extra query params
    if (params && typeof params === "object") {
      for (const [key, value] of Object.entries(params)) {
        const sep = fullEndpoint.includes("?") ? "&" : "?";
        fullEndpoint = `${fullEndpoint}${sep}${key}=${encodeURIComponent(String(value))}`;
      }
    }

    console.log(`Proxying: ${method} ${fullEndpoint}`);

    // Make the API call
    const result = await tryFetch(fullEndpoint, amigoToken, method, requestBody);

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

    return new Response(
      JSON.stringify({ data: responseData, status: result.status }),
      {
        status: result.status >= 200 && result.status < 300 ? 200 : result.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("Proxy error:", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message || "Erro interno do proxy" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
