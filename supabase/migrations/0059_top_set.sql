-- 0059_top_set.sql
--
-- Marks a set as the exercise's HEAVY TOP SET: a single lower-rep, higher-load
-- effort performed before the working sets, on a block's focus lift only.
--
-- This has to be a stored column rather than something a reader infers,
-- because the whole engine reads working load as "max kg across clean
-- non-warmup sets" (lib/coach/prescription/maintenance-baseline.ts). Log a
-- 72.5 kg top set beside 60 kg back-offs without a discriminator and that
-- 72.5 silently becomes next week's working load — the back-offs ratchet up to
-- the top-set weight and the scheme eats itself in two cycles.
--
-- It is the same argument that makes `warmup` a column. A warmup is lighter,
-- so a max() would ignore it anyway; a top set is HEAVIER, so it dominates
-- every max() in the engine. Inference is not available: nothing in
-- (kg, reps, rir, set_index) distinguishes a deliberate 5-rep top set from an
-- ordinary heavy working set.
--
-- The asymmetry consumers must honour, and it is deliberate:
--   EXCLUDE top sets from working-LOAD baselines — maintenanceLoadFor,
--     double-progression, lastWeekClean / consecutiveMisses.
--   INCLUDE them in e1RM comparison — at ~85% of e1RM the reps returned are
--     the single best e1RM estimate of the week, and re-estimating the target
--     from them is the point of prescribing it.
--
-- false for every hand-logged set, every Strong CSV import and all pre-0059
-- rows. No backfill: top sets were never prescribed before this migration, so
-- there are none to find.

alter table public.exercise_sets
  add column if not exists is_top_set boolean not null default false;

comment on column public.exercise_sets.is_top_set is
  'True when this set is the exercise''s heavy top set (lower reps, ~85% of e1RM, focus lift only), performed before the working sets. MUST be excluded from working-load baselines (maintenance-baseline.ts, double-progression) or it becomes next week''s working load, and MUST be included in e1RM comparison, where it is the best data point of the week. false for Strong imports, hand-logged sets and all pre-0059 rows.';

-- Re-declare commit_logger_session to persist it. Body is identical to 0057
-- except the exercise_sets INSERT column list and VALUES list — this file is
-- now the canonical definition of the function.
create or replace function public.commit_logger_session(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payload_user_id uuid;
  new_workout_id  uuid;
  ex              jsonb;
  st              jsonb;
  new_exercise_id uuid;
begin
  payload_user_id := (payload->>'user_id')::uuid;

  -- Defence: caller must match the authenticated user.
  if auth.uid() is null or auth.uid() <> payload_user_id then
    raise exception 'commit_logger_session: auth.uid() mismatch';
  end if;

  -- Defensive shape checks.
  if jsonb_array_length(payload->'exercises') > 30 then
    raise exception 'commit_logger_session: too many exercises (>30)';
  end if;

  -- workouts row.
  insert into workouts (
    user_id, external_id, date, type, duration_min, started_at, source, created_at
  ) values (
    payload_user_id,
    payload->>'external_id',
    (payload->>'date')::date,
    payload->>'type',
    nullif(payload->>'duration_min', '')::int,
    nullif(payload->>'started_at', '')::timestamptz,
    'logger',
    now()
  )
  on conflict (user_id, external_id) where external_id is not null do update
    set type = excluded.type,
        duration_min = excluded.duration_min,
        started_at = excluded.started_at
  returning id into new_workout_id;

  -- Clear any pre-existing exercises for this workout (idempotent retry).
  delete from exercises where workout_id = new_workout_id;

  -- Exercises + sets.
  for ex in select * from jsonb_array_elements(payload->'exercises') loop
    if jsonb_array_length(ex->'sets') > 30 then
      raise exception 'commit_logger_session: too many sets for one exercise (>30)';
    end if;

    insert into exercises (workout_id, name, position, superset_group)
    values (
      new_workout_id,
      ex->>'name',
      (ex->>'position')::int,
      nullif(ex->>'superset_group', '')
    )
    returning id into new_exercise_id;

    for st in select * from jsonb_array_elements(ex->'sets') loop
      insert into exercise_sets (
        exercise_id, set_index, kg, reps, duration_seconds, warmup, failure,
        rest_seconds_actual, rir, started_at, work_seconds, is_top_set
      ) values (
        new_exercise_id,
        (st->>'set_index')::int,
        nullif(st->>'kg', '')::numeric,
        nullif(st->>'reps', '')::int,
        nullif(st->>'duration_seconds', '')::int,
        coalesce((st->>'warmup')::boolean, false),
        coalesce((st->>'failure')::boolean, false),
        nullif(st->>'rest_seconds_actual', '')::int,
        nullif(st->>'rir', '')::smallint,
        nullif(st->>'started_at', '')::timestamptz,
        nullif(st->>'work_seconds', '')::int,
        coalesce((st->>'is_top_set')::boolean, false)
      );
    end loop;
  end loop;

  return new_workout_id;
end;
$$;

revoke all on function public.commit_logger_session(jsonb) from public;
grant execute on function public.commit_logger_session(jsonb) to authenticated;
