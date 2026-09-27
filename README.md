# Distinction

**Let's succeed as a generation.**

Distinction is a peer Q&A marketplace for Australian university students. Pick your uni and course, ask a short question, and it goes to students who got a Distinction or High Distinction in that course (and in similar courses at other unis). Tutors answer in short text messages and by marking up the student's own PDF or image.

Live site: https://distinction.onrender.com

## What's built

**Accounts (Supabase Auth)**
- Sign up and log in with email and password, or Google (Google needs to be switched on in Supabase, see below)
- Password reset by email
- Students: name, display name, university, degree, year, current courses, preferred answer language
- Tutors: a 4-step application covering profile, transcript upload (read automatically from PDFs, editable), My eQuals link and integrity agreement, then submission for review

**Students**
- Choose from 40 Australian universities and a searchable course list (any course code can be typed and is added to the catalogue)
- 50-word questions with one PDF or image (up to 5 MB)
- Distinction and HD, or HD only; optional My eQuals verified tutors; similar courses at other unis
- 2, 3 or 5 answers; urgent (within 20 minutes) or standard (usually within an hour); open for 1 hour to 1 day
- See answers as they arrive, view each tutor's markup on your document, rate answers, report problems

**Tutors**
- Profile with rating, reviews, approved courses and tracked earnings ($1.10 per answer, $1.70 for urgent answers within 20 minutes)
- Feed of open questions they qualify for, including similar courses at other unis
- Claim one question at a time (10-minute hold)
- Answer with up to 10 text messages plus pen, highlighter and text notes drawn on the student's document. No file uploads, and pasting is limited to short snippets, so answers can't be old assignments

**Admin**
- Review queue: view the uploaded transcript next to the claimed courses, approve course by course, confirm My eQuals
- Reports from students

Payments are not built yet. Tutor earnings are tracked in the database for when they are.

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
