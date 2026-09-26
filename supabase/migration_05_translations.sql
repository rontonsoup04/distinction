-- Migration 5: translation cache (written only by the translate function)
create table if not exists public.translations (
  key        text primary key,          -- sha256 of target language + original text
  target     text not null,
  translated text not null,
  detected   text,
  same       boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.translations enable row level security;
-- no policies: only the server function (service role) reads and writes this table

-- Default preferred language
update public.profiles set answer_language = 'English' where answer_language is null or answer_language = 'Other';
