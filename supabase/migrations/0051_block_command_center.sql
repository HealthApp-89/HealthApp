-- 0051_block_command_center.sql
-- Block Command Center arc (spec 2026-07-13):
--   narrative_md            — Carter-voiced outcome paragraph, written once at close
--   manual_session_edits    — athlete week-scope per-exercise edits (merge layer ABOVE session_prescriptions)
--   session_structure_overrides — athlete block-scope structure prefs (order + set counts), consumed by prescribeWeek

alter table public.block_outcomes
  add column if not exists narrative_md text;

comment on column public.block_outcomes.narrative_md is
  'AI-written performance paragraph (Carter voice), generated once at block close. Deterministic fallback text on LLM failure — never NULL for rows closed after migration 0051.';

alter table public.training_weeks
  add column if not exists manual_session_edits jsonb;

comment on column public.training_weeks.manual_session_edits is
  'Athlete-owned week-scope edits keyed by WeekdayLong: { order?: string[], exercises?: { [name]: { sets?, kg?, reps? } } }. Merges at the TOP of the session resolution chain; survives engine repatches of session_prescriptions. NULL = no manual edits.';

alter table public.training_blocks
  add column if not exists session_structure_overrides jsonb;

comment on column public.training_blocks.session_structure_overrides is
  'Athlete-owned block-scope structure prefs keyed by session_type: { order?: string[], sets?: { [name]: number } }. Consumed by prescribeWeek for every week of the block; loads/reps stay engine-evolved. NULL = engine defaults.';
