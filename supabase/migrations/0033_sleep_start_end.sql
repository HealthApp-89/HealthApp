-- supabase/migrations/0033_sleep_start_end.sql
--
-- WHOOP sleep API already returns onset/offset times per sleep record
-- (lib/whoop.ts WhoopSleep.start / .end). Surfacing them on daily_logs
-- so the bedtime-drift trigger and consistency card have backing data.
-- Both columns are nullable: existing rows stay null until backfill runs.

alter table daily_logs
  add column if not exists sleep_start_at timestamptz,
  add column if not exists sleep_end_at   timestamptz;

comment on column daily_logs.sleep_start_at is 'WHOOP-sourced sleep onset timestamp (UTC). Populated by buildWhoopDayRows.';
comment on column daily_logs.sleep_end_at   is 'WHOOP-sourced sleep offset timestamp (UTC). Populated by buildWhoopDayRows.';
