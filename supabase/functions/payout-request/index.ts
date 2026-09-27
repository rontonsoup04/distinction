// Supabase Edge Function: payout-request
// A tutor asks to withdraw their earnings ($20 minimum). The request is saved by the request_payout
// database function (which checks the balance), then the admins are emailed the PayID details to pay manually.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SITE = Deno.env.get("SITE_URL") ?? "https://hdistinction.live";
const FROM = Deno.env.get("ALERT_FROM") ?? "Distinction <alerts@hdistinction.live>";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);

  let amount = 0, payid = "", name = "";
  try { ({ amount, payid, name } = await req.json()); } catch { /* checked by the database */ }
  const { data: id, error } = await userClient.rpc("request_payout", { p_amount: amount, p_payid: payid, p_name: name });
  if (error) return json({ error: error.message }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const resendKey = Deno.env.get("RESEND_API_KEY");
  let emailed = false;
  if (resendKey) {
    const [{ data: r }, { data: to }, { data: p }] = await Promise.all([
      admin.from("payout_requests").select("amount, payid, payid_name, created_at").eq("id", id).single(),
      admin.rpc("admin_emails"),
      admin.from("profiles").select("full_name, display_name").eq("id", user.id).single(),
    ]);
    const recipients = (to ?? []).map((x: { email: string }) => x.email);
    if (r && recipients.length) {
      const amt = "$" + Number(r.amount).toFixed(2);
      const who = p?.full_name || p?.display_name || user.email || "A tutor";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM, to: recipients, reply_to: user.email ?? undefined,
          subject: `Withdrawal request: ${amt} to ${r.payid_name}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#15201e">
            <h2 style="margin:0 0 12px">Withdrawal request · ${esc(amt)}</h2>
            <table style="border-collapse:collapse;font-size:15px">
              <tr><td style="padding:4px 12px 4px 0;color:#667">Tutor</td><td><b>${esc(who)}</b> (${esc(user.email ?? "")})</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#667">Amount</td><td><b>${esc(amt)}</b></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#667">PayID</td><td><b>${esc(r.payid)}</b></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#667">Name on PayID</td><td><b>${esc(r.payid_name)}</b></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#667">Reference</td><td>Distinction ${esc(String(id).slice(0, 8))}</td></tr>
            </table>
            <p>Check the name your bank shows for the PayID matches before you pay. Then mark it paid:</p>
            <p><a href="${SITE}/#/admin" style="background:#0e6b66;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Open Admin → Payouts</a></p></div>`,
        }),
      });
      emailed = res.ok;
      if (!res.ok) console.error("Resend", res.status, await res.text());
      else await admin.from("payout_requests").update({ emailed_at: new Date().toISOString() }).eq("id", id);
    }
  }
  return json({ id, emailed });
});
