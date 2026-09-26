-- Migration 10: students can close their own question early. Unanswered spots are refunded straight away.
create or replace function public.close_question(q_id uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare refunded numeric;
begin
  update questions set expires_at = greatest(created_at + interval '1 microsecond', now())
   where id = q_id and asker_id = auth.uid() and expires_at > now();
  if not found then raise exception 'This question is already closed'; end if;
  delete from claims where question_id = q_id;
  select public.settle_my_questions() into refunded;
  return refunded;
end $$;
revoke all on function public.close_question(uuid) from anon, public;
grant execute on function public.close_question(uuid) to authenticated;
