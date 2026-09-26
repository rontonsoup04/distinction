-- Migration 4: credits (no real payments yet), optional My eQuals badge, "drafting" status for students.
-- Safe to re-run.

------------------------------------------------------------------------------
-- Columns and tables
------------------------------------------------------------------------------
alter table public.profiles  add column if not exists credits numeric(8,2) not null default 0;
alter table public.profiles  add column if not exists myequals_link text;
alter table public.questions add column if not exists cost numeric(6,2);
alter table public.questions add column if not exists settled boolean not null default false;

create table if not exists public.credit_tx (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      numeric(8,2) not null,
  label       text not null,
  question_id uuid references public.questions(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists credit_tx_user_idx on public.credit_tx (user_id, created_at desc);
alter table public.credit_tx enable row level security;
drop policy if exists "own or admin credit history" on public.credit_tx;
create policy "own or admin credit history" on public.credit_tx for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

------------------------------------------------------------------------------
-- Pricing: 1 credit = $1. Base price by number of answers, urgent adds 75c per answer.
------------------------------------------------------------------------------
create or replace function public.question_price(p_slots int, p_urgent boolean) returns numeric
language sql immutable as $$
  select (case p_slots when 2 then 3.00 when 3 then 4.50 when 5 then 7.50 else 3.00 end)
         + (case when p_urgent then 0.75 * p_slots else 0 end);
$$;

------------------------------------------------------------------------------
-- Profiles: users can't change their own credits or verification.
-- Changing the My eQuals link clears the verified badge until an admin checks it again.
------------------------------------------------------------------------------
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.myequals_link is not null and btrim(new.myequals_link) = '' then new.myequals_link := null; end if;
  if new.myequals_link is not null and new.myequals_link !~* '^https://([a-z0-9-]+\.)*myequals\.(edu\.au|net|org)/' then
    raise exception 'That doesn''t look like a My eQuals share link';
  end if;
  if auth.uid() is null
     or coalesce(current_setting('app.bypass', true), '') = 'on'
     or public.is_admin() then
    return new;
  end if;
  new.tutor_status    := old.tutor_status;
  new.is_admin        := old.is_admin;
  new.credits         := old.credits;
  new.equals_verified := case when new.myequals_link is distinct from old.myequals_link then false else old.equals_verified end;
  return new;
end $$;

-- New accounts get $10 of starter credits
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, intended_role, credits)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
          new.raw_user_meta_data->>'intended_role', 10)
  on conflict (id) do nothing;
  insert into public.credit_tx (user_id, amount, label) values (new.id, 10, 'Welcome credits');
  return new;
end $$;

-- Existing accounts get the same starter credits once
insert into public.credit_tx (user_id, amount, label)
select p.id, 10, 'Welcome credits' from public.profiles p
where not exists (select 1 from public.credit_tx t where t.user_id = p.id and t.label = 'Welcome credits');
update public.profiles p set credits = credits + 10
where p.credits = 0 and exists (select 1 from public.credit_tx t where t.user_id = p.id and t.label = 'Welcome credits')
  and not exists (select 1 from public.questions q where q.asker_id = p.id);

------------------------------------------------------------------------------
-- Charge credits when a question is posted
------------------------------------------------------------------------------
create or replace function public.charge_question() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  new.min_mark := 75;          -- every D and HD tutor can see it
  new.verified_only := false;  -- My eQuals is a badge, not a filter
  new.wide := true;            -- similar courses at any uni are included
  new.cost := public.question_price(new.slots, new.urgent);
  new.settled := false;
  select credits into bal from profiles where id = new.asker_id for update;
  if coalesce(bal, 0) < new.cost then
    raise exception 'You need % more credits to post this question. Buying credits is coming soon.', to_char(new.cost - coalesce(bal, 0), 'FM$990.00');
  end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = credits - new.cost where id = new.asker_id;
  return new;
end $$;
drop trigger if exists charge_question on public.questions;
create trigger charge_question before insert on public.questions
  for each row execute function public.charge_question();

create or replace function public.log_question_charge() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into credit_tx (user_id, amount, label, question_id)
  values (new.asker_id, -new.cost, 'Question in ' || new.course_code || ' (' || new.slots || ' answers' || case when new.urgent then ', urgent' else '' end || ')', new.id);
  return new;
end $$;
drop trigger if exists log_question_charge on public.questions;
create trigger log_question_charge after insert on public.questions
  for each row execute function public.log_question_charge();

-- Refund closed questions: unfilled spots, plus the urgent fee for answers that took over 20 minutes
create or replace function public.settle_my_questions() returns numeric
language plpgsql security definer set search_path = public as $$
declare
  q questions;
  n int; late int; refund numeric; total numeric := 0;
begin
  for q in select * from questions
           where asker_id = auth.uid() and not settled and expires_at <= now() and cost is not null
           for update loop
    select count(*), count(*) filter (where not urgent_rate) into n, late from answers where question_id = q.id;
    refund := round(greatest(q.slots - n, 0) * (q.cost / q.slots)
              + case when q.urgent then late * 0.75 else 0 end, 2);
    perform set_config('app.bypass', 'on', true);
    update questions set settled = true where id = q.id;
    if refund > 0 then
      update profiles set credits = credits + refund where id = q.asker_id;
      insert into credit_tx (user_id, amount, label, question_id)
      values (q.asker_id, refund, 'Refund: ' || q.course_code || ' question closed' ||
              case when q.slots - n > 0 then ' with ' || (q.slots - n) || ' unanswered spot' || case when q.slots - n > 1 then 's' else '' end else '' end, q.id);
      total := total + refund;
    end if;
  end loop;
  return total;
end $$;

------------------------------------------------------------------------------
-- Students see when tutors are drafting an answer to their question
------------------------------------------------------------------------------
create or replace function public.my_drafting()
returns table (question_id uuid, tutor_name text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.question_id,
         coalesce(nullif(p.display_name, ''), split_part(coalesce(p.full_name, 'A tutor'), ' ', 1)),
         c.expires_at
  from claims c
  join questions q on q.id = c.question_id
  join profiles p on p.id = c.tutor_id
  where q.asker_id = auth.uid() and c.expires_at > now()
    and not exists (select 1 from answers a where a.question_id = c.question_id and a.tutor_id = c.tutor_id);
$$;

------------------------------------------------------------------------------
-- Tutor applications: My eQuals link optional. Approval no longer requires it.
------------------------------------------------------------------------------
drop function if exists public.submit_tutor_application(text, text, text);
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
  link text := nullif(btrim(coalesce(p_myequals, '')), '');
begin
  if me is null then raise exception 'Sign in first'; end if;
  if p_transcript_path is null or p_transcript_path not like me::text || '/%' then
    raise exception 'Upload your transcript first';
  end if;
  if link is not null and link !~* '^https://([a-z0-9-]+\.)*myequals\.(edu\.au|net|org)/' then
    raise exception 'That doesn''t look like a My eQuals share link';
  end if;
  select uni_id into my_uni from profiles where id = me;
  if my_uni is null then raise exception 'Add your university to your profile first'; end if;

  select s.courses into scan from transcript_scans s
   where s.user_id = me and s.path = p_transcript_path
   order by s.created_at desc limit 1;

  perform set_config('app.bypass', 'on', true);
  update profiles set tutor_status = 'pending',
         myequals_link = coalesce(link, myequals_link),
         equals_verified = case when link is not null and link is distinct from myequals_link then false else equals_verified end
   where id = me;

  insert into tutor_applications (user_id, transcript_path, transcript_name, myequals_link)
  values (me, p_transcript_path, p_transcript_name, link)
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
         equals_verified = case when coalesce(p_equals, false) then true else equals_verified end
   where id = uid;
end $$;

-- Admin confirms (or removes) a tutor's My eQuals checkmark
create or replace function public.admin_set_equals(p_user uuid, p_verified boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update profiles set equals_verified = p_verified where id = p_user;
end $$;

revoke all on function public.settle_my_questions() from anon, public;
revoke all on function public.my_drafting() from anon, public;
revoke all on function public.admin_set_equals(uuid, boolean) from anon, public;
grant execute on function public.settle_my_questions() to authenticated;
grant execute on function public.my_drafting() to authenticated;
grant execute on function public.admin_set_equals(uuid, boolean) to authenticated;
