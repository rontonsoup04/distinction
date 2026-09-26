-- Migration 2: courses come only from the transcript scanner, and My eQuals is required for tutors.
-- Safe to re-run.

-- What the scanner read from each uploaded transcript. Written only by the scan-transcript function.
create table if not exists public.transcript_scans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  path       text not null,
  courses    jsonb not null default '[]'::jsonb,
  name       text,
  university text,
  created_at timestamptz not null default now()
);
create index if not exists transcript_scans_user_idx on public.transcript_scans (user_id, created_at desc);
alter table public.transcript_scans enable row level security;
drop policy if exists "own or admin scans" on public.transcript_scans;
create policy "own or admin scans" on public.transcript_scans for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- no insert/update policy: only the server function (service role) can write scans

-- Replace the application function: no course list from the browser, My eQuals link required
drop function if exists public.submit_tutor_application(text, text, text, jsonb);
create or replace function public.submit_tutor_application(
  p_transcript_path text, p_transcript_name text, p_myequals text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_uni text;
  app_id uuid;
  scan jsonb;
  c jsonb;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if p_transcript_path is null or p_transcript_path not like me::text || '/%' then
    raise exception 'Upload your transcript first';
  end if;
  if p_myequals is null or btrim(p_myequals) !~* '^https://([a-z0-9-]+\.)*myequals\.(edu\.au|net)/' then
    raise exception 'Add your My eQuals share link';
  end if;
  select uni_id into my_uni from profiles where id = me;
  if my_uni is null then raise exception 'Add your university to your profile first'; end if;

  select s.courses into scan from transcript_scans s
   where s.user_id = me and s.path = p_transcript_path
   order by s.created_at desc limit 1;

  perform set_config('app.bypass', 'on', true);
  update profiles set tutor_status = 'pending' where id = me;

  insert into tutor_applications (user_id, transcript_path, transcript_name, myequals_link)
  values (me, p_transcript_path, p_transcript_name, btrim(p_myequals))
  returning id into app_id;

  if scan is not null and jsonb_typeof(scan) = 'array' then
    for c in select * from jsonb_array_elements(scan) loop
      if (c->>'mark') ~ '^\d{1,3}$' and (c->>'mark')::int between 75 and 100 and coalesce(c->>'code', '') ~ '^[A-Z0-9]{3,12}$' then
        insert into tutor_courses (tutor_id, application_id, uni_id, code, title, mark, grade, status)
        values (me, app_id, my_uni, c->>'code', coalesce(c->>'title', ''), (c->>'mark')::int, nullif(c->>'grade', ''), 'pending')
        on conflict (tutor_id, uni_id, code) do update
          set application_id = excluded.application_id, title = excluded.title,
              mark = excluded.mark, grade = excluded.grade, status = 'pending';
        insert into courses (uni_id, code, title, source)
        values (my_uni, c->>'code', coalesce(c->>'title', ''), 'transcript')
        on conflict (uni_id, code) do nothing;
      end if;
    end loop;
  end if;
  return app_id;
end $$;
revoke all on function public.submit_tutor_application(text, text, text) from anon, public;
grant execute on function public.submit_tutor_application(text, text, text) to authenticated;

-- Admins can add a course the scanner missed, after checking it against the transcript
create or replace function public.admin_add_course(p_app uuid, p_code text, p_title text, p_mark int, p_grade text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare uid uuid; uni text; new_id bigint;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select a.user_id, p.uni_id into uid, uni from tutor_applications a join profiles p on p.id = a.user_id where a.id = p_app;
  if uid is null then raise exception 'Application not found'; end if;
  if upper(btrim(p_code)) !~ '^[A-Z0-9]{3,12}$' then raise exception 'Enter a valid course code'; end if;
  if p_mark is null or p_mark < 75 or p_mark > 100 then raise exception 'Only courses with a mark of 75 or more can be tutored'; end if;
  insert into tutor_courses (tutor_id, application_id, uni_id, code, title, mark, grade, status)
  values (uid, p_app, uni, upper(btrim(p_code)), coalesce(p_title, ''), p_mark, nullif(upper(btrim(p_grade)), ''), 'pending')
  on conflict (tutor_id, uni_id, code) do update
    set application_id = excluded.application_id, title = excluded.title, mark = excluded.mark, grade = excluded.grade, status = 'pending'
  returning id into new_id;
  insert into courses (uni_id, code, title, source) values (uni, upper(btrim(p_code)), coalesce(p_title, ''), 'transcript')
  on conflict (uni_id, code) do nothing;
  return new_id;
end $$;
revoke all on function public.admin_add_course(uuid, text, text, int, text) from anon, public;
grant execute on function public.admin_add_course(uuid, text, text, int, text) to authenticated;

-- Every approved tutor is My eQuals verified
create or replace function public.admin_review_application(
  p_app uuid, p_approve boolean, p_equals boolean, p_course_ids bigint[], p_notes text
) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select user_id into uid from tutor_applications where id = p_app;
  if uid is null then raise exception 'Application not found'; end if;
  if p_approve and not coalesce(p_equals, false) then
    raise exception 'Check the My eQuals transcript before approving';
  end if;

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
         equals_verified = case when p_approve then true else equals_verified end
   where id = uid;
end $$;
