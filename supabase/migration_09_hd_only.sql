-- Migration 9: students can choose "HD only" again (min mark 85). Everything else stays forum-style.
create or replace function public.charge_question() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  new.min_mark := case when new.min_mark = 85 then 85 else 75 end;  -- Distinction and HD, or HD only
  new.verified_only := false;  -- My eQuals is a badge, not a filter
  new.wide := true;            -- similar courses at any uni are included
  new.cost := public.question_price(new.slots, new.urgent);
  new.settled := false;
  select credits into bal from profiles where id = new.asker_id for update;
  if coalesce(bal, 0) < new.cost then
    raise exception 'You need % more credits to post this question. Top up on the Credits page.', to_char(new.cost - coalesce(bal, 0), 'FM$990.00');
  end if;
  perform set_config('app.bypass', 'on', true);
  update profiles set credits = credits - new.cost where id = new.asker_id;
  return new;
end $$;
