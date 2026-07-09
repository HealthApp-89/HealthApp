-- 0026_symptom_log.sql
--
-- Adds `symptom_log_entries` table for the manual symptom journal on
-- /health?tab=log. Distinct from `checkins` (the structured morning intake
-- with daily granularity) — symptom log entries are timestamp-granular
-- free-text notes the user can add anytime they notice something off,
-- tagged by category (sickness | injury | soreness | other).
--
-- See spec: docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md

create table if not exists symptom_log_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null,
  notes        text not null,
  created_at   timestamptz not null default now(),
  constraint symptom_log_entries_kind_check
    check (kind in ('sickness', 'injury', 'soreness', 'other')),
  constraint symptom_log_entries_notes_nonempty
    check (length(trim(notes)) > 0)
);

create index symptom_log_entries_user_created_idx
  on symptom_log_entries (user_id, created_at desc);

alter table symptom_log_entries enable row level security;

create policy "symptom_log_entries_owner_select"
  on symptom_log_entries
  for select
  using (auth.uid() = user_id);

create policy "symptom_log_entries_owner_insert"
  on symptom_log_entries
  for insert
  with check (auth.uid() = user_id);

create policy "symptom_log_entries_owner_delete"
  on symptom_log_entries
  for delete
  using (auth.uid() = user_id);
