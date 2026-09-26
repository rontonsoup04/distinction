-- Migration 8: a second, broader similarity group for every course, and many more courses (UNSW first).
-- Questions reach tutors whose course shares EITHER group with the question's course, at any uni.
-- Safe to re-run.

alter table public.courses add column if not exists similar_group_2 text;
create index if not exists courses_group2_idx on public.courses (similar_group_2);

-- Are two courses similar? True when they share their specific topic or their broad discipline.
create or replace function public.courses_similar(u1 text, c1 text, u2 text, c2 text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from courses a, courses b
    where a.uni_id = u1 and a.code = c1 and b.uni_id = u2 and b.code = c2
      and (   (a.similar_group   is not null and (a.similar_group   = b.similar_group or a.similar_group   = b.similar_group_2))
           or (a.similar_group_2 is not null and (a.similar_group_2 = b.similar_group or a.similar_group_2 = b.similar_group_2)))
  );
$$;

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
          and ((tc.uni_id = q.uni_id and tc.code = q.course_code)
               or (q.wide and public.courses_similar(q.uni_id, q.course_code, tc.uni_id, tc.code)))
      )
  );
$$;

create or replace function public.tutor_feed()
returns table (
  id uuid, uni_id text, course_code text, course_title text, body text,
  attachment_path text, attachment_name text, attachment_type text, attachment_size int,
  min_mark int, verified_only boolean, wide boolean, urgent boolean, slots int,
  expires_at timestamptz, created_at timestamptz, asker_name text,
  answer_count int, held_by_others int, my_position int, my_payout numeric,
  my_claim_expires timestamptz, match_uni text, match_code text
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
         m.uni_id, m.code
  from questions q
  join profiles p on p.id = q.asker_id
  left join lateral (
    select tc.uni_id, tc.code from tutor_courses tc
    where tc.tutor_id = auth.uid() and tc.status = 'approved' and tc.mark >= q.min_mark
      and ((tc.uni_id = q.uni_id and tc.code = q.course_code)
           or (q.wide and public.courses_similar(q.uni_id, q.course_code, tc.uni_id, tc.code)))
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

create or replace function public.question_reach(p_uni text, p_code text, p_min int, p_verified boolean, p_wide boolean)
returns int
language sql stable security definer set search_path = public as $$
  select count(distinct tc.tutor_id)::int
  from tutor_courses tc join profiles p on p.id = tc.tutor_id
  where tc.status = 'approved' and p.tutor_status = 'approved' and tc.mark >= p_min
    and (not p_verified or p.equals_verified) and tc.tutor_id <> auth.uid()
    and ((tc.uni_id = p_uni and tc.code = p_code)
         or (p_wide and public.courses_similar(p_uni, p_code, tc.uni_id, tc.code)));
$$;

-- New UNSW courses (typed by students or read from transcripts) get a broad discipline from their code prefix
create or replace function public.course_default_group() returns trigger
language plpgsql as $$
begin
  if new.similar_group_2 is null and new.uni_id = 'UNSW' then
    new.similar_group_2 := case left(new.code, 4) when 'COMP' then 'computing' when 'SENG' then 'computing' when 'INFS' then 'information_systems' when 'ACCT' then 'accounting' when 'TABL' then 'accounting' when 'FINS' then 'finance' when 'ECON' then 'economics' when 'COMM' then 'business' when 'MGMT' then 'management' when 'MARK' then 'marketing' when 'ACTL' then 'actuarial' when 'MATH' then 'mathematics' when 'PHYS' then 'physics' when 'CHEM' then 'chemistry' when 'BABS' then 'biology' when 'BIOS' then 'biology' when 'PSYC' then 'psychology' when 'LAWS' then 'law' when 'ENGG' then 'engineering' when 'ELEC' then 'electrical_eng' when 'TELE' then 'electrical_eng' when 'MMAN' then 'mechanical_eng' when 'CVEN' then 'civil_eng' end;
  end if;
  return new;
end $$;
drop trigger if exists course_default_group on public.courses;
create trigger course_default_group before insert on public.courses
  for each row execute function public.course_default_group();

-- Courses
