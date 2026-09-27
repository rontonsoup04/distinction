-- Migration 20: a 3-minute hold (2 minutes to write, 1 to review and post), and tutors' answer history.
-- Safe to re-run.

create or replace function public.claim_question(q_id uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q questions;
  taken int;
  held int;
  until timestamptz := now() + interval '3 minutes';
  other text;
begin
  select * into q from questions where id = q_id for update;
  if not found or q.expires_at <= now() then raise exception 'This question has closed'; end if;
  if not public.tutor_can_answer(me, q_id) then raise exception 'You can''t answer this question'; end if;
  if exists (select 1 from answers where question_id = q_id and tutor_id = me) then
    raise exception 'You''ve already answered this question';
  end if;
  select q2.course_code into other from claims c join questions q2 on q2.id = c.question_id
   where c.tutor_id = me and c.expires_at > now() and c.question_id <> q_id limit 1;
  if other is not null then
    raise exception 'You can hold one question at a time. Finish or release your % question first.', other;
  end if;
  select count(*) into taken from answers where question_id = q_id;
  select count(*) into held from claims where question_id = q_id and tutor_id <> me and expires_at > now();
  if taken + held >= q.slots then raise exception 'All spots on this question are taken or held'; end if;
  insert into claims (question_id, tutor_id, expires_at) values (q_id, me, until)
  on conflict (question_id, tutor_id) do update
    set expires_at = case when claims.expires_at > now() then claims.expires_at else excluded.expires_at end;
  return (select expires_at from claims where question_id = q_id and tutor_id = me);
end $$;

-- Everything a tutor has answered, newest first
create or replace function public.my_answers(p_limit int default 50, p_offset int default 0)
returns table (answer_id uuid, question_id uuid, uni_id text, course_code text, course_title text, question text,
               asker_name text, bubbles jsonb, notes int, payout numeric, early_bird boolean, answer_order int,
               answered_at timestamptz, stars int, review text)
language sql stable security definer set search_path = public as $$
  select a.id, q.id, q.uni_id, q.course_code,
         coalesce((select title from courses c where c.uni_id = q.uni_id and c.code = q.course_code), ''),
         q.body,
         coalesce(nullif(p.display_name, ''), split_part(coalesce(p.full_name, 'Student'), ' ', 1)),
         a.bubbles,
         coalesce((select sum(jsonb_array_length(coalesce(pg.value->'notes', '[]'::jsonb)) + jsonb_array_length(coalesce(pg.value->'strokes', '[]'::jsonb)))::int
                   from jsonb_each(coalesce(a.annotations->'pages', '{}'::jsonb)) pg), 0),
         a.payout, a.urgent_rate, a.position, a.created_at,
         r.stars, r.comment
  from answers a
  join questions q on q.id = a.question_id
  join profiles p on p.id = q.asker_id
  left join reviews r on r.answer_id = a.id
  where a.tutor_id = auth.uid()
  order by a.created_at desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;
grant execute on function public.my_answers(int, int) to authenticated;
