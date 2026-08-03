-- 0054_volume_signals.sql
--
-- Frequency signals emitted by the prescription engine when a below-MEV set
-- bump was SUPPRESSED because prior bumps were prescribed but not performed.
-- The engine stops re-issuing a futile +1 and records why, so Carter can
-- recommend the real fix (another weekly exposure) instead of more sets.
--
-- Nullable: null on pre-0054 rows and on any week with no suppression.

alter table public.training_weeks
  add column if not exists volume_signals jsonb;

comment on column public.training_weeks.volume_signals is
  'VolumeFrequencySignal[] — per-muscle records of a below-MEV set bump withheld because prior bumps were not performed. Null when no suppression occurred. Read by the Carter prompt block (lib/coach/carter-context/volume-signals.ts).';
