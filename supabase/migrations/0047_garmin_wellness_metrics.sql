-- 0047_garmin_wellness_metrics.sql
-- Garmin Body Battery + Stress: single-owner Garmin daily metrics.
-- Body Battery low/peak already exist on garmin_daily (0046); add stress there,
-- and add all five to daily_logs (the app's read surface).

alter table garmin_daily
  add column if not exists stress_avg int,
  add column if not exists stress_max int,
  add column if not exists stress_qualifier text;

alter table daily_logs
  add column if not exists body_battery_low int,
  add column if not exists body_battery_peak int,
  add column if not exists stress_avg int,
  add column if not exists stress_max int,
  add column if not exists stress_qualifier text;
