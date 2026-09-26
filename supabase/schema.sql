-- Distinction: database schema, security rules and functions
-- Run this once in the Supabase SQL editor. Safe to re-run: objects are created if missing.

create extension if not exists pgcrypto;

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table if not exists public.universities (
  id          text primary key,            -- short code, e.g. UNSW
  name        text not null,
  short_name  text not null,
  state       text not null
);

create table if not exists public.courses (
  id            bigint generated always as identity primary key,
  uni_id        text not null references public.universities(id) on delete cascade,
  code          text not null,
  title         text not null default '',
  similar_group text,                         -- courses with the same group count as equivalent across unis
  source        text not null default 'seed', -- seed | user | transcript
  created_at    timestamptz not null default now(),
  unique (uni_id, code)
);
create index if not exists courses_group_idx on public.courses (similar_group);

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text,
  display_name    text,
  uni_id          text references public.universities(id),
  degree          text,
  year_of_study   text,
  current_courses text[] not null default '{}',
  answer_language text,
  heard_from      text,
  bio             text check (char_length(bio) <= 400),
  is_student      boolean not null default false,
  tutor_status    text not null default 'none' check (tutor_status in ('none','pending','approved','rejected')),
  equals_verified boolean not null default false,
  is_admin        boolean not null default false,
  onboarded       boolean not null default false,
  intended_role   text,
  created_at      timestamptz not null default now()
);

create table if not exists public.tutor_applications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  transcript_path text not null,
  transcript_name text,
  myequals_link   text,
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_notes     text,
  submitted_at    timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles(id)
);

create table if not exists public.tutor_courses (
  id             bigint generated always as identity primary key,
  tutor_id       uuid not null references public.profiles(id) on delete cascade,
  application_id uuid references public.tutor_applications(id) on delete set null,
  uni_id         text not null references public.universities(id),
  code           text not null,
  title          text not null default '',
  mark           int not null check (mark between 0 and 100),
  grade          text,
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  unique (tutor_id, uni_id, code)
);

create table if not exists public.questions (
  id              uuid primary key default gen_random_uuid(),
  asker_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  uni_id          text not null references public.universities(id),
  course_code     text not null,
  body            text not null check (char_length(body) between 10 and 600
                                       and array_length(regexp_split_to_array(btrim(body), '\s+'), 1) <= 50),
  attachment_path text,
  attachment_name text,
  attachment_type text,
  attachment_size int check (attachment_size <= 5242880),
  min_mark        int not null default 75 check (min_mark in (75, 85)),
  verified_only   boolean not null default false,
  wide            boolean not null default true,
  urgent          boolean not null default false,
  slots           int not null default 2 check (slots in (2, 3, 5)),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours 5 minutes')
);
create index if not exists questions_course_idx on public.questions (uni_id, course_code);
create index if not exists questions_asker_idx on public.questions (asker_id, created_at desc);

create table if not exists public.claims (
  question_id uuid not null references public.questions(id) on delete cascade,
  tutor_id    uuid not null references public.profiles(id) on delete cascade,
  expires_at  timestamptz not null,
  primary key (question_id, tutor_id)
);

create table if not exists public.answers (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  tutor_id    uuid not null references public.profiles(id) on delete cascade,
  bubbles     jsonb not null,          -- array of short text messages
  annotations jsonb not null default '{}'::jsonb, -- pen strokes and text bubbles drawn on the attachment
  position    int not null,
  urgent_rate boolean not null default false,
  payout      numeric(6,2) not null,
  created_at  timestamptz not null default now(),
  unique (question_id, tutor_id)
);

create table if not exists public.reviews (
  id         uuid primary key default gen_random_uuid(),
  answer_id  uuid not null unique references public.answers(id) on delete cascade,
  tutor_id   uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  stars      int not null check (stars between 1 and 5),
  comment    text check (char_length(comment) <= 300),
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  answer_id   uuid not null references public.answers(id) on delete cascade,
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  reason      text check (char_length(reason) <= 500),
  created_at  timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Helper functions
------------------------------------------------------------------------------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- New sign-ups get a profile row automatically
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, intended_role)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
          new.raw_user_meta_data->>'intended_role')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users can edit their own profile but not their tutor status, verification or admin flag
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null
     or coalesce(current_setting('app.bypass', true), '') = 'on'
     or public.is_admin() then
    return new;
  end if;
  new.tutor_status    := old.tutor_status;
  new.equals_verified := old.equals_verified;
  new.is_admin        := old.is_admin;
  return new;
end $$;
drop trigger if exists protect_profile on public.profiles;
create trigger protect_profile before update on public.profiles
  for each row execute function public.protect_profile();

-- Can tutor t answer question q? (course match at the same uni, or an equivalent course elsewhere)
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
          and (
            (tc.uni_id = q.uni_id and tc.code = q.course_code)
            or (q.wide and exists (
              select 1 from public.courses a
              join public.courses b on b.similar_group = a.similar_group
              where a.uni_id = q.uni_id and a.code = q.course_code and a.similar_group is not null
                and b.uni_id = tc.uni_id and b.code = tc.code))
          )
      )
  );
$$;

------------------------------------------------------------------------------
-- Row level security
------------------------------------------------------------------------------

alter table public.universities       enable row level security;
alter table public.courses            enable row level security;
alter table public.profiles           enable row level security;
alter table public.tutor_applications enable row level security;
alter table public.tutor_courses      enable row level security;
alter table public.questions          enable row level security;
alter table public.claims             enable row level security;
alter table public.answers            enable row level security;
alter table public.reviews            enable row level security;
alter table public.reports            enable row level security;

drop policy if exists "universities readable" on public.universities;
create policy "universities readable" on public.universities for select using (true);

drop policy if exists "courses readable" on public.courses;
create policy "courses readable" on public.courses for select using (true);
drop policy if exists "users add courses" on public.courses;
create policy "users add courses" on public.courses for insert to authenticated
  with check (source = 'user' and similar_group is null and char_length(code) between 3 and 12);

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select to authenticated using (true);
drop policy if exists "own profile editable" on public.profiles;
create policy "own profile editable" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

drop policy if exists "own or admin applications" on public.tutor_applications;
create policy "own or admin applications" on public.tutor_applications for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "tutor courses readable" on public.tutor_courses;
create policy "tutor courses readable" on public.tutor_courses for select to authenticated
  using (status = 'approved' or tutor_id = auth.uid() or public.is_admin());

drop policy if exists "students ask" on public.questions;
create policy "students ask" on public.questions for insert to authenticated
  with check (
    asker_id = auth.uid()
    and exists (select 1 from public.profiles where id = auth.uid() and is_student and onboarded)
    and (attachment_path is null or attachment_path like auth.uid()::text || '/%')
  );
drop policy if exists "questions visible" on public.questions;
create policy "questions visible" on public.questions for select to authenticated
  using (asker_id = auth.uid() or public.is_admin() or public.tutor_can_answer(auth.uid(), id));
drop policy if exists "askers delete" on public.questions;
create policy "askers delete" on public.questions for delete to authenticated using (asker_id = auth.uid());

drop policy if exists "own claims" on public.claims;
create policy "own claims" on public.claims for select to authenticated using (tutor_id = auth.uid());

drop policy if exists "answers visible" on public.answers;
create policy "answers visible" on public.answers for select to authenticated
  using (tutor_id = auth.uid() or public.is_admin()
         or exists (select 1 from public.questions q where q.id = question_id and q.asker_id = auth.uid()));

drop policy if exists "reviews readable" on public.reviews;
create policy "reviews readable" on public.reviews for select to authenticated using (true);
drop policy if exists "askers review" on public.reviews;
create policy "askers review" on public.reviews for insert to authenticated
  with check (
    student_id = auth.uid()
    and exists (select 1 from public.answers a join public.questions q on q.id = a.question_id
                where a.id = answer_id and a.tutor_id = reviews.tutor_id and q.asker_id = auth.uid())
  );

drop policy if exists "askers report" on public.reports;
create policy "askers report" on public.reports for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and exists (select 1 from public.answers a join public.questions q on q.id = a.question_id
                where a.id = answer_id and q.asker_id = auth.uid())
  );
drop policy if exists "admins read reports" on public.reports;
create policy "admins read reports" on public.reports for select to authenticated using (public.is_admin());

------------------------------------------------------------------------------
-- App functions (called from the site)
------------------------------------------------------------------------------

-- Tutor applies: saves the transcript reference and the courses they claim
create or replace function public.submit_tutor_application(
  p_transcript_path text, p_transcript_name text, p_myequals text, p_courses jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_uni text;
  app_id uuid;
  c jsonb;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if p_transcript_path is null or p_transcript_path not like me::text || '/%' then
    raise exception 'Upload your transcript first';
  end if;
  select uni_id into my_uni from profiles where id = me;
  if my_uni is null then raise exception 'Add your university to your profile first'; end if;
  if jsonb_typeof(p_courses) <> 'array' or jsonb_array_length(p_courses) = 0 then
    raise exception 'Add at least one course with a mark of 75 or more';
  end if;

  perform set_config('app.bypass', 'on', true);
  update profiles set tutor_status = 'pending' where id = me;

  insert into tutor_applications (user_id, transcript_path, transcript_name, myequals_link)
  values (me, p_transcript_path, p_transcript_name, nullif(btrim(p_myequals), ''))
  returning id into app_id;

  for c in select * from jsonb_array_elements(p_courses) loop
    if (c->>'mark')::int >= 75 then
      insert into tutor_courses (tutor_id, application_id, uni_id, code, title, mark, grade, status)
      values (me, app_id, my_uni, upper(btrim(c->>'code')), coalesce(c->>'title', ''),
              (c->>'mark')::int, nullif(c->>'grade', ''), 'pending')
      on conflict (tutor_id, uni_id, code) do update
        set application_id = excluded.application_id, title = excluded.title,
            mark = excluded.mark, grade = excluded.grade, status = 'pending';
      insert into courses (uni_id, code, title, source)
      values (my_uni, upper(btrim(c->>'code')), coalesce(c->>'title', ''), 'transcript')
      on conflict (uni_id, code) do nothing;
    end if;
  end loop;
  return app_id;
end $$;

-- Admin approves or rejects an application, course by course
create or replace function public.admin_review_application(
  p_app uuid, p_approve boolean, p_equals boolean, p_course_ids bigint[], p_notes text
) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select user_id into uid from tutor_applications where id = p_app;
  if uid is null then raise exception 'Application not found'; end if;

  update tutor_courses
     set status = case when p_approve and id = any(coalesce(p_course_ids, '{}')) then 'approved' else 'rejected' end
   where application_id = p_app;

  update tutor_applications
     set status = case when p_approve then 'approved' else 'rejected' end,
         admin_notes = p_notes, reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_app;

  update profiles
     set tutor_status = case
           when exists (select 1 from tutor_courses where tutor_id = uid and status = 'approved') then 'approved'
           else 'rejected' end,
         equals_verified = coalesce(p_equals, equals_verified)
   where id = uid;
end $$;

-- Open questions this tutor can answer, with counts and their own claim or answer
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
           or (q.wide and exists (select 1 from courses a join courses b on b.similar_group = a.similar_group
                                  where a.uni_id = q.uni_id and a.code = q.course_code and a.similar_group is not null
                                    and b.uni_id = tc.uni_id and b.code = tc.code)))
    order by (tc.uni_id = q.uni_id and tc.code = q.course_code) desc
    limit 1
  ) m on true
  where public.tutor_can_answer(auth.uid(), q.id)
    and (q.expires_at > now()
         or exists (select 1 from answers a where a.question_id = q.id and a.tutor_id = auth.uid()
                    and a.created_at > now() - interval '3 days'))
  order by q.created_at desc
  limit 100;
$$;

-- Hold a spot on a question for 10 minutes. One question at a time.
create or replace function public.claim_question(q_id uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q questions;
  taken int;
  held int;
  until timestamptz := now() + interval '10 minutes';
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
  on conflict (question_id, tutor_id) do update set expires_at = excluded.expires_at;
  return until;
end $$;

create or replace function public.release_claim(q_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from claims where question_id = q_id and tutor_id = auth.uid();
$$;

-- Submit an answer: text bubbles plus drawings on the attachment. No files.
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
  if not public.tutor_can_answer(me, q_id) then raise exception 'You can''t answer this question'; end if;
  if exists (select 1 from answers where question_id = q_id and tutor_id = me) then
    raise exception 'You''ve already answered this question';
  end if;

  if jsonb_typeof(p_bubbles) <> 'array' or jsonb_array_length(p_bubbles) = 0 or jsonb_array_length(p_bubbles) > 10 then
    raise exception 'Write between 1 and 10 message bubbles';
  end if;
  for b in select * from jsonb_array_elements(p_bubbles) loop
    if jsonb_typeof(b) <> 'string' or char_length(btrim(b #>> '{}')) = 0 or char_length(b #>> '{}') > 800 then
      raise exception 'Each message bubble must be 1 to 800 characters';
    end if;
    total_len := total_len + char_length(b #>> '{}');
  end loop;
  if total_len < 30 then raise exception 'Write at least 30 characters so the answer is useful'; end if;
  if total_len > 2500 then raise exception 'Keep the whole answer under 2,500 characters'; end if;
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

-- Public numbers for a tutor (answers given, rating). Earnings only for yourself.
create or replace function public.tutor_stats(t uuid)
returns table (answers_count int, rating numeric, reviews_count int, earned numeric, urgent_count int, week_count int)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from answers where tutor_id = t),
    (select round(avg(stars)::numeric, 1) from reviews where tutor_id = t),
    (select count(*)::int from reviews where tutor_id = t),
    case when t = auth.uid() or public.is_admin() then (select coalesce(sum(payout), 0) from answers where tutor_id = t) end,
    case when t = auth.uid() or public.is_admin() then (select count(*)::int from answers where tutor_id = t and urgent_rate) end,
    case when t = auth.uid() or public.is_admin() then (select count(*)::int from answers where tutor_id = t and created_at > now() - interval '7 days') end;
$$;

-- How many approved tutors a question would reach (shown before posting)
create or replace function public.question_reach(p_uni text, p_code text, p_min int, p_verified boolean, p_wide boolean)
returns int
language sql stable security definer set search_path = public as $$
  select count(distinct tc.tutor_id)::int
  from tutor_courses tc join profiles p on p.id = tc.tutor_id
  where tc.status = 'approved' and p.tutor_status = 'approved' and tc.mark >= p_min
    and (not p_verified or p.equals_verified) and tc.tutor_id <> auth.uid()
    and ((tc.uni_id = p_uni and tc.code = p_code)
         or (p_wide and exists (select 1 from courses a join courses b on b.similar_group = a.similar_group
                                where a.uni_id = p_uni and a.code = p_code and a.similar_group is not null
                                  and b.uni_id = tc.uni_id and b.code = tc.code)));
$$;

revoke all on function public.submit_tutor_application(text, text, text, jsonb) from anon, public;
revoke all on function public.admin_review_application(uuid, boolean, boolean, bigint[], text) from anon, public;
revoke all on function public.tutor_feed() from anon, public;
revoke all on function public.claim_question(uuid) from anon, public;
revoke all on function public.release_claim(uuid) from anon, public;
revoke all on function public.submit_answer(uuid, jsonb, jsonb) from anon, public;
revoke all on function public.tutor_stats(uuid) from anon, public;
revoke all on function public.question_reach(text, text, int, boolean, boolean) from anon, public;
grant execute on function public.submit_tutor_application(text, text, text, jsonb) to authenticated;
grant execute on function public.admin_review_application(uuid, boolean, boolean, bigint[], text) to authenticated;
grant execute on function public.tutor_feed() to authenticated;
grant execute on function public.claim_question(uuid) to authenticated;
grant execute on function public.release_claim(uuid) to authenticated;
grant execute on function public.submit_answer(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.tutor_stats(uuid) to authenticated;
grant execute on function public.question_reach(text, text, int, boolean, boolean) to authenticated;

------------------------------------------------------------------------------
-- File storage: question attachments and tutor transcripts (both private)
------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 5242880, array['application/pdf','image/png','image/jpeg','image/webp']),
       ('transcripts', 'transcripts', false, 10485760, array['application/pdf','image/png','image/jpeg','image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "upload own attachments" on storage.objects;
create policy "upload own attachments" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "read allowed attachments" on storage.objects;
create policy "read allowed attachments" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_admin()
    or exists (select 1 from public.questions q where q.attachment_path = name and public.tutor_can_answer(auth.uid(), q.id))
  ));
drop policy if exists "delete own attachments" on storage.objects;
create policy "delete own attachments" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "upload own transcript" on storage.objects;
create policy "upload own transcript" on storage.objects for insert to authenticated
  with check (bucket_id = 'transcripts' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "read own transcript or admin" on storage.objects;
create policy "read own transcript or admin" on storage.objects for select to authenticated
  using (bucket_id = 'transcripts' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
