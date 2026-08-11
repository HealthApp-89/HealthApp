-- 0057_superset_group.sql
--
-- Records that an exercise was performed as part of a superset — two or more
-- exercises back-to-back with rest only after the last.
--
-- Two facts about a grouped exercise's stored numbers that no consumer can
-- reconstruct without this column:
--
--   1. work_seconds is a SPLIT, not a measurement. One START/STOP covers the
--      whole round (interrupting it would defeat the technique), so the round's
--      work time is divided evenly between its members after deducting the
--      phone lag and one 5s transition allowance per hand-off. The round total
--      is exact; the per-member share is an estimate.
--   2. rest_seconds_actual is INFLATED. It is derived from the previous set of
--      the SAME exercise, so a grouped exercise's recorded rest silently
--      contains the other member's work — it reads longer than the true rest
--      between rounds.
--   3. started_at on every member after the first is DERIVED, not measured:
--      it is the round start plus the earlier members' shares plus one 5s
--      transition allowance per hand-off, not a timer reading.
--
-- NULL for every exercise performed alone, every Strong CSV import, and all
-- pre-0057 rows. No backfill is possible: the grouping was never recorded.

alter table public.exercises add column if not exists superset_group text;

comment on column public.exercises.superset_group is
  'Superset tag ("A"/"B"/"C") when this exercise was performed back-to-back with its neighbours. NULL = performed alone. When set: work_seconds is an even split of the round rather than a measurement, rest_seconds_actual includes the other members'' work, and started_at on every member after the first is derived from the split rather than measured. NULL for Strong imports and pre-0057 rows.';

-- Re-declare commit_logger_session to persist it. Body is identical to 0056
-- except the exercises INSERT column list and VALUES list.
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

  if auth.uid() is null or auth.uid() <> payload_user_id then
    raise exception 'commit_logger_session: auth.uid() mismatch';
  end if;

  if jsonb_array_length(payload->'exercises') > 30 then
    raise exception 'commit_logger_session: too many exercises (>30)';
  end if;

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

  delete from exercises where workout_id = new_workout_id;

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
