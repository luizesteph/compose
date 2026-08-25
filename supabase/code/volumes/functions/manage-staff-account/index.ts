// manage-staff-account — o DONO cria/destrava a conta de uma atendente SEM email
// de confirmação (pedido 22/07: Mardila presa no "confirme seu email"/reset que
// não chega). Fluxo: card Equipe → "Liberar acesso" → esta função, que valida:
//   1) o chamador é o DONO (clinic_tokens.user_id = auth.uid());
//   2) o email está cadastrado em clinic_staff da clínica dele;
// e então usa a API admin: cria o usuário JÁ CONFIRMADO com a senha dada, ou,
// se já existe, redefine a senha e confirma. Zero emails envolvidos.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "missing_auth" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
    if (userErr || !userData?.user?.id) return json({ error: "invalid_auth" }, 401);
    const callerId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "email_invalido" }, 400);
    if (password.length < 6) return json({ error: "senha_curta_minimo_6" }, 400);

    const admin = createClient(url, service);

    // 1) chamador é DONO de alguma clínica?
    const { data: clinics } = await admin
      .from("clinic_tokens")
      .select("id")
      .eq("user_id", callerId);
    const clinicIds = (clinics || []).map((c: any) => c.id);
    if (clinicIds.length === 0) return json({ error: "apenas_o_dono_pode_liberar_acessos" }, 403);

    // 2) o email é da EQUIPE dele?
    const { data: staff } = await admin
      .from("clinic_staff")
      .select("id")
      .in("clinic_token_id", clinicIds)
      .ilike("email", email)
      .limit(1);
    if (!staff || staff.length === 0) {
      return json({ error: "email_nao_esta_na_equipe_cadastre_no_card_primeiro" }, 403);
    }

    // 3) cria JÁ CONFIRMADO — ou, se já existe, redefine senha + confirma.
    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (!createErr) {
      console.log(`[manage-staff-account] conta CRIADA e confirmada: ${email}`);
      return json({ ok: true, mode: "created" });
    }
    if (!/already|exists|registered/i.test(createErr.message || "")) {
      console.log(`[manage-staff-account] createUser falhou: ${createErr.message}`);
      return json({ error: `criar_conta_falhou: ${createErr.message}` }, 500);
    }

    // Já existe: localizar por email (base pequena — só dono + equipe) e atualizar.
    let targetId: string | null = null;
    for (let page = 1; page <= 5 && !targetId; page++) {
      const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (listErr) return json({ error: `listar_usuarios_falhou: ${listErr.message}` }, 500);
      const hit = (list?.users || []).find((u: any) => String(u.email || "").toLowerCase() === email);
      if (hit) targetId = hit.id;
      if (!list?.users?.length || list.users.length < 200) break;
    }
    if (!targetId) return json({ error: "usuario_existente_nao_encontrado" }, 500);

    const { error: updErr } = await admin.auth.admin.updateUserById(targetId, {
      password,
      email_confirm: true,
    });
    if (updErr) return json({ error: `redefinir_senha_falhou: ${updErr.message}` }, 500);
    console.log(`[manage-staff-account] conta DESTRAVADA (senha redefinida + confirmada): ${email}`);
    return json({ ok: true, mode: "updated" });
  } catch (e) {
    console.error(`[manage-staff-account] fatal: ${(e as Error).message}`);
    return json({ error: (e as Error).message }, 500);
  }
});
