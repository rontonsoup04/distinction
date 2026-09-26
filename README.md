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
