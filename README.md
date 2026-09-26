# Distinction

**Let's succeed as a generation.**

Distinction is a peer-tutoring marketplace for university students. Pick your uni and course, ask a short question, and it goes to students who got a Distinction or High Distinction in that course (and in similar courses at other unis). The first answers get paid.

> This is a clickable mock prototype. There is no backend: data is stored in your browser, payments and cash-outs are simulated, and answers from example tutors are demo placeholders.

## What's in the prototype

**For students (Ask a question)**
- Choose a university and course from a searchable dropdown, or type any course code
- Questions are limited to 50 words, with one image or PDF attachment (up to 5 MB)
- Choose who answers: Distinction and HD, or HD only
- Optionally require tutors verified through My eQuals
- Get 2, 3 or 5 answers for a flat credit price
- Keep the question open for 1 hour up to 1 day; unfilled spots are refunded when it closes
- Rate each answer out of 5 stars, or report an unhelpful one for a refund

**For tutors (Tutor profile)**
- Profile with star rating, reviews, and the courses you can tutor
- Transcript scanning finds every course you scored 75+ in
- Claim one question at a time (10-minute hold), then answer it
- Earn $1.10 per answer, or $1.30 if answered within 20 minutes of posting (early bird). Most answers take about 3 minutes, so fast tutors can earn up to $26 an hour
- Weekly bonus and Top Tutor progress

## Pricing (prototype)

1 credit = $1 AUD.

| Answers | Student pays | + HD only | + Verified only |
|---|---|---|---|
| 2 | $3 | +50c | +50c |
| 3 | $4.50 | +50c | +50c |
| 5 | $7.50 | +50c | +50c |

Tutors earn $1.10 per answer, or $1.30 early bird. Unfilled answer spots are refunded when the question closes.

## Run locally

It's a single static page. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

## Deploy on Render

This repo includes a `render.yaml` blueprint for a Render static site.

1. In Render, choose **New → Blueprint** (or **New → Static Site**) and connect this repository.
2. Leave the build command empty and set the publish directory to `.`.
3. Deploy. Every push to `main` redeploys automatically.
