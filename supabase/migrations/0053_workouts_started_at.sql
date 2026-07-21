-- 0053_workouts_started_at.sql
--
-- Adds workouts.started_at — session start wall-clock as recorded by the
-- in-app logger. Anchors time-of-day analysis (training at 1pm vs 6pm,
-- pre/post-workout fueling joins against food_log_entries.eaten_at).
--
-- Semantics: the logger draft stamps started_at when the sheet first opens
-- with no existing draft, and re-stamps it on reset. Pause/resume and
-- close-and-reopen preserve it — so at commit time the value is "the latest
-- Start Session tap for this in-flight draft". Editing a saved workout
-- preserves the original started_at (hydrateWorkoutAsDraft carries it via
-- LoggerDraft.session_started_at, same pattern as duration_min).
--
-- Nullable: pre-0053 logger rows and CSV-imported Strong rows stay NULL —
-- no reliable backfill (created_at is commit-tap time, not session start).
--
-- (Revives commit 8cd3ee8 from May 2026, renumbered: its 0031 slot was taken
-- by 0031_meal_log_draft_tag on main before it merged.)

alter table public.workouts add column if not exists started_at timestamptz;

comment on column public.workouts.started_at is
  'Session start wall-clock from the in-app logger (latest Start Session tap). Nullable: pre-0053 rows and Strong CSV imports have no reliable start time.';

-- Re-declare commit_logger_session to persist started_at. Body is identical
-- to 0045 except the workouts INSERT (and its ON CONFLICT update) now reads
-- payload->>'started_at'.
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

    insert into exercises (workout_id, name, position)
    values (
      new_workout_id,
      ex->>'name',
      (ex->>'position')::int
    )
    returning id into new_exercise_id;

    for st in select * from jsonb_array_elements(ex->'sets') loop
      insert into exercise_sets (
        exercise_id, set_index, kg, reps, duration_seconds, warmup, failure,
        rest_seconds_actual, rir
      ) values (
        new_exercise_id,
        (st->>'set_index')::int,
        nullif(st->>'kg', '')::numeric,
        nullif(st->>'reps', '')::int,
        nullif(st->>'duration_seconds', '')::int,
        coalesce((st->>'warmup')::boolean, false),
        coalesce((st->>'failure')::boolean, false),
        nullif(st->>'rest_seconds_actual', '')::int,
        nullif(st->>'rir', '')::smallint
      );
    end loop;
  end loop;

  return new_workout_id;
end;
$$;

revoke all on function public.commit_logger_session(jsonb) from public;
grant execute on function public.commit_logger_session(jsonb) to authenticated;
