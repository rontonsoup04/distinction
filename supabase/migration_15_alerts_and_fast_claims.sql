-- Migration 15: email alerts for tutors (opt-in) and a 2-minute answer window. Safe to re-run.

-- Tutors choose whether to get emails. alerts_asked = we've shown them the question already.
alter table public.profiles add column if not exists email_alerts boolean not null default false;
alter table public.profiles add column if not exists alerts_asked boolean not null default false;
alter table public.profiles add column if not exists email_alerts_at timestamptz;
alter table public.questions add column if not exists alerted_at timestamptz;

-- Private settings the database uses itself (no policies, so nobody can read them through the API)
create table if not exists public.app_secrets (key text primary key, value text not null);
alter table public.app_secrets enable row level security;
insert into public.app_secrets (key, value)
values ('unsub', md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text))
on conflict (key) do nothing;

create table if not exists public.alert_log (
  tutor_id    uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  primary key (tutor_id, question_id)
);
alter table public.alert_log enable row level security;

create or replace function public.unsub_token(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select md5((select value from app_secrets where key = 'unsub') || ':' || p_user::text);
$$;
revoke all on function public.unsub_token(uuid) from anon, authenticated, public;
grant execute on function public.unsub_token(uuid) to service_role;

-- Who to email about a new question: approved tutors who opted in, can answer it,
-- and haven't had an alert in the last 3 minutes (so a burst of questions isn't a burst of emails).
create or replace function public.alert_recipients(q_id uuid)
returns table (tutor_id uuid, email text, name text, unsub text)
language sql stable security definer set search_path = public as $$
  select p.id, u.email::text,
         coalesce(nullif(p.display_name, ''), split_part(coalesce(p.full_name, ''), ' ', 1)),
         public.unsub_token(p.id)
  from profiles p join auth.users u on u.id = p.id
  where p.tutor_status = 'approved' and p.email_alerts and u.email is not null
    and public.tutor_can_answer(p.id, q_id)
    and not exists (select 1 from alert_log l where l.tutor_id = p.id and l.sent_at > now() - interval '3 minutes')
  limit 200;
$$;
revoke all on function public.alert_recipients(uuid) from anon, authenticated, public;
grant execute on function public.alert_recipients(uuid) to service_role;

-- One-click unsubscribe from the link in an email (works without signing in)
create or replace function public.unsubscribe_alerts(p_user uuid, p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or p_token <> public.unsub_token(p_user) then return false; end if;
  update profiles set email_alerts = false where id = p_user;
  return true;
end $$;
grant execute on function public.unsubscribe_alerts(uuid, text) to anon, authenticated;

-- 2-minute hold: tutors answer quickly, students get fast answers, and there's less time to paste AI output.
create or replace function public.claim_question(q_id uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q questions;
  taken int;
  held int;
  until timestamptz := now() + interval '2 minutes';
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
  -- An existing hold keeps its original deadline; claiming again doesn't reset the clock
  insert into claims (question_id, tutor_id, expires_at) values (q_id, me, until)
  on conflict (question_id, tutor_id) do update
    set expires_at = case when claims.expires_at > now() then claims.expires_at else excluded.expires_at end;
  return (select expires_at from claims where question_id = q_id and tutor_id = me);
end $$;
