-- Migration 23: every account gets one free question (up to $3 off). If nobody answers it, the free
-- question is given back. Safe to re-run.

alter table public.profiles add column if not exists free_questions int not null default 1;
alter table public.questions add column if not exists free_amount numeric(8,2) not null default 0;

-- Users can't give themselves more free questions
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
  new.free_questions      := old.free_questions;
  new.equals_verified := case when new.myequals_link is distinct from old.myequals_link then false else old.equals_verified end;
  return new;
end $$;

create or replace function public.charge_question() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric; n int; full_price numeric; frees int;
begin
  new.min_mark := case when new.min_mark = 85 then 85 else 75 end;
  new.verified_only := false;
  new.goals := coalesce(array(select distinct g from unnest(new.goals) g), '{}');
  new.wide := not ('course_specific' = any(new.goals));
  new.reach_level := 0;
  n := public.question_reach(new.uni_id, new.course_code, new.min_mark, false, new.wide, 0, new.asker_id);
  if n < 10 then
    new.reach_level := 1;
    n := public.question_reach(new.uni_id, new.course_code, new.min_mark, false, new.wide, 1, new.asker_id);
  end if;
  new.reach_count := n;
  full_price := public.question_price(new.slots, new.urgent, new.min_mark);
  select credits, free_questions into bal, frees from profiles where id = new.asker_id for update;
  -- Free first question: up to $3 off
  new.free_amount := case when coalesce(frees, 0) > 0 then least(3.00, full_price) else 0 end;
  new.cost := full_price - new.free_amount;
  new.settled := false;
  if coalesce(bal, 0) < new.cost then
    raise exception 'You need % more credits to post this question. Top up on the Credits page.', to_char(new.cost - coalesce(bal, 0), 'FM$990.00');
  end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = credits - new.cost,
         free_questions = free_questions - case when new.free_amount > 0 then 1 else 0 end
   where id = new.asker_id;
  return new;
end $$;

create or replace function public.log_question_charge() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into credit_tx (user_id, amount, label, question_id)
  values (new.asker_id, -new.cost,
          'Question in ' || new.course_code || ' (' || new.slots || ' answers' || case when new.urgent then ', urgent' else '' end || ')'
          || case when new.free_amount > 0 then ' · free first question, ' || to_char(new.free_amount, 'FM$990.00') || ' off' else '' end,
          new.id);
  return new;
end $$;

-- Refunds only return what was actually paid. A free question with no answers is given back.
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
    refund := least(q.cost, round(greatest(q.slots - n, 0) * (q.cost / q.slots)
              + case when q.urgent then late * 0.75 else 0 end, 2));
    perform set_config('app.bypass', 'on', true);
    update questions set settled = true where id = q.id;
    if n = 0 and q.free_amount > 0 then
      update profiles set free_questions = free_questions + 1 where id = q.asker_id;
      insert into credit_tx (user_id, amount, label, question_id)
      values (q.asker_id, 0, 'Free question given back: ' || q.course_code || ' question closed without answers', q.id);
    end if;
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
