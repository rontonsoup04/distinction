// Supabase Edge Function: notify-tutors
// Called by the website right after a student posts a question. Emails every tutor who opted in to alerts
// and can answer it. Sends through Resend (RESEND_API_KEY secret). Each question only alerts once.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SITE = Deno.env.get("SITE_URL") ?? "https://hdistinction.live";
const FROM = Deno.env.get("ALERT_FROM") ?? "Distinction <alerts@hdistinction.live>";
const PAY = 1.10, EARLY_PAY = 1.70, EARLY_MIN = 20;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: number) => "$" + n.toFixed(2);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return json({ sent: 0, note: "Email alerts aren't set up yet (no RESEND_API_KEY)." });

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);

  let question_id = "";
  try { ({ question_id } = await req.json()); } catch { /* checked below */ }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Only the asker can trigger alerts, only for a brand-new question, and only once
  const { data: q } = await admin.from("questions")
    .select("id, asker_id, uni_id, course_code, body, urgent, created_at, expires_at, alerted_at")
    .eq("id", question_id).maybeSingle();
  if (!q || q.asker_id !== user.id) return json({ error: "Question not found" }, 404);
  if (q.alerted_at || Date.now() - new Date(q.created_at).getTime() > 5 * 60e3) return json({ sent: 0 });
  const { data: claimed } = await admin.from("questions").update({ alerted_at: new Date().toISOString() })
    .eq("id", q.id).is("alerted_at", null).select("id");
  if (!claimed || !claimed.length) return json({ sent: 0 });

  const { data: rcpts, error } = await admin.rpc("alert_recipients", { q_id: q.id });
  if (error) { console.error(error); return json({ error: "Couldn't find tutors" }, 500); }
  if (!rcpts || !rcpts.length) return json({ sent: 0 });

  const { data: course } = await admin.from("courses").select("title").eq("uni_id", q.uni_id).eq("code", q.course_code).maybeSingle();
  const early = q.urgent;
  const reward = early ? `${money(EARLY_PAY)} if you answer within ${EARLY_MIN} minutes (early bird), then ${money(PAY)}` : money(PAY);
  const link = `${SITE}/#/tutor`;
  const preview = q.body.length > 220 ? q.body.slice(0, 220) + "…" : q.body;

  const emails = rcpts.map((r: { tutor_id: string; email: string; name: string; unsub: string }) => {
    const unsub = `${SITE}/#/alerts-off/${r.tutor_id}/${r.unsub}`;
    return {
      from: FROM,
      to: [r.email],
      subject: `New ${q.course_code} question${early ? " · early bird " + money(EARLY_PAY) : ""}`,
      headers: { "List-Unsubscribe": `<${unsub}>` },
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#15201e">
        <p>Hi ${esc(r.name || "there")},</p>
        <p>A student just asked a question in <b>${esc(q.course_code)}</b>${course && course.title ? ` (${esc(course.title)})` : ""}:</p>
        <blockquote style="margin:0;padding:12px 14px;background:#f1f4f3;border-left:3px solid #0e6b66;border-radius:6px">${esc(preview)}</blockquote>
        <p>Reward: <b>${esc(reward)}</b>. First to claim gets the spot, and you have 2 minutes to answer.</p>
        <p><a href="${link}" style="display:inline-block;background:#0e6b66;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:bold">Claim and answer</a></p>
        <p style="font-size:12px;color:#667">You're getting this because you turned on question alerts on Distinction. <a href="${unsub}">Turn off email alerts</a>.</p>
      </div>`,
      text: `A student asked a ${q.course_code} question: "${preview}"\nReward: ${reward}. You have 2 minutes to answer once you claim it.\nClaim it: ${link}\n\nTurn off email alerts: ${unsub}`,
    };
  });

  let sent = 0;
  for (let i = 0; i < emails.length; i += 100) {
    const batch = emails.slice(i, i + 100);
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) { console.error("Resend", res.status, await res.text()); continue; }
    sent += batch.length;
  }
  if (sent) {
    await admin.from("alert_log").upsert(
      rcpts.slice(0, sent).map((r: { tutor_id: string }) => ({ tutor_id: r.tutor_id, question_id: q.id })),
      { onConflict: "tutor_id,question_id" },
    );
  }
  return json({ sent });
});
