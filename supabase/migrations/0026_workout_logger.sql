-- 0026_workout_logger.sql
--
-- In-app workout logger. Adds:
--   - user_session_templates: per-user persistent "save deviations as my default"
--     layer between training_weeks.exercise_overrides (per-week) and SESSION_PLANS
--     (code default).
--   - exercise_sets.rest_seconds_actual: actual rest taken between commits.
--   - profiles.disable_strong_ingest: opt-out flag mirroring disable_yazio_ingest.
--   - commit_logger_session(jsonb): SECURITY DEFINER atomic 3-table insert.
--
-- See CLAUDE.md "Architecture" section after this migration applies.

-- ── user_session_templates ─────────────────────────────────────────────────
create table if not exists user_session_templates (
  user_id      uuid not null references auth.users on delete cascade,
  session_type text not null,
  exercises    jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, session_type)
);

alter table user_session_templates enable row level security;

drop policy if exists "Users manage their own session templates" on user_session_templates;
create policy "Users manage their own session templates"
  on user_session_templates for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── exercise_sets.rest_seconds_actual ──────────────────────────────────────
alter table exercise_sets add column if not exists rest_seconds_actual int;

-- ── profiles.disable_strong_ingest ─────────────────────────────────────────
alter table profiles add column if not exists disable_strong_ingest boolean not null default false;

-- ── commit_logger_session(payload jsonb) ───────────────────────────────────
--
-- Atomic 3-table insert: workouts + exercises + exercise_sets.
-- Payload shape:
--   {
--     "user_id": "<uuid>",
--     "external_id": "logger-<uuid>",
--     "date": "YYYY-MM-DD",
--     "type": "Chest",
--     "duration_min": 47,
--     "exercises": [
--       {
--         "name": "Decline Bench Press",
--         "position": 0,
--         "sets": [
--           { "set_index": 0, "kg": 40, "reps": 10, "warmup": true,
--             "failure": false, "rest_seconds_actual": null },
--           ...
--         ]
--       },
--       ...
--     ]
--   }
--
-- Returns the new workouts.id.
create or replace function commit_logger_session(payload jsonb)
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
        rest_seconds_actual
      ) values (
        new_exercise_id,
        (st->>'set_index')::int,
        nullif(st->>'kg', '')::numeric,
        nullif(st->>'reps', '')::int,
        nullif(st->>'duration_seconds', '')::int,
        coalesce((st->>'warmup')::boolean, false),
        coalesce((st->>'failure')::boolean, false),
        nullif(st->>'rest_seconds_actual', '')::int
      );
    end loop;
  end loop;

  return new_workout_id;
end;
$$;

revoke all on function commit_logger_session(jsonb) from public;
grant execute on function commit_logger_session(jsonb) to authenticated;
