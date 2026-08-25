import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Authenticate cron requests via shared secret
  const cronSecret = req.headers.get("x-cron-secret");
  if (!cronSecret || cronSecret !== Deno.env.get("CRON_SECRET")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Fetch pending resolutions that are due
    const { data: pending, error: fetchErr } = await supabase
      .from("pending_ticket_resolutions")
      .select("*")
      .eq("status", "pending")
      .lte("execute_at", new Date().toISOString())
      .limit(20);

    if (fetchErr) {
      console.error("[resolve-ticket] Error fetching pending:", fetchErr);
      return new Response(JSON.stringify({ error: fetchErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pending || pending.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[resolve-ticket] Processing ${pending.length} pending resolutions`);

    let processed = 0;
    let failed = 0;

    for (const record of pending) {
      try {
        // Step 1: Find ticket by phone number using Z-PRO showticket API (v2)
        const phone = record.phone.replace(/\D/g, "");
        // Try with and without country code
        const phoneVariants = [phone, phone.startsWith("55") ? phone.slice(2) : `55${phone}`];
        
        let ticketId: string | null = null;

        for (const phoneVariant of phoneVariants) {
          try {
            const showTicketUrl = `${record.base_url}/v2/api/external/${record.api_id}/showticket`;
            console.log(`[resolve-ticket] Looking up ticket for phone: ${phoneVariant}`);
            
            const ticketRes = await fetch(showTicketUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${record.bearer_token}`,
              },
              body: JSON.stringify({
                number: phoneVariant,
                ...(record.channel_id ? { whatsappId: parseInt(record.channel_id, 10) } : {}),
              }),
            });

            if (ticketRes.ok) {
              const ticketData = await ticketRes.json();
              // Z-PRO returns ticket data - extract ID
              const ticket = ticketData?.ticket || ticketData;
              if (ticket?.id) {
                ticketId = String(ticket.id);
                console.log(`[resolve-ticket] Found ticket ID: ${ticketId} for phone ${phoneVariant}`);
                break;
              }
              // Sometimes returns array
              if (Array.isArray(ticketData) && ticketData.length > 0) {
                // Get the most recent open ticket
                const openTicket = ticketData.find((t: any) => t.status === "open" || t.status === "pending") || ticketData[0];
                ticketId = String(openTicket.id);
                console.log(`[resolve-ticket] Found ticket ID from array: ${ticketId}`);
                break;
              }
            } else {
              const errText = await ticketRes.text();
              console.log(`[resolve-ticket] showticket failed for ${phoneVariant}: ${ticketRes.status} - ${errText}`);
            }
          } catch (e) {
            console.log(`[resolve-ticket] Error looking up ticket for ${phoneVariant}: ${(e as Error).message}`);
          }
        }

        if (!ticketId) {
          console.log(`[resolve-ticket] No ticket found for phone ${phone}, marking as failed`);
          await supabase
            .from("pending_ticket_resolutions")
            .update({ status: "failed", error_message: "Ticket não encontrado" })
            .eq("id", record.id);
          failed++;
          continue;
        }

        // Step 2: Close the ticket using updateticketinfo (v2 POST)
        const updateUrl = `${record.base_url}/v2/api/external/${record.api_id}/updateticketinfo`;
        console.log(`[resolve-ticket] Closing ticket ${ticketId}`);

        const updateRes = await fetch(updateUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${record.bearer_token}`,
          },
          body: JSON.stringify({ ticketId: Number(ticketId), status: "closed" }),
        });

        if (updateRes.ok) {
          console.log(`[resolve-ticket] Ticket ${ticketId} closed successfully`);
          await supabase
            .from("pending_ticket_resolutions")
            .update({ status: "done" })
            .eq("id", record.id);
          processed++;
        } else {
          const errText = await updateRes.text();
          console.error(`[resolve-ticket] Failed to close ticket ${ticketId}: ${updateRes.status} - ${errText}`);
          await supabase
            .from("pending_ticket_resolutions")
            .update({ status: "failed", error_message: `${updateRes.status}: ${errText.substring(0, 200)}` })
            .eq("id", record.id);
          failed++;
        }
      } catch (e) {
        console.error(`[resolve-ticket] Error processing record ${record.id}:`, e);
        await supabase
          .from("pending_ticket_resolutions")
          .update({ status: "failed", error_message: ((e as Error).message || "").substring(0, 200) })
          .eq("id", record.id);
        failed++;
      }
    }

    return new Response(
      JSON.stringify({ processed, failed, total: pending.length }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[resolve-ticket] Unhandled error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
