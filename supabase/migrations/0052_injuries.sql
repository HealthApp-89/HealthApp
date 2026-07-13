-- Migration 0052: Injury lifecycle foundation
-- Injury tracking for live-reported injuries (chat) + form fallback (/health tab)
-- See spec: docs/superpowers/specs/2026-07-13-injury-lifecycle-design.md

create table if not exists injuries (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  area                   text not null,             -- "hip", "shoulder", free-form but short
  side                   text,                      -- "left" | "right" | null
  cause                  text,                      -- "padel", "deadlift top set", free-form
  severity               text not null default 'moderate',
  onset_date             date not null,             -- backdatable
  status                 text not null default 'active',
  resolved_at            timestamptz,
  affected_session_types text[] not null default '{}',  -- e.g. {Legs, Back}
  affected_lifts         text[] not null default '{}',  -- subset of {squat,bench,deadlift,ohp}
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint injuries_severity_check check (severity in ('mild','moderate','severe')),
  constraint injuries_status_check   check (status in ('active','resolved'))
);

-- Index for the active-injury query (user_id + status)
create index injuries_user_status_idx on injuries (user_id, status);

-- RLS: owner select/insert/update (no delete — resolve, don't erase history)
alter table injuries enable row level security;

create policy injuries_select_own on injuries for select
  using (auth.uid() = user_id);

create policy injuries_insert_own on injuries for insert
  with check (auth.uid() = user_id);

create policy injuries_update_own on injuries for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
