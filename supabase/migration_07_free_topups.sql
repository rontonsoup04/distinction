-- Migration 7: temporary free top-ups (no payment) while payments aren't built.
-- Turn off later with:  update public.app_settings set value = 'false' where key = 'free_topups';
create table if not exists public.app_settings (key text primary key, value jsonb not null);
alter table public.app_settings enable row level security;
drop policy if exists "settings readable" on public.app_settings;
create policy "settings readable" on public.app_settings for select using (true);
insert into public.app_settings (key, value) values ('free_topups', 'true') on conflict (key) do nothing;

create or replace function public.test_topup(p_credits numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if coalesce((select value::text from app_settings where key = 'free_topups'), 'false') <> 'true' then
    raise exception 'Top-ups need payment now. Buying credits is coming soon.';
  end if;
  if p_credits not in (10, 21, 55) then raise exception 'Choose one of the credit packs'; end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = credits + p_credits where id = auth.uid() returning credits into bal;
  insert into credit_tx (user_id, amount, label) values (auth.uid(), p_credits, 'Test top-up (no payment)');
  return bal;
end $$;
revoke all on function public.test_topup(numeric) from anon, public;
grant execute on function public.test_topup(numeric) to authenticated;
