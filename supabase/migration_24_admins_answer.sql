-- Migration 24: admins can answer any open question (not their own). Safe to re-run.

create or replace function public.tutor_may_claim(t uuid, q_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.tutor_can_answer(t, q_id)
    or exists (select 1 from public.questions q join public.profiles p on p.id = t
               where q.id = q_id and q.asker_id <> t and p.is_admin)
    or exists (
    select 1
    from public.questions q
    join public.profiles p on p.id = t
    where q.id = q_id and q.asker_id <> t
      and p.tutor_status = 'approved' and not p.tutor_paused
      and exists (
        select 1 from public.tutor_courses tc
        where tc.tutor_id = t and tc.status = 'approved' and tc.mark >= q.min_mark
          and public.course_reaches_at(q.uni_id, q.course_code, q.wide, 1, tc.uni_id, tc.code)
      )
  );
$$;

-- Admins see every open question when "show more questions" is on (and on the answer page)
drop function if exists public.tutor_feed();
drop function if exists public.tutor_feed(boolean);
create function public.tutor_feed(p_more boolean default false)
returns table (
  id uuid, uni_id text, course_code text, course_title text, body text,
  attachment_path text, attachment_name text, attachment_type text, attachment_size int,
  min_mark int, verified_only boolean, wide boolean, urgent boolean, slots int,
  expires_at timestamptz, created_at timestamptz, asker_name text,
  answer_count int, held_by_others int, my_position int, my_payout numeric,
  my_claim_expires timestamptz, match_uni text, match_code text, goals text[], extra boolean
)
language sql stable security definer set search_path = public as $$
  select q.id, q.uni_id, q.course_code,
         coalesce((select title from courses c where c.uni_id = q.uni_id and c.code = q.course_code), ''),
         q.body, q.attachment_path, q.attachment_name, q.attachment_type, q.attachment_size,
         q.min_mark, q.verified_only, q.wide, q.urgent, q.slots, q.expires_at, q.created_at,
         coalesce(nullif(p.display_name, ''), split_part(coalesce(p.full_name, 'Student'), ' ', 1)),
         (select count(*)::int from answers a where a.question_id = q.id),
         (select count(*)::int from claims cl where cl.question_id = q.id and cl.tutor_id <> auth.uid() and cl.expires_at > now()),
         (select a.position from answers a where a.question_id = q.id and a.tutor_id = auth.uid()),
         (select a.payout from answers a where a.question_id = q.id and a.tutor_id = auth.uid()),
         (select cl.expires_at from claims cl where cl.question_id = q.id and cl.tutor_id = auth.uid() and cl.expires_at > now()),
         m.uni_id, m.code, q.goals,
         not public.tutor_can_answer(auth.uid(), q.id)
  from questions q
  join profiles p on p.id = q.asker_id
  left join lateral (
    select tc.uni_id, tc.code from tutor_courses tc
    where tc.tutor_id = auth.uid() and tc.status = 'approved' and tc.mark >= q.min_mark
      and public.course_reaches_at(q.uni_id, q.course_code, q.wide, 1, tc.uni_id, tc.code)
    order by (tc.uni_id = q.uni_id and tc.code = q.course_code) desc,
             public.course_reaches(q.uni_id, q.course_code, q.wide, tc.uni_id, tc.code) desc, tc.mark desc
    limit 1
  ) m on true
  where (public.tutor_can_answer(auth.uid(), q.id)
         or (p_more and public.tutor_may_claim(auth.uid(), q.id))
         or (public.is_admin() and q.asker_id <> auth.uid() and q.expires_at > now() and p_more)
         or exists (select 1 from answers a where a.question_id = q.id and a.tutor_id = auth.uid()))
    and (q.expires_at > now()
         or exists (select 1 from answers a where a.question_id = q.id and a.tutor_id = auth.uid()
                    and a.created_at > now() - interval '3 days'))
  order by q.created_at desc
  limit 150;
$$;
grant execute on function public.tutor_feed(boolean) to authenticated;
