-- 0045_per_set_rir.sql
-- Adds reps-in-reserve capture per set. Nullable: null = not recorded (legacy
-- rows + any set the athlete skips). Lights up the effort-aware debrief
-- comparison and the previously-phantom RIR autoregulation signal.

alter table public.exercise_sets
  add column if not exists rir smallint
  check (rir is null or (rir >= 0 and rir <= 10));

comment on column public.exercise_sets.rir is
  'Reps in reserve for this set (0 = to failure). Nullable: null = not recorded. Effort signal for effort-adjusted e1RM in the workout debrief.';

-- Re-declare commit_logger_session to persist rir. Body is identical to
-- 0026 except the exercise_sets INSERT now reads st->>'rir'.
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
    user_id, external_id, date, type, duration_min, source, created_at
  ) values (
    payload_user_id,
    payload->>'external_id',
    (payload->>'date')::date,
    payload->>'type',
    nullif(payload->>'duration_min', '')::int,
    'logger',
    now()
  )
  on conflict (user_id, external_id) where external_id is not null do update
    set type = excluded.type,
        duration_min = excluded.duration_min
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
