-- 0042_profile_timezone.sql
-- Adds per-user timezone as the authoritative source for "today"
-- computations. Replaces the USER_TIMEZONE env var (now fallback-only
-- for backfill scripts).

alter table public.profiles
  add column if not exists timezone text not null default 'Asia/Dubai';

comment on column public.profiles.timezone is
  'IANA timezone (Intl.supportedValuesOf("timeZone")). Authoritative for all "today" / week-boundary / day-attribution logic. The USER_TIMEZONE env var is fallback-only for scripts.';
