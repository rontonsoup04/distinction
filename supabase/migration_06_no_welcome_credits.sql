-- Migration 6: no free starter credits. New accounts start at $0.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, intended_role, credits)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
          new.raw_user_meta_data->>'intended_role', 0)
  on conflict (id) do nothing;
  return new;
end $$;

-- Take back unused welcome credits from existing accounts (once)
with t as (
  select p.id, least(p.credits, 10) as amt
  from public.profiles p
  where exists (select 1 from public.credit_tx c where c.user_id = p.id and c.label = 'Welcome credits')
    and not exists (select 1 from public.credit_tx c where c.user_id = p.id and c.label = 'Welcome credits removed')
    and p.credits > 0
)
, upd as (
  update public.profiles p set credits = p.credits - t.amt from t where p.id = t.id returning p.id, t.amt
)
insert into public.credit_tx (user_id, amount, label) select id, -amt, 'Welcome credits removed' from upd;

-- Admins can add credits to an account by hand (for testing until payments launch)
create or replace function public.admin_grant_credits(p_email text, p_amount numeric, p_label text default 'Credits added by admin')
returns numeric
language plpgsql security definer set search_path = public as $$
declare uid uuid; bal numeric;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Admins only'; end if;
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  if uid is null then raise exception 'No account with that email'; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000 then raise exception 'Enter an amount between -1000 and 1000'; end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = greatest(credits + p_amount, 0) where id = uid returning credits into bal;
  insert into credit_tx (user_id, amount, label) values (uid, p_amount, coalesce(nullif(btrim(p_label), ''), 'Credits added by admin'));
  return bal;
end $$;
revoke all on function public.admin_grant_credits(text, numeric, text) from anon, public;
grant execute on function public.admin_grant_credits(text, numeric, text) to authenticated;
