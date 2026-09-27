// Supabase Edge Function: scan-transcript
// Reads a tutor's uploaded transcript (PDF or image) with Claude and returns only the courses and marks.
// Personal details (name, student number, address, date of birth) are never extracted, and the uploaded
// file is deleted as soon as it has been read.
// The Anthropic API key lives in the function's secrets (ANTHROPIC_API_KEY), never in the website.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MODEL = "claude-haiku-4-5-20251001";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PROMPT = `You are reading an Australian university academic transcript or academic statement.
Extract every course (also called a unit or subject) that has a numeric mark.
Privacy: do NOT output the student's name, student number, address, date of birth, email, phone number or any other personal detail. Only the university name and the courses.
Reply with ONLY a JSON object, no other text, in this shape:
{"university":"university name or empty string","courses":[{"code":"COMP1511","title":"Programming Fundamentals","term":"2024 T1","mark":87,"grade":"HD"}]}
Rules:
- code: the course code exactly as printed, uppercase, with no spaces (e.g. "COMP 1511" becomes "COMP1511").
- mark: an integer from 0 to 100. Skip courses with no numeric mark (e.g. in-progress, credit transfer, or satisfactory-only).
- grade: as printed (HD, DN, D, DI, CR, C, PS, P, FL, F, and so on). If missing, derive it: 85+ HD, 75-84 DN, 65-74 CR, 50-64 PS, below 50 FL.
- Never invent courses or marks. If this is not a transcript, return {"university":"","courses":[]}.`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Transcript scanning isn't set up yet." }, 503);

  const auth = req.headers.get("Authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);

  let path = "";
  try { ({ path } = await req.json()); } catch { /* handled below */ }
  if (typeof path !== "string" || !path.startsWith(user.id + "/")) return json({ error: "Upload your transcript first." }, 400);

  // Download with the user's own permissions (storage rules only allow their own folder)
  const { data: file, error: dlErr } = await supabase.storage.from("transcripts").download(path);
  if (dlErr || !file) return json({ error: "Couldn't open the uploaded file." }, 404);
  if (file.size > 10 * 1024 * 1024) return json({ error: "That file is over 10 MB." }, 413);

  const type = file.type || (path.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/png");
  const data = toBase64(await file.arrayBuffer());
  const block = type === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: type, data } };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }],
    }),
  });
  // The file has been read: delete it so no copy of the transcript (with its personal details) is kept
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error: rmErr } = await admin.storage.from("transcripts").remove([path]);
  if (rmErr) console.error("delete transcript", rmErr);

  if (!res.ok) {
    console.error("Anthropic error", res.status, await res.text());
    return json({ error: "The scanner couldn't read this file. Add your courses manually." }, 502);
  }
  const out = await res.json();
  const text: string = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  let parsed: { university?: string; courses?: unknown[] } = {};
  try {
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return json({ error: "The scanner's reply couldn't be read. Add your courses manually." }, 502);
  }
  const courses = (Array.isArray(parsed.courses) ? parsed.courses : [])
    .map((c: any) => ({
      code: String(c.code ?? "").toUpperCase().replace(/\s+/g, ""),
      title: String(c.title ?? "").slice(0, 120),
      term: String(c.term ?? "").slice(0, 30),
      mark: Math.round(Number(c.mark)),
      grade: String(c.grade ?? "").toUpperCase().slice(0, 4),
    }))
    .filter((c) => /^[A-Z0-9]{3,12}$/.test(c.code) && Number.isFinite(c.mark) && c.mark >= 0 && c.mark <= 100)
    .slice(0, 80);
  // Save only the courses and marks server-side. Applications use this copy, so marks can't be edited in the browser.
  const { data: saved, error: saveErr } = await admin.from("transcript_scans").insert({
    user_id: user.id, path, courses, university: String(parsed.university ?? "").slice(0, 120),
  }).select("fingerprint").single();
  if (saveErr) { console.error("save scan", saveErr); return json({ error: "Couldn't save the scan. Try again." }, 500); }
  // Is this exact set of courses and marks already registered to someone else?
  let duplicate = false;
  if (saved && saved.fingerprint) {
    const { data: fp } = await admin.from("transcript_fingerprints").select("user_id").eq("fingerprint", saved.fingerprint).neq("user_id", user.id).limit(1);
    duplicate = !!(fp && fp.length);
  }
  return json({ university: parsed.university ?? "", courses, duplicate });
});
