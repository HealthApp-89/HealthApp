-- 0014_weekly_reviews.sql
-- Weekly review document — sub-project #1 of the coach-as-real-coach arc.
-- See docs/superpowers/specs/2026-05-15-weekly-review-document-design.md

create table public.weekly_reviews (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  week_start                  date not null,
  next_week_start             date not null,
  version                     int  not null default 1,
  status                      text not null check (status in ('draft','committed','superseded'))
                                                    default 'draft',
  block_id                    uuid references public.training_blocks(id),
  payload                     jsonb not null,
  narrative_md                text  not null,
  reconfirm_responses         jsonb not null default '{}'::jsonb,
  committed_at                timestamptz,
  committed_training_week_id  uuid references public.training_weeks(id),
  generated_at                timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_at                  timestamptz not null default now(),
  unique (user_id, week_start, version)
);

create index weekly_reviews_user_week_idx
  on public.weekly_reviews(user_id, week_start desc);
create index weekly_reviews_draft_idx
  on public.weekly_reviews(user_id, status)
  where status = 'draft';

alter table public.weekly_reviews enable row level security;

create policy weekly_reviews_select on public.weekly_reviews
  for select using (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policies: all writes go through service-role endpoints.

-- Extend chat_messages.kind union to include 'weekly_review'.
alter table public.chat_messages
  drop constraint if exists chat_messages_kind_check;
-- NOTE: the existing constraint (set in 0011_morning_brief.sql) uses 'coach'
-- as the default chat-message kind, not 'message'. We preserve the existing
-- values and add 'weekly_review'. Rewriting the union to use 'message' here
-- would violate the constraint against historical 'coach' rows.
alter table public.chat_messages
  add constraint chat_messages_kind_check check (
    kind in ('coach','morning_intake','morning_brief','weekly_review')
  );
