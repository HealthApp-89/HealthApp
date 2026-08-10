-- 0056_set_timing.sql
--
-- Adds per-set timing to exercise_sets:
--   started_at  — true set start: the moment the logger's 5s countdown hit
--                 zero. NOT the START tap (that 5s is the walk-up to the bar).
--   work_seconds— honest time under load: (stop_press - started_at) - 5s.
--
-- The 5s deduction is PHONE_LAG_SECONDS (lib/logger/set-timer.ts): the athlete
-- racks the bar, then picks up the phone, unlocks it, and taps stop. He is
-- already resting during those seconds. Back-dating the set end by 5s makes
-- work time honest AND anchors the rest countdown at the rack rather than the
-- tap — the same fact seen from two sides. Floored at 1s.
--
-- duration_seconds is deliberately NOT reused: lib/coach/derived.ts falls back
-- to it when no e1RM exists and lib/coach/snapshot.ts renders it as "45s hold".
-- Writing rep-set work time there would make the coach report a 38-second
-- decline bench hold. Time-based exercises write both columns (they agree);
-- rep-based sets write only work_seconds.
--
-- Both nullable: hand-logged sets, Strong CSV imports, and all pre-0056 rows
-- stay NULL and every consumer treats NULL as "not timed".

alter table public.exercise_sets add column if not exists started_at timestamptz;
alter table public.exercise_sets add column if not exists work_seconds int;

comment on column public.exercise_sets.started_at is
  'True set start (logger countdown end). NULL for hand-logged sets, Strong CSV imports, and pre-0056 rows.';
comment on column public.exercise_sets.work_seconds is
  'Time under load in seconds: (stop_press - started_at) - 5s phone lag, floored at 1. NULL when the set was not timed.';

-- Re-declare commit_logger_session to persist both. Body is identical to 0053
-- except the exercise_sets INSERT column list and VALUES list.
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
        rest_seconds_actual, rir, started_at, work_seconds
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
        nullif(st->>'work_seconds', '')::int
      );
    end loop;
  end loop;

  return new_workout_id;
end;
$$;

revoke all on function public.commit_logger_session(jsonb) from public;
grant execute on function public.commit_logger_session(jsonb) to authenticated;
