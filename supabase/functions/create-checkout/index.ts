// Supabase Edge Function: create-checkout
// Starts a Stripe Checkout payment for a credit pack. Credits are added only by stripe-webhook,
// after Stripe confirms the payment, so nothing here can be faked from the browser.
// Everyone pays with the live key (STRIPE_SECRET_KEY). Admins use the test key (STRIPE_TEST_SECRET_KEY)
// when it's set, so they can try the flow with Stripe's test card 4242 4242 4242 4242.
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SITE = Deno.env.get("SITE_URL") ?? "https://hdistinction.live";
// credits -> price in AUD
const PACKS: Record<string, { price: number; name: string }> = {
  "10": { price: 10, name: "10 Distinction credits" },
  "21": { price: 20, name: "21 Distinction credits (1 bonus)" },
  "55": { price: 50, name: "55 Distinction credits (5 bonus)" },
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);
  const { data: me } = await userClient.from("profiles").select("is_admin").eq("id", user.id).single();
  const testKey = Deno.env.get("STRIPE_TEST_SECRET_KEY");
  const test = !!(me?.is_admin && testKey);
  const key = test ? testKey : Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return json({ error: "not_configured" }, 503);

  let pack = "";
  try { ({ pack } = await req.json()); } catch { /* checked below */ }
  const p = PACKS[String(pack)];
  if (!p) return json({ error: "Choose one of the credit packs" }, 400);

  const stripe = new Stripe(key, { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() });
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "aud", unit_amount: p.price * 100, product_data: { name: p.name } } }],
    customer_email: user.email ?? undefined,
    client_reference_id: user.id,
    metadata: { user_id: user.id, credits: String(pack) },
    payment_intent_data: { metadata: { user_id: user.id, credits: String(pack) } },
    success_url: `${SITE}/#/credits/paid`,
    cancel_url: `${SITE}/#/credits/cancelled`,
  });
  return json({ url: session.url, test: test || key.startsWith("sk_test_") });
});
