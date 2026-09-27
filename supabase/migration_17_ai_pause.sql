-- Migration 17: tutoring is paused automatically after 3 AI flags in 30 days. Admins can lift the pause.
-- Safe to re-run.

alter table public.profiles add column if not exists tutor_paused boolean not null default false;
alter table public.profiles add column if not exists tutor_paused_at timestamptz;
alter table public.profiles add column if not exists ai_strikes_reset_at timestamptz;

-- Tutors can't lift their own pause
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
  new.tutor_status        := old.tutor_status;
  new.is_admin            := old.is_admin;
  new.credits             := old.credits;
  new.ai_flags            := old.ai_flags;
  new.tutor_paused        := old.tutor_paused;
  new.tutor_paused_at     := old.tutor_paused_at;
  new.ai_strikes_reset_at := old.ai_strikes_reset_at;
  new.equals_verified := case when new.myequals_link is distinct from old.myequals_link then false else old.equals_verified end;
  return new;
end $$;

-- After each flagged answer: 3 flags in the last 30 days (since any admin reset) pauses tutoring
create or replace function public.ai_check_pause() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int; since timestamptz;
begin
  if not new.flagged then return new; end if;
  select greatest(now() - interval '30 days', coalesce(ai_strikes_reset_at, '-infinity'::timestamptz)) into since
    from profiles where id = new.tutor_id;
  select count(*) into n from answer_checks where tutor_id = new.tutor_id and flagged and created_at >= since;
  if n >= 3 then
    perform set_config('app.bypass', 'on', true);
    update profiles set tutor_paused = true, tutor_paused_at = now() where id = new.tutor_id and not tutor_paused;
    delete from claims where tutor_id = new.tutor_id;
  end if;
  return new;
end $$;
drop trigger if exists ai_check_pause on public.answer_checks;
create trigger ai_check_pause after insert on public.answer_checks
  for each row execute function public.ai_check_pause();

-- Paused tutors can't see or claim questions
create or replace function public.tutor_can_answer(t uuid, q_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.questions q
    join public.profiles p on p.id = t
    where q.id = q_id
      and q.asker_id <> t
      and p.tutor_status = 'approved'
      and not p.tutor_paused
      and (not q.verified_only or p.equals_verified)
      and exists (
        select 1 from public.tutor_courses tc
        where tc.tutor_id = t and tc.status = 'approved' and tc.mark >= q.min_mark
          and public.course_reaches(q.uni_id, q.course_code, q.wide, tc.uni_id, tc.code)
      )
  );
$$;

-- Admin lifts a pause; earlier flags stop counting towards the next pause
create or replace function public.admin_unpause_tutor(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update profiles set tutor_paused = false, tutor_paused_at = null, ai_strikes_reset_at = now() where id = p_user;
end $$;
grant execute on function public.admin_unpause_tutor(uuid) to authenticated;

create or replace function public.question_reach(p_uni text, p_code text, p_min int, p_verified boolean, p_wide boolean)
returns int
language sql stable security definer set search_path = public as $$
  select count(distinct tc.tutor_id)::int
  from tutor_courses tc join profiles p on p.id = tc.tutor_id
  where tc.status = 'approved' and p.tutor_status = 'approved' and not p.tutor_paused and tc.mark >= p_min
    and (not p_verified or p.equals_verified) and tc.tutor_id <> auth.uid()
    and public.course_reaches(p_uni, p_code, p_wide, tc.uni_id, tc.code);
$$;
