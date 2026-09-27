-- Migration 22: tutors who opted in to "show more questions" can open those questions' attachments too.
drop policy if exists "read allowed attachments" on storage.objects;
create policy "read allowed attachments" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_admin()
    or exists (select 1 from public.questions q where q.attachment_path = name and public.tutor_may_claim(auth.uid(), q.id))
  ));
