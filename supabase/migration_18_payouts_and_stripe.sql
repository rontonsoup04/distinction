-- Migration 18: tutor withdrawals (minimum $20, paid manually by PayID for now) and Stripe card top-ups.
-- Safe to re-run.

------------------------------------------------------------------------------
-- Withdrawals
------------------------------------------------------------------------------
create table if not exists public.payout_requests (
  id          uuid primary key default gen_random_uuid(),
  tutor_id    uuid not null references public.profiles(id) on delete cascade,
  amount      numeric(8,2) not null check (amount >= 20),
  payid       text not null,
  payid_name  text not null,
  status      text not null default 'pending' check (status in ('pending','paid','rejected')),
  admin_note  text,
  created_at  timestamptz not null default now(),
  paid_at     timestamptz,
  emailed_at  timestamptz
);
create index if not exists payout_requests_tutor_idx on public.payout_requests (tutor_id, created_at desc);
alter table public.payout_requests enable row level security;
drop policy if exists "own or admin payouts" on public.payout_requests;
create policy "own or admin payouts" on public.payout_requests for select to authenticated
  using (tutor_id = auth.uid() or public.is_admin());
-- no insert/update policies: only the functions below write

-- Earned from answers, minus withdrawals that are pending or paid
create or replace function public.tutor_balance(t uuid default auth.uid())
returns table (earned numeric, withdrawn numeric, pending numeric, available numeric)
language sql stable security definer set search_path = public as $$
  select e, w, p, greatest(e - w - p, 0)
  from (select
    (select coalesce(sum(payout), 0) from answers where tutor_id = t) e,
    (select coalesce(sum(amount), 0) from payout_requests where tutor_id = t and status = 'paid') w,
    (select coalesce(sum(amount), 0) from payout_requests where tutor_id = t and status = 'pending') p
  ) x
  where t = auth.uid() or public.is_admin();
$$;
grant execute on function public.tutor_balance(uuid) to authenticated;

create or replace function public.request_payout(p_amount numeric, p_payid text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); avail numeric; rid uuid; pid text := btrim(coalesce(p_payid, '')); nm text := btrim(coalesce(p_name, ''));
begin
  if me is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from payout_requests where tutor_id = me and status = 'pending') then
    raise exception 'You already have a withdrawal on the way. You can request another once it''s paid.';
  end if;
  select available into avail from public.tutor_balance(me);
  if p_amount is null or p_amount < 20 then raise exception 'The minimum withdrawal is $20'; end if;
  if p_amount > avail then raise exception 'You can withdraw up to %', to_char(avail, 'FM$990.00'); end if;
  if length(pid) < 6 or length(pid) > 120 then raise exception 'Enter your PayID (the phone number, email or ABN linked to your bank account)'; end if;
  if length(nm) < 2 or length(nm) > 120 then raise exception 'Enter the name on your PayID'; end if;
  insert into payout_requests (tutor_id, amount, payid, payid_name) values (me, round(p_amount, 2), pid, nm) returning id into rid;
  return rid;
end $$;
grant execute on function public.request_payout(numeric, text, text) to authenticated;

create or replace function public.admin_mark_payout(p_id uuid, p_paid boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update payout_requests set status = case when p_paid then 'paid' else 'rejected' end,
         paid_at = case when p_paid then now() end, admin_note = p_note
   where id = p_id and status = 'pending';
end $$;
grant execute on function public.admin_mark_payout(uuid, boolean, text) to authenticated;

-- Admin emails, for the withdrawal notification (server function only)
create or replace function public.admin_emails() returns table (email text)
language sql stable security definer set search_path = public as $$
  select u.email::text from auth.users u join profiles p on p.id = u.id where p.is_admin and u.email is not null;
$$;
revoke all on function public.admin_emails() from anon, authenticated, public;
grant execute on function public.admin_emails() to service_role;

------------------------------------------------------------------------------
-- Stripe card top-ups
------------------------------------------------------------------------------
create table if not exists public.stripe_payments (
  session_id  text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  credits     numeric(8,2) not null,
  amount_aud  numeric(8,2) not null,
  created_at  timestamptz not null default now()
);
alter table public.stripe_payments enable row level security;
drop policy if exists "own or admin stripe" on public.stripe_payments;
create policy "own or admin stripe" on public.stripe_payments for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Called by the stripe-webhook function once Stripe confirms payment. Each session is only credited once.
create or replace function public.stripe_credit(p_session text, p_user uuid, p_credits numeric, p_amount numeric) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into stripe_payments (session_id, user_id, credits, amount_aud) values (p_session, p_user, p_credits, p_amount)
  on conflict (session_id) do nothing;
  if not found then return false; end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = credits + p_credits where id = p_user;
  insert into credit_tx (user_id, amount, label) values (p_user, p_credits, 'Top-up by card (' || to_char(p_amount, 'FM$990.00') || ')');
  return true;
end $$;
revoke all on function public.stripe_credit(text, uuid, numeric, numeric) from anon, authenticated, public;
grant execute on function public.stripe_credit(text, uuid, numeric, numeric) to service_role;
