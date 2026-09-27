// Supabase Edge Function: translate
// Translates question and answer text into the viewer's preferred language with Claude.
// Results are cached in public.translations so each text is only translated once per language.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MODEL = "claude-haiku-4-5-20251001";
const LANGS = ["English", "Mandarin (Simplified Chinese)", "Cantonese (Traditional Chinese)", "Hindi", "Vietnamese", "Korean", "Japanese", "Indonesian", "Arabic", "Spanish", "Thai", "Nepali", "Urdu", "Punjabi", "Malay"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Translation isn't set up." }, 503);

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();

  let texts: string[] = [], target = "", mode = "";
  try { ({ texts, target, mode } = await req.json()); } catch { /* checked below */ }
  const ui = mode === "ui";
  // Signed-out visitors can translate the site's own labels (so the homepage and login switch language),
  // but not arbitrary content
  if (!user && !ui) return json({ error: "Sign in first." }, 401);
  const max = ui ? 60 : 20;
  if (!LANGS.includes(target)) return json({ error: "Unsupported language" }, 400);
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > max) return json({ error: `Send 1 to ${max} texts` }, 400);
  texts = texts.map((t) => String(t ?? "").slice(0, ui ? (user ? 600 : 400) : 3000));

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const keys = await Promise.all(texts.map((t) => sha((ui ? "ui\u0000" : "") + target + "\u0000" + t)));
  const { data: cached } = await admin.from("translations").select("key, translated, detected, same").in("key", keys);
  const hit = new Map((cached ?? []).map((c) => [c.key, c]));
  const missing = texts.map((t, i) => ({ t, i, key: keys[i] })).filter((x) => !hit.has(x.key) && x.t.trim());

  if (missing.length) {
    const prompt = ui ? `Translate each numbered text into ${target}. They are interface labels, buttons, headings, hints and messages from Distinction, a website where university students ask short questions and tutors who got a Distinction or High Distinction answer them.
Write natural, concise interface wording a native speaker would expect on a website. Keep the same length and style (a button stays a short button label).
Keep these unchanged: people's names, Australian university names and abbreviations in English (for example "University of New South Wales", "UNSW", "Monash University"), the brand name "Distinction", "My eQuals", course codes (like COMP1511), university names and abbreviations (like UNSW), grade abbreviations (HD, DN, CR, PS), dollar amounts, numbers, email addresses, URLs and anything in {curly braces}.
Reply with ONLY a JSON array, one object per text in the same order: [{"translated":"...","detected":"English","same":false}]

${missing.map((m, n) => `<text id="${n + 1}">\n${m.t}\n</text>`).join("\n")}` : `Translate each numbered text into ${target}. They are short questions and answers between university students about coursework.
Keep course codes, code snippets, formulas, numbers and names unchanged. Keep the meaning and tone; don't add anything.
If a text is already in ${target}, return it unchanged and set "same" to true.
Reply with ONLY a JSON array, one object per text in the same order: [{"translated":"...","detected":"language name in English","same":false}]

${missing.map((m, n) => `<text id="${n + 1}">\n${m.t}\n</text>`).join("\n")}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: ui ? 12000 : 8000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { console.error("Anthropic error", res.status, await res.text()); return json({ error: "Translation failed" }, 502); }
    const out = await res.json();
    const text: string = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    let arr: { translated?: string; detected?: string; same?: boolean }[] = [];
    try { arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)); } catch { return json({ error: "Translation failed" }, 502); }
    const rows = missing.map((m, n) => {
      const r = arr[n] ?? {};
      const translated = String(r.translated ?? m.t);
      return { key: m.key, target, translated, detected: String(r.detected ?? "").slice(0, 40), same: !!r.same || translated.trim() === m.t.trim() };
    });
    await admin.from("translations").upsert(rows, { onConflict: "key" });
    rows.forEach((r) => hit.set(r.key, r));
  }
  return json({
    results: texts.map((t, i) => {
      const c = hit.get(keys[i]);
      return c ? { translated: c.translated, detected: c.detected, same: c.same } : { translated: t, detected: "", same: true };
    }),
  });
});
