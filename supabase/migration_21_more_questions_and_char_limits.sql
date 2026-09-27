-- Migration 21: tutors can opt in to see more questions (related courses), and character limits
-- replace the word limit: questions up to 300 characters, answers up to 500. Safe to re-run.

-- Strict match (tutor_can_answer) OR the related-course level. Used for claiming and posting,
-- so a tutor who ticked "show more questions" can answer what they see.
create or replace function public.tutor_may_claim(t uuid, q_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tutor_can_answer(t, q_id) or exists (
    select 1
    from public.questions q
    join public.profiles p on p.id = t
    where q.id = q_id and q.asker_id <> t
      and p.tutor_status = 'approved' and not p.tutor_paused
      and exists (
        select 1 from public.tutor_courses tc
        where tc.tutor_id = t and tc.status = 'approved' and tc.mark >= q.min_mark
          and public.course_reaches_at(q.uni_id, q.course_code, q.wide, 1, tc.uni_id, tc.code)
      )
  );
$$;

drop function if exists public.tutor_feed();
drop function if exists public.tutor_feed(boolean);
create function public.tutor_feed(p_more boolean default false)
returns table (
  id uuid, uni_id text, course_code text, course_title text, body text,
  attachment_path text, attachment_name text, attachment_type text, attachment_size int,
  min_mark int, verified_only boolean, wide boolean, urgent boolean, slots int,
  expires_at timestamptz, created_at timestamptz, asker_name text,
  answer_count int, held_by_others int, my_position int, my_payout numeric,
  my_claim_expires timestamptz, match_uni text, match_code text, goals text[], extra boolean
)
language sql stable security definer set search_path = public as $$
  select q.id, q.uni_id, q.course_code,
         coalesce((select title from courses c where c.uni_id = q.uni_id and c.code = q.course_code), ''),
         q.body, q.attachment_path, q.attachment_name, q.attachment_type, q.attachment_size,
         q.min_mark, q.verified_only, q.wide, q.urgent, q.slots, q.expires_at, q.created_at,
         coalesce(nullif(p.display_name, ''), split_part(coalesce(p.full_name, 'Student'), ' ', 1)),
         (select count(*)::int from answers a where a.question_id = q.id),
         (select count(*)::int from claims cl where cl.question_id = q.id and cl.tutor_id <> auth.uid() and cl.expires_at > now()),
         (select a.position from answers a where a.question_id = q.id and a.tutor_id = auth.uid()),
         (select a.payout from answers a where a.question_id = q.id and a.tutor_id = auth.uid()),
         (select cl.expires_at from claims cl where cl.question_id = q.id and cl.tutor_id = auth.uid() and cl.expires_at > now()),
         m.uni_id, m.code, q.goals,
         not public.tutor_can_answer(auth.uid(), q.id)
  from questions q
  join profiles p on p.id = q.asker_id
  left join lateral (
    select tc.uni_id, tc.code from tutor_courses tc
    where tc.tutor_id = auth.uid() and tc.status = 'approved' and tc.mark >= q.min_mark
      and public.course_reaches_at(q.uni_id, q.course_code, q.wide, 1, tc.uni_id, tc.code)
    order by (tc.uni_id = q.uni_id and tc.code = q.course_code) desc,
             public.course_reaches(q.uni_id, q.course_code, q.wide, tc.uni_id, tc.code) desc, tc.mark desc
    limit 1
  ) m on true
  where (public.tutor_can_answer(auth.uid(), q.id)
         or (p_more and public.tutor_may_claim(auth.uid(), q.id))
         or exists (select 1 from answers a where a.question_id = q.id and a.tutor_id = auth.uid()))
    and (q.expires_at > now()
         or exists (select 1 from answers a where a.question_id = q.id and a.tutor_id = auth.uid()
                    and a.created_at > now() - interval '3 days'))
  order by q.created_at desc
  limit 150;
$$;
grant execute on function public.tutor_feed(boolean) to authenticated;

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
  if not public.tutor_may_claim(me, q_id) then raise exception 'You can''t answer this question'; end if;
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

create or replace function public.submit_answer(q_id uuid, p_bubbles jsonb, p_annotations jsonb)
returns answers
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q questions;
  taken int;
  held int;
  total_len int := 0;
  b jsonb;
  row answers;
  is_urgent_rate boolean;
begin
  select * into q from questions where id = q_id for update;
  if not found or q.expires_at <= now() then raise exception 'This question has closed'; end if;
  if not public.tutor_may_claim(me, q_id) then raise exception 'You can''t answer this question'; end if;
  if exists (select 1 from answers where question_id = q_id and tutor_id = me) then
    raise exception 'You''ve already answered this question';
  end if;

  if jsonb_typeof(p_bubbles) <> 'array' or jsonb_array_length(p_bubbles) = 0 or jsonb_array_length(p_bubbles) > 10 then
    raise exception 'Write between 1 and 10 messages';
  end if;
  for b in select * from jsonb_array_elements(p_bubbles) loop
    if jsonb_typeof(b) <> 'string' or char_length(btrim(b #>> '{}')) = 0 or char_length(b #>> '{}') > 500 then
      raise exception 'Each message must be 1 to 500 characters';
    end if;
    total_len := total_len + char_length(b #>> '{}');
  end loop;
  if total_len < 30 then raise exception 'Write at least 30 characters so the answer is useful'; end if;
  if total_len > 500 then raise exception 'Keep the whole answer to 500 characters or fewer'; end if;
  if pg_column_size(coalesce(p_annotations, '{}'::jsonb)) > 400000 then raise exception 'The drawing is too large'; end if;

  select count(*) into taken from answers where question_id = q_id;
  select count(*) into held from claims where question_id = q_id and tutor_id <> me and expires_at > now();
  if taken >= q.slots then raise exception 'All spots on this question have been answered'; end if;
  if not exists (select 1 from claims where question_id = q_id and tutor_id = me and expires_at > now())
     and taken + held >= q.slots then
    raise exception 'Your hold expired and the remaining spots are held by other tutors';
  end if;

  is_urgent_rate := q.urgent and now() <= q.created_at + interval '20 minutes';
  insert into answers (question_id, tutor_id, bubbles, annotations, position, urgent_rate, payout)
  values (q_id, me, p_bubbles, coalesce(p_annotations, '{}'::jsonb), taken + 1, is_urgent_rate,
          case when is_urgent_rate then 1.70 else 1.10 end)
  returning * into row;
  delete from claims where question_id = q_id and tutor_id = me;
  return row;
end $$;

-- Questions: 20 to 300 characters instead of 50 words. Existing questions are left as they are.
alter table public.questions drop constraint if exists questions_body_check;
alter table public.questions add constraint questions_body_check
  check (char_length(btrim(body)) between 20 and 300) not valid;
