-- Migration 11: "What are you after?" on questions.
-- Students tick any of: answer, explanation, expertise, experience, check_work, course_specific.
-- course_specific keeps the question at the student's own uni: the exact course, plus that uni's courses in
-- the same specific similarity group (similar_group, not the broad similar_group_2). Safe to re-run.

alter table public.questions add column if not exists goals text[] not null default '{}';
alter table public.questions drop constraint if exists questions_goals_check;
alter table public.questions add constraint questions_goals_check
  check (goals <@ array['answer','explanation','expertise','experience','check_work','course_specific']::text[]);

-- Same uni, same specific topic group
create or replace function public.courses_close(u1 text, c1 text, u2 text, c2 text) returns boolean
language sql stable security definer set search_path = public as $$
  select u1 = u2 and exists (
    select 1 from courses a, courses b
    where a.uni_id = u1 and a.code = c1 and b.uni_id = u2 and b.code = c2
      and a.similar_group is not null and a.similar_group = b.similar_group
  );
$$;

-- Does tutor course (tu, tc) reach a question on (qu, qc)? wide = any uni, similar in either group
create or replace function public.course_reaches(qu text, qc text, wide boolean, tu text, tc text) returns boolean
language sql stable security definer set search_path = public as $$
  select (tu = qu and tc = qc)
      or (wide and public.courses_similar(qu, qc, tu, tc))
      or (not wide and public.courses_close(qu, qc, tu, tc));
$$;

create or replace function public.charge_question() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  new.min_mark := case when new.min_mark = 85 then 85 else 75 end;  -- Distinction and HD, or HD only
  new.verified_only := false;  -- My eQuals is a badge, not a filter
  new.goals := coalesce(array(select distinct g from unnest(new.goals) g), '{}');
  new.wide := not ('course_specific' = any(new.goals));  -- course-specific stays at the student's uni
  new.cost := public.question_price(new.slots, new.urgent);
  new.settled := false;
  select credits into bal from profiles where id = new.asker_id for update;
  if coalesce(bal, 0) < new.cost then
    raise exception 'You need % more credits to post this question. Top up on the Credits page.', to_char(new.cost - coalesce(bal, 0), 'FM$990.00');
  end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = credits - new.cost where id = new.asker_id;
  return new;
end $$;

create or replace function public.tutor_can_answer(t uuid, q_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.questions q
    join public.profiles p on p.id = t
    where q.id = q_id
      and q.asker_id <> t
      and p.tutor_status = 'approved'
      and (not q.verified_only or p.equals_verified)
      and exists (
        select 1 from public.tutor_courses tc
        where tc.tutor_id = t and tc.status = 'approved' and tc.mark >= q.min_mark
          and public.course_reaches(q.uni_id, q.course_code, q.wide, tc.uni_id, tc.code)
      )
  );
$$;

drop function if exists public.tutor_feed();
create function public.tutor_feed()
returns table (
  id uuid, uni_id text, course_code text, course_title text, body text,
  attachment_path text, attachment_name text, attachment_type text, attachment_size int,
  min_mark int, verified_only boolean, wide boolean, urgent boolean, slots int,
  expires_at timestamptz, created_at timestamptz, asker_name text,
  answer_count int, held_by_others int, my_position int, my_payout numeric,
  my_claim_expires timestamptz, match_uni text, match_code text, goals text[]
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
         m.uni_id, m.code, q.goals
  from questions q
  join profiles p on p.id = q.asker_id
  left join lateral (
    select tc.uni_id, tc.code from tutor_courses tc
    where tc.tutor_id = auth.uid() and tc.status = 'approved' and tc.mark >= q.min_mark
      and public.course_reaches(q.uni_id, q.course_code, q.wide, tc.uni_id, tc.code)
    order by (tc.uni_id = q.uni_id and tc.code = q.course_code) desc, tc.mark desc
    limit 1
  ) m on true
  where public.tutor_can_answer(auth.uid(), q.id)
    and (q.expires_at > now()
         or exists (select 1 from answers a where a.question_id = q.id and a.tutor_id = auth.uid()
                    and a.created_at > now() - interval '3 days'))
  order by q.created_at desc
  limit 100;
$$;
grant execute on function public.tutor_feed() to authenticated;

create or replace function public.question_reach(p_uni text, p_code text, p_min int, p_verified boolean, p_wide boolean)
returns int
language sql stable security definer set search_path = public as $$
  select count(distinct tc.tutor_id)::int
  from tutor_courses tc join profiles p on p.id = tc.tutor_id
  where tc.status = 'approved' and p.tutor_status = 'approved' and tc.mark >= p_min
    and (not p_verified or p.equals_verified) and tc.tutor_id <> auth.uid()
    and public.course_reaches(p_uni, p_code, p_wide, tc.uni_id, tc.code);
$$;
