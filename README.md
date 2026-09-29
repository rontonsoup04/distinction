# Distinction

**Let's succeed as a generation.**

Distinction is a free, public Q&A forum for Australian university students. Students post questions about a course at their uni, anyone with an account can answer, and everyone can browse and search questions by university and course.

Live site: https://hdistinction.live

## What's built

**Forum**
- Anyone can read. Filter by university and course, search the text, and sort by newest, active, top or unanswered
- Signed-in students post a question (title plus details) tagged with a uni and course code; any course code can be typed and is added to the catalogue
- Anyone signed in can answer, upvote questions and answers (not their own), and report problems
- The asker can mark the best answer; authors can edit or delete their own posts
- Rules against posting questions from open assessments are shown when posting, and "From an open assessment" is a report reason
- Rate limits: 8 questions and 30 answers per person per hour
- Posts in other languages are translated automatically for signed-in users; the whole interface switches between English and Mandarin

**Accounts (Supabase Auth)**
- Email and password or Google sign-in, password reset, a short set-up (display name, uni, degree, year, language)

**Admin**
- Review reports, remove or restore posts and answers, and settle any payouts left over from the old paid version

The paid version (credits, Stripe top-ups, peer mentor transcripts and pay) was switched off in September 2026. Its tables are kept but no longer used.

## Project layout

```
index.html        App shell
styles.css        Styles
config.js         Supabase URL and publishable key (safe for browsers; data is protected by row level security)
js/ui.js          Shared UI helpers (dropdowns, toasts, formatting)
js/docs.js        PDF and image viewer with drawing and text notes
js/app.js         Routing, auth and every page
vendor/           Supabase JS and PDF.js, served locally
supabase/
  schema.sql      Tables, security rules, functions and storage buckets
  seed.sql        40 universities and common courses, with cross-uni equivalents
  gen_seed.py     Regenerates seed.sql
prototype.html    The earlier clickable prototype
```

## Database

Run these in the Supabase SQL editor, in order (all safe to re-run):

1. `supabase/schema.sql`
2. `supabase/seed.sql`
3. `supabase/migration_02_scans_and_equals.sql`: courses come only from the transcript scan
4. `supabase/migration_03_equals_domains.sql`
5. `supabase/migration_04_credits_forum_badge.sql`: credits, forum-style questions, drafting status, optional My eQuals checkmark
6. `supabase/migration_05_translations.sql`: translation cache
7. `supabase/migration_06_no_welcome_credits.sql`: accounts start at $0; admins can add credits by hand
8. `supabase/migration_07_free_topups.sql`: temporary free top-ups (switch off in `app_settings`)
9. `supabase/migration_08_more_courses.sql`: more courses (UNSW first) and a second, broad similarity group. Regenerate with `supabase/gen_more.py`
10. `supabase/migration_09_hd_only.sql`: HD only option
11. `supabase/migration_10_close_question.sql`: students can close a question early
12. `supabase/migration_11_goals.sql`: "What are you after?" (answers, explanation, expertise, experience, check my work, course-specific). Course-specific keeps a question at the student's uni
13. `supabase/migration_12_hd_fee.sql`: HD only adds $0.50 per answer
14. `supabase/migration_13_ensure_profile.sql`: repairs a signed-in account whose profile row is missing
15. `supabase/migration_14_auto_approve.sql`: tutors are approved instantly from the AI scan; names aren't kept; the same transcript (identical courses and marks) can't be used by two accounts
16. `supabase/migration_15_alerts_and_fast_claims.sql`: opt-in email alerts for tutors and a 2-minute answer window
17. `supabase/migration_16_ai_checks.sql`: AI-writing checks on answers (flag over 40%, tutor warning, admin AI flags tab)
18. `supabase/migration_17_ai_pause.sql`: tutoring pauses automatically after 3 AI flags in 30 days; admins can lift it
19. `supabase/migration_18_payouts_and_stripe.sql`: tutor withdrawals ($20 minimum, paid by PayID) and Stripe card top-ups
20. `supabase/migration_19_widen_reach.sql`: questions that would reach fewer than 10 tutors are widened to related courses (same subject prefix)
21. `supabase/migration_20_review_and_history.sql`: 3-minute hold (2 to write, 1 to review), and `my_answers()` for tutors' answer history
22. `supabase/migration_21_more_questions_and_char_limits.sql`: opt-in "show more questions" for tutors; questions up to 300 characters and answers up to 500
23. `supabase/migration_22_attachment_access.sql`: tutors using "show more questions" can open those attachments
24. `supabase/migration_23_free_first_question.sql`: every account gets one free question ($3 off), given back if nobody answers
25. `supabase/migration_24_admins_answer.sql`: admins can answer any open question
26. `supabase/migration_25_open_forum.sql`: the open forum (posts, answers, upvotes, reports, search) and switching off paid questions

Add test credits to an account (until payments launch):

```sql
select public.admin_grant_credits('someone@example.com', 20, 'Test credits');
```

Payments:
- `create-checkout` starts a Stripe Checkout for a credit pack; `stripe-webhook` adds the credits once Stripe confirms payment. Secrets: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (live), plus `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_WEBHOOK_SECRET` (test mode, used for admins so they can pay with 4242 4242 4242 4242). Turn off "Verify JWT" for `stripe-webhook`. When card payments are live, switch off free top-ups: `update public.app_settings set value = 'false' where key = 'free_topups';`
- `payout-request` records a tutor's withdrawal and emails the admins the PayID details (needs `RESEND_API_KEY`). Mark it paid in Admin → Payouts.

The `notify-tutors` Edge Function emails tutors who turned on alerts when a question is posted. It needs a `RESEND_API_KEY` secret and a verified sending domain in Resend.

The `scan-transcript` Edge Function (`supabase/functions/scan-transcript`) reads transcripts with Claude. It needs an `ANTHROPIC_API_KEY` secret in Supabase.

Security highlights:
- Row level security on every table
- Students only see their own questions and the answers to them
- Tutors only see questions they're approved to answer
- Transcripts are private to the applicant and admins
- Tutors can't change their own tutor status, verification or admin flag
- Answers are submitted through a checked function: one claim at a time, slot limits, message length limits, urgent pay window

Make someone an admin (run once in the SQL editor, after they've signed up):

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'you@example.com');
```

## Switching on Google sign-in

1. In Google Cloud Console, create an OAuth client (Web application).
2. Add the redirect URI shown in Supabase under Authentication → Sign In / Providers → Google.
3. Paste the client ID and secret into Supabase and enable the provider.

## Deploy

Render serves this repo as a static site (no build step). Every push to `main` redeploys.
