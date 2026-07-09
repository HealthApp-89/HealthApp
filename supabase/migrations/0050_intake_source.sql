-- 0050_intake_source.sql
--
-- One-tap morning check-in (spec 2026-07-10): provenance marker for how the
-- day's checkin row was reported. Used by the defaults engine to exclude
-- one-tap ('all_good') days from the personal-baseline median/mode — without
-- this exclusion, defaults would feed the median that feeds the defaults.
--
-- NULL (all historical rows) counts as explicitly answered.
-- 'legacy_chips' is reserved for completeness; new writes use 'all_good'/'form'.

alter table checkins add column intake_source text
  check (intake_source is null or intake_source in ('legacy_chips','all_good','form'));

comment on column checkins.intake_source is
  'How the row was reported: all_good = one-tap defaults, form = adjusted form, legacy_chips = pre-0050 sequential chat. NULL = historical (counts as explicit for defaults).';
