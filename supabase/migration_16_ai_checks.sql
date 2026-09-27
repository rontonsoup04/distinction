-- Migration 16: AI-writing checks on tutor answers. Safe to re-run.
-- Each submitted answer gets an AI-likelihood score (0 to 100) from the check-answer function,
-- plus how much of it was actually typed. Answers over 40% are flagged, the tutor is warned,
-- and admins see the flag. Written only by the server function.

create table if not exists public.answer_checks (
  answer_id   uuid primary key references public.answers(id) on delete cascade,
  tutor_id    uuid not null references public.profiles(id) on delete cascade,
  ai_score    int not null check (ai_score between 0 and 100),
  typed_ratio numeric,
  flagged     boolean not null default false,
  reason      text,
  seen        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists answer_checks_tutor_idx on public.answer_checks (tutor_id, created_at desc);
alter table public.answer_checks enable row level security;

drop policy if exists "own or admin checks" on public.answer_checks;
create policy "own or admin checks" on public.answer_checks for select to authenticated
  using (tutor_id = auth.uid() or public.is_admin());

-- Tutors can only mark their own warnings as read
create or replace function public.dismiss_ai_warnings() returns void
language sql security definer set search_path = public as $$
  update answer_checks set seen = true where tutor_id = auth.uid() and flagged and not seen;
$$;
grant execute on function public.dismiss_ai_warnings() to authenticated;

-- Flag count on profiles so admins can spot repeat cases
alter table public.profiles add column if not exists ai_flags int not null default 0;

-- Users can't reset their own flag count
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
  new.ai_flags        := old.ai_flags;
  new.equals_verified := case when new.myequals_link is distinct from old.myequals_link then false else old.equals_verified end;
  return new;
end $$;
