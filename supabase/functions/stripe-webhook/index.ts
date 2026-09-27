// Supabase Edge Function: stripe-webhook
// Stripe calls this after a Checkout payment. It checks Stripe's signature, then adds the credits once.
// Turn OFF "Verify JWT" for this function: Stripe doesn't send a Supabase login token.
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PACKS: Record<string, number> = { "10": 10, "21": 20, "55": 50 };

Deno.serve(async (req) => {
  const key = Deno.env.get("STRIPE_SECRET_KEY"), secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!key || !secret) return new Response("Not configured", { status: 503 });
  const stripe = new Stripe(key, { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, req.headers.get("stripe-signature") ?? "", secret, undefined, Stripe.createSubtleCryptoProvider());
  } catch (e) {
    console.error("Bad signature", e);
    return new Response("Bad signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object as Stripe.Checkout.Session;
    const credits = s.metadata?.credits ?? "", user = s.metadata?.user_id ?? "";
    const expected = PACKS[credits];
    // Only credit fully paid sessions for a known pack at the right price
    if (s.payment_status === "paid" && user && expected && s.amount_total === expected * 100 && s.currency === "aud") {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { error } = await admin.rpc("stripe_credit", { p_session: s.id, p_user: user, p_credits: Number(credits), p_amount: expected });
      if (error) { console.error("stripe_credit", error); return new Response("Retry", { status: 500 }); }
    } else console.warn("Ignored session", s.id, s.payment_status, credits, s.amount_total);
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
