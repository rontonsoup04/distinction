-- Migration 13: repair a signed-in user whose profile row is missing. Safe to re-run.
create or replace function public.ensure_my_profile() returns void
language plpgsql security definer set search_path = public as $$
declare u auth.users;
begin
  select * into u from auth.users where id = auth.uid();
  if u.id is null then raise exception 'Not signed in'; end if;
  insert into public.profiles (id, full_name)
  values (u.id, coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'))
  on conflict (id) do nothing;
end $$;
grant execute on function public.ensure_my_profile() to authenticated;
