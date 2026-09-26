-- Migration 12: HD only costs extra, $0.50 per answer. Refunds for unanswered spots include it,
-- because settle_my_questions refunds cost / slots per spot. Safe to re-run.
drop function if exists public.question_price(int, boolean);
create or replace function public.question_price(p_slots int, p_urgent boolean, p_min int default 75) returns numeric
language sql immutable as $$
  select (case p_slots when 2 then 3.00 when 3 then 4.50 when 5 then 7.50 else 3.00 end)
         + (case when p_urgent then 0.75 * p_slots else 0 end)
         + (case when p_min >= 85 then 0.50 * p_slots else 0 end);
$$;

create or replace function public.charge_question() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  new.min_mark := case when new.min_mark = 85 then 85 else 75 end;  -- Distinction and HD, or HD only
  new.verified_only := false;  -- My eQuals is a badge, not a filter
  new.goals := coalesce(array(select distinct g from unnest(new.goals) g), '{}');
  new.wide := not ('course_specific' = any(new.goals));  -- course-specific stays at the student's uni
  new.cost := public.question_price(new.slots, new.urgent, new.min_mark);
  new.settled := false;
  select credits into bal from profiles where id = new.asker_id for update;
  if coalesce(bal, 0) < new.cost then
    raise exception 'You need % more credits to post this question. Top up on the Credits page.', to_char(new.cost - coalesce(bal, 0), 'FM$990.00');
  end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = credits - new.cost where id = new.asker_id;
  return new;
end $$;
