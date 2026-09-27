-- Migration 14: instant tutor approval from the AI transcript scan, no personal details kept,
-- and one transcript per person (an identical set of courses and marks can't be used twice). Safe to re-run.

-- Scans keep only courses and marks. Wipe any names saved by earlier versions.
update public.transcript_scans set name = null where name is not null;
alter table public.transcript_scans add column if not exists fingerprint text;

-- Every course code and mark on a transcript, sorted, hashed. Two people can't have the exact same record.
create or replace function public.transcript_fingerprint(p_courses jsonb) returns text
language sql immutable as $$
  select case when count(*) = 0 then null
    else md5(string_agg(upper(c->>'code') || ':' || (c->>'mark'), ',' order by upper(c->>'code'), (c->>'mark')))
  end
  from jsonb_array_elements(coalesce(p_courses, '[]'::jsonb)) c
  where coalesce(c->>'code', '') <> '' and (c->>'mark') ~ '^\d{1,3}$';
$$;

create or replace function public.scan_set_fingerprint() returns trigger
language plpgsql as $$
begin
  new.name := null;  -- never store the student's name
  new.fingerprint := public.transcript_fingerprint(new.courses);
  return new;
end $$;
drop trigger if exists scan_set_fingerprint on public.transcript_scans;
create trigger scan_set_fingerprint before insert or update on public.transcript_scans
  for each row execute function public.scan_set_fingerprint();
update public.transcript_scans set courses = courses;  -- fill fingerprints for existing scans

-- Transcripts already used by an approved tutor. Only readable by the database itself.
create table if not exists public.transcript_fingerprints (
  fingerprint text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.transcript_fingerprints enable row level security;
insert into public.transcript_fingerprints (fingerprint, user_id)
select distinct on (s.fingerprint) s.fingerprint, s.user_id
from public.transcript_scans s join public.profiles p on p.id = s.user_id
where s.fingerprint is not null and p.tutor_status = 'approved'
order by s.fingerprint, s.created_at
on conflict do nothing;

-- Has another account already used this exact transcript?
create or replace function public.transcript_taken(p_fingerprint text, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from transcript_fingerprints f where f.fingerprint = p_fingerprint and f.user_id <> p_user);
$$;
revoke all on function public.transcript_taken(text, uuid) from anon, authenticated, public;

-- Submitting an application now approves it straight away, using only the server-side scan.
create or replace function public.submit_tutor_application(
  p_transcript_path text, p_transcript_name text, p_myequals text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_uni text;
  app_id uuid;
  sc transcript_scans;
  c jsonb;
  n int := 0;
  link text := nullif(btrim(coalesce(p_myequals, '')), '');
begin
  if me is null then raise exception 'Sign in first'; end if;
  if link is not null and link !~* '^https://([a-z0-9-]+\.)*myequals\.(edu\.au|net|org)/' then
    raise exception 'That doesn''t look like a My eQuals share link';
  end if;
  select uni_id into my_uni from profiles where id = me;
  if my_uni is null then raise exception 'Add your university to your profile first'; end if;

  select * into sc from transcript_scans s
   where s.user_id = me and (p_transcript_path is null or s.path = p_transcript_path)
   order by s.created_at desc limit 1;
  if sc.id is null or sc.fingerprint is null then
    raise exception 'Upload your transcript so our AI can read your courses first';
  end if;

  if public.transcript_taken(sc.fingerprint, me) then
    insert into tutor_applications (user_id, transcript_path, transcript_name, myequals_link, status, admin_notes, reviewed_at)
    values (me, sc.path, p_transcript_name, link, 'rejected', 'This transcript is already registered to another account.', now());
    perform set_config('app.bypass', 'on', true);
    update profiles set tutor_status = 'rejected' where id = me and tutor_status <> 'approved';
    return null;
  end if;

  select count(*) into n from jsonb_array_elements(sc.courses) x
   where (x->>'mark') ~ '^\d{1,3}$' and (x->>'mark')::int between 75 and 100;
  if n = 0 then raise exception 'Your transcript has no courses with a mark of 75 or more, so there''s nothing to tutor yet'; end if;

  perform set_config('app.bypass', 'on', true);
  update profiles set tutor_status = 'approved',
         myequals_link = coalesce(link, myequals_link),
         equals_verified = case when link is not null and link is distinct from myequals_link then false else equals_verified end
   where id = me;

  insert into tutor_applications (user_id, transcript_path, transcript_name, myequals_link, status, admin_notes, reviewed_at)
  values (me, sc.path, p_transcript_name, link, 'approved', 'Approved automatically from the AI transcript scan.', now())
  returning id into app_id;

  for c in select * from jsonb_array_elements(sc.courses) loop
    if (c->>'mark') ~ '^\d{1,3}$' and (c->>'mark')::int between 75 and 100 and coalesce(c->>'code', '') ~ '^[A-Z0-9]{3,12}$' then
      insert into tutor_courses (tutor_id, application_id, uni_id, code, title, mark, grade, status)
      values (me, app_id, my_uni, c->>'code', coalesce(c->>'title', ''), (c->>'mark')::int, nullif(c->>'grade', ''), 'approved')
      on conflict (tutor_id, uni_id, code) do update
        set application_id = excluded.application_id, title = excluded.title,
            mark = excluded.mark, grade = excluded.grade, status = 'approved';
      insert into courses (uni_id, code, title, source)
      values (my_uni, c->>'code', coalesce(c->>'title', ''), 'transcript')
      on conflict (uni_id, code) do nothing;
    end if;
  end loop;

  insert into transcript_fingerprints (fingerprint, user_id) values (sc.fingerprint, me)
  on conflict (fingerprint) do nothing;
  return app_id;
end $$;
revoke all on function public.submit_tutor_application(text, text, text) from anon, public;
grant execute on function public.submit_tutor_application(text, text, text) to authenticated;
