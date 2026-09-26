-- Migration 3: accept My eQuals share links on myequals.org as well as myequals.edu.au and myequals.net
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
  if p_myequals is null or btrim(p_myequals) !~* '^https://([a-z0-9-]+\.)*myequals\.(edu\.au|net|org)/' then
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
