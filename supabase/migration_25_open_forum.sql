-- Migration 25: Distinction becomes a free, open forum.
-- Anyone can read posts (no sign-in needed). Signed-in students can post questions about a course,
-- anyone signed in can reply, upvote, mark the best answer on their own post and report problems.
-- Paid questions, credits and peer mentor pay are switched off. Old data is kept but no longer used.
-- Safe to re-run.

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------
create table if not exists public.forum_posts (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  author_name    text not null default '',
  author_uni     text,
  uni_id         text not null references public.universities(id),
  course_code    text not null check (course_code ~ '^[A-Z0-9]{3,12}$'),
  title          text not null check (char_length(btrim(title)) between 8 and 150),
  body           text not null check (char_length(btrim(body)) between 20 and 4000),
  reply_count    int not null default 0,
  score          int not null default 0,
  accepted_reply uuid,
  removed        boolean not null default false,
  created_at     timestamptz not null default now(),
  edited_at      timestamptz,
  last_activity  timestamptz not null default now(),
  search         tsvector generated always as (
                   setweight(to_tsvector('simple'::regconfig, coalesce(course_code, '')), 'A') ||
                   setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
                   setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'B')) stored
);
create index if not exists forum_posts_course_idx on public.forum_posts (uni_id, course_code, created_at desc);
create index if not exists forum_posts_new_idx on public.forum_posts (created_at desc);
create index if not exists forum_posts_author_idx on public.forum_posts (author_id, created_at desc);
create index if not exists forum_posts_search_idx on public.forum_posts using gin (search);

create table if not exists public.forum_replies (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.forum_posts(id) on delete cascade,
  author_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  author_name text not null default '',
  author_uni  text,
  body        text not null check (char_length(btrim(body)) between 2 and 3000),
  score       int not null default 0,
  removed     boolean not null default false,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz
);
create index if not exists forum_replies_post_idx on public.forum_replies (post_id, created_at);
create index if not exists forum_replies_author_idx on public.forum_replies (author_id, created_at desc);

create table if not exists public.forum_votes (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  post_id    uuid references public.forum_posts(id) on delete cascade,
  reply_id   uuid references public.forum_replies(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((post_id is null) <> (reply_id is null))
);
create unique index if not exists forum_votes_post_uq on public.forum_votes (user_id, post_id) where post_id is not null;
create unique index if not exists forum_votes_reply_uq on public.forum_votes (user_id, reply_id) where reply_id is not null;

create table if not exists public.forum_reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  post_id     uuid references public.forum_posts(id) on delete cascade,
  reply_id    uuid references public.forum_replies(id) on delete cascade,
  reason      text not null check (reason in ('assessment','wrong','spam','rude','other')),
  note        text check (char_length(note) <= 500),
  resolved    boolean not null default false,
  created_at  timestamptz not null default now(),
  check ((post_id is null) <> (reply_id is null))
);
create unique index if not exists forum_reports_post_uq on public.forum_reports (reporter_id, post_id) where post_id is not null;
create unique index if not exists forum_reports_reply_uq on public.forum_reports (reporter_id, reply_id) where reply_id is not null;

------------------------------------------------------------------------------
-- Posts: who can write what
------------------------------------------------------------------------------
create or replace function public.forum_post_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare p profiles; n int;
begin
  if tg_op = 'INSERT' then
    select * into p from profiles where id = auth.uid();
    if p.id is null then raise exception 'Sign in to post'; end if;
    if not p.onboarded then raise exception 'Finish setting up your account first'; end if;
    select count(*) into n from forum_posts where author_id = p.id and created_at > now() - interval '1 hour';
    if n >= 8 then raise exception 'You''ve posted a lot in the last hour. Try again a bit later.'; end if;
    new.author_id := p.id;
    new.author_name := coalesce(nullif(btrim(p.display_name), ''), split_part(coalesce(p.full_name, 'Student'), ' ', 1));
    new.author_uni := p.uni_id;
    new.course_code := upper(btrim(new.course_code));
    new.title := btrim(new.title);
    new.body := btrim(new.body);
    new.reply_count := 0; new.score := 0; new.accepted_reply := null; new.removed := false;
    new.created_at := now(); new.last_activity := now(); new.edited_at := null;
    insert into courses (uni_id, code, title, source) values (new.uni_id, new.course_code, '', 'user')
      on conflict (uni_id, code) do nothing;
    return new;
  end if;
  -- UPDATE
  if coalesce(current_setting('app.bypass', true), '') = 'on' then return new; end if;
  if public.is_admin() then
    if new.title is distinct from old.title or new.body is distinct from old.body then new.edited_at := now(); end if;
    return new;
  end if;
  if old.author_id <> auth.uid() then raise exception 'You can only edit your own posts'; end if;
  -- Authors can edit the title and text and choose the best answer. Nothing else.
  new.author_id := old.author_id; new.author_name := old.author_name; new.author_uni := old.author_uni;
  new.uni_id := old.uni_id; new.course_code := old.course_code;
  new.reply_count := old.reply_count; new.score := old.score; new.removed := old.removed;
  new.created_at := old.created_at; new.last_activity := old.last_activity;
  if new.accepted_reply is not null and new.accepted_reply is distinct from old.accepted_reply
     and not exists (select 1 from forum_replies r where r.id = new.accepted_reply and r.post_id = old.id and not r.removed) then
    raise exception 'That answer isn''t on this post';
  end if;
  new.title := btrim(new.title); new.body := btrim(new.body);
  if new.title is distinct from old.title or new.body is distinct from old.body then new.edited_at := now(); end if;
  return new;
end $$;
drop trigger if exists forum_post_before on public.forum_posts;
create trigger forum_post_before before insert or update on public.forum_posts
  for each row execute function public.forum_post_before();

------------------------------------------------------------------------------
-- Replies
------------------------------------------------------------------------------
create or replace function public.forum_reply_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare p profiles; n int;
begin
  if tg_op = 'INSERT' then
    select * into p from profiles where id = auth.uid();
    if p.id is null then raise exception 'Sign in to reply'; end if;
    if not p.onboarded then raise exception 'Finish setting up your account first'; end if;
    if not exists (select 1 from forum_posts where id = new.post_id and not removed) then raise exception 'This post has been removed'; end if;
    select count(*) into n from forum_replies where author_id = p.id and created_at > now() - interval '1 hour';
    if n >= 30 then raise exception 'You''ve replied a lot in the last hour. Try again a bit later.'; end if;
    new.author_id := p.id;
    new.author_name := coalesce(nullif(btrim(p.display_name), ''), split_part(coalesce(p.full_name, 'Student'), ' ', 1));
    new.author_uni := p.uni_id;
    new.body := btrim(new.body);
    new.score := 0; new.removed := false; new.created_at := now(); new.edited_at := null;
    return new;
  end if;
  if coalesce(current_setting('app.bypass', true), '') = 'on' then return new; end if;
  if public.is_admin() then
    if new.body is distinct from old.body then new.edited_at := now(); end if;
    return new;
  end if;
  if old.author_id <> auth.uid() then raise exception 'You can only edit your own replies'; end if;
  new.post_id := old.post_id; new.author_id := old.author_id; new.author_name := old.author_name; new.author_uni := old.author_uni;
  new.score := old.score; new.removed := old.removed; new.created_at := old.created_at;
  new.body := btrim(new.body);
  if new.body is distinct from old.body then new.edited_at := now(); end if;
  return new;
end $$;
drop trigger if exists forum_reply_before on public.forum_replies;
create trigger forum_reply_before before insert or update on public.forum_replies
  for each row execute function public.forum_reply_before();

-- Keep the reply count and last activity on the post up to date
create or replace function public.forum_reply_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare pid uuid := coalesce(new.post_id, old.post_id);
begin
  perform set_config('app.bypass', 'on', true);
  update forum_posts set
    reply_count = (select count(*) from forum_replies where post_id = pid and not removed),
    last_activity = case when tg_op = 'INSERT' then now() else last_activity end,
    accepted_reply = case when accepted_reply is not null and not exists (select 1 from forum_replies where id = accepted_reply and not removed) then null else accepted_reply end
  where id = pid;
  perform set_config('app.bypass', 'off', true);
  return null;
end $$;
drop trigger if exists forum_reply_after on public.forum_replies;
create trigger forum_reply_after after insert or delete or update of removed on public.forum_replies
  for each row execute function public.forum_reply_after();

------------------------------------------------------------------------------
-- Upvotes (one per person, not on your own posts)
------------------------------------------------------------------------------
create or replace function public.forum_vote_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  if new.user_id is null then raise exception 'Sign in to upvote'; end if;
  if exists (select 1 from forum_posts where id = new.post_id and author_id = new.user_id)
     or exists (select 1 from forum_replies where id = new.reply_id and author_id = new.user_id) then
    raise exception 'You can''t upvote your own post';
  end if;
  return new;
end $$;
drop trigger if exists forum_vote_before on public.forum_votes;
create trigger forum_vote_before before insert on public.forum_votes
  for each row execute function public.forum_vote_before();

create or replace function public.forum_vote_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare pid uuid := coalesce(new.post_id, old.post_id); rid uuid := coalesce(new.reply_id, old.reply_id);
begin
  perform set_config('app.bypass', 'on', true);
  if pid is not null then update forum_posts set score = (select count(*) from forum_votes where post_id = pid) where id = pid; end if;
  if rid is not null then update forum_replies set score = (select count(*) from forum_votes where reply_id = rid) where id = rid; end if;
  perform set_config('app.bypass', 'off', true);
  return null;
end $$;
drop trigger if exists forum_vote_after on public.forum_votes;
create trigger forum_vote_after after insert or delete on public.forum_votes
  for each row execute function public.forum_vote_after();

-- Reports: whoever reports is recorded
create or replace function public.forum_report_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.reporter_id := auth.uid();
  if new.reporter_id is null then raise exception 'Sign in to report'; end if;
  new.resolved := false;
  return new;
end $$;
drop trigger if exists forum_report_before on public.forum_reports;
create trigger forum_report_before before insert on public.forum_reports
  for each row execute function public.forum_report_before();

-- A changed display name shows on old posts too
create or replace function public.forum_sync_names() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text := coalesce(nullif(btrim(new.display_name), ''), split_part(coalesce(new.full_name, 'Student'), ' ', 1));
begin
  if new.display_name is distinct from old.display_name or new.full_name is distinct from old.full_name or new.uni_id is distinct from old.uni_id then
    perform set_config('app.bypass', 'on', true);
    update forum_posts set author_name = nm, author_uni = new.uni_id where author_id = new.id;
    update forum_replies set author_name = nm, author_uni = new.uni_id where author_id = new.id;
    perform set_config('app.bypass', 'off', true);
  end if;
  return null;
end $$;
drop trigger if exists forum_sync_names on public.profiles;
create trigger forum_sync_names after update on public.profiles
  for each row execute function public.forum_sync_names();

------------------------------------------------------------------------------
-- Row level security
------------------------------------------------------------------------------
alter table public.forum_posts enable row level security;
alter table public.forum_replies enable row level security;
alter table public.forum_votes enable row level security;
alter table public.forum_reports enable row level security;

drop policy if exists "posts readable" on public.forum_posts;
create policy "posts readable" on public.forum_posts for select to anon, authenticated
  using (not removed or author_id = auth.uid() or public.is_admin());
drop policy if exists "posts insert own" on public.forum_posts;
create policy "posts insert own" on public.forum_posts for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "posts update own or admin" on public.forum_posts;
create policy "posts update own or admin" on public.forum_posts for update to authenticated
  using (author_id = auth.uid() or public.is_admin());
drop policy if exists "posts delete own or admin" on public.forum_posts;
create policy "posts delete own or admin" on public.forum_posts for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

drop policy if exists "replies readable" on public.forum_replies;
create policy "replies readable" on public.forum_replies for select to anon, authenticated
  using (not removed or author_id = auth.uid() or public.is_admin());
drop policy if exists "replies insert own" on public.forum_replies;
create policy "replies insert own" on public.forum_replies for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "replies update own or admin" on public.forum_replies;
create policy "replies update own or admin" on public.forum_replies for update to authenticated
  using (author_id = auth.uid() or public.is_admin());
drop policy if exists "replies delete own or admin" on public.forum_replies;
create policy "replies delete own or admin" on public.forum_replies for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

drop policy if exists "own votes" on public.forum_votes;
create policy "own votes" on public.forum_votes for select to authenticated using (user_id = auth.uid());
drop policy if exists "vote" on public.forum_votes;
create policy "vote" on public.forum_votes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "unvote" on public.forum_votes;
create policy "unvote" on public.forum_votes for delete to authenticated using (user_id = auth.uid());

drop policy if exists "report" on public.forum_reports;
create policy "report" on public.forum_reports for insert to authenticated with check (reporter_id = auth.uid());
drop policy if exists "admins read forum reports" on public.forum_reports;
create policy "admins read forum reports" on public.forum_reports for select to authenticated using (public.is_admin());
drop policy if exists "admins resolve forum reports" on public.forum_reports;
create policy "admins resolve forum reports" on public.forum_reports for update to authenticated using (public.is_admin());

grant select on public.forum_posts, public.forum_replies to anon, authenticated;
grant insert, update, delete on public.forum_posts, public.forum_replies to authenticated;
grant select, insert, delete on public.forum_votes to authenticated;
grant select, insert, update on public.forum_reports to authenticated;

------------------------------------------------------------------------------
-- Browsing: which unis and courses have posts
------------------------------------------------------------------------------
create or replace function public.forum_unis() returns table (uni_id text, posts int)
language sql stable security definer set search_path = public as $$
  select uni_id, count(*)::int from forum_posts where not removed group by uni_id order by 2 desc;
$$;
create or replace function public.forum_courses(p_uni text) returns table (course_code text, title text, posts int, last_activity timestamptz)
language sql stable security definer set search_path = public as $$
  select f.course_code, coalesce(max(c.title), ''), count(*)::int, max(f.last_activity)
  from forum_posts f left join courses c on c.uni_id = f.uni_id and c.code = f.course_code
  where not f.removed and f.uni_id = p_uni
  group by f.course_code order by 3 desc, 1 limit 300;
$$;
grant execute on function public.forum_unis() to anon, authenticated;
grant execute on function public.forum_courses(text) to anon, authenticated;

------------------------------------------------------------------------------
-- Switch off the paid system: no new paid questions, claims, answers or card top-ups
------------------------------------------------------------------------------
drop policy if exists "students ask" on public.questions;
revoke execute on function public.claim_question(uuid) from authenticated, anon, public;
revoke execute on function public.submit_answer(uuid, jsonb, jsonb) from authenticated, anon, public;
