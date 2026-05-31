-- 0041_target_value_semantics.sql
--
-- Documents the semantics of training_blocks.target_value + target_metric and
-- adds a CHECK ensuring active blocks with a primary lift carry a metric.
-- See lib/coach/e1rm.ts for the Brzycki conversion used when target_metric =
-- 'e1rm'. See lib/coach/prescription/target-hit-evaluator.ts +
-- lib/coach/block-outcomes/evaluator.ts for the comparison sites.
--
-- Pre-0041 active blocks with primary_lift set but target_metric NULL are
-- treated as 'working_weight' (the legacy behavior) — kept as the implicit
-- default in code so this migration doesn't require a manual backfill.
-- The CHECK only enforces consistency on rows inserted from now on; existing
-- rows are grandfathered via the NOT VALID clause.

comment on column public.training_blocks.target_value is
  'Block-target value in kg. The metric (e1RM vs raw working weight) is determined by target_metric. For target_metric=''e1rm'', target_value is compared against the max Brzycki e1RM of the primary lift''s non-warmup sets in the 1..12 rep window. For target_metric=''working_weight'', against the max raw kg. NULL when the block has no primary_lift target.';

comment on column public.training_blocks.target_metric is
  'Which value to compare against target_value: ''e1rm'' (Brzycki) or ''working_weight''. NULL on legacy rows; readers default to ''working_weight'' to preserve pre-0041 semantics. Code reference: lib/coach/e1rm.ts:bestComparisonValue.';

-- Belt-and-braces: future inserts where primary_lift + target_value are set
-- must declare a target_metric explicitly. Existing rows are not validated
-- (NOT VALID) so the migration is non-blocking; once backfilled, a separate
-- statement can VALIDATE the constraint.
alter table public.training_blocks
  add constraint training_blocks_target_metric_required
  check (
    primary_lift is null
    or target_value is null
    or target_metric is not null
  )
  not valid;
