-- 0034_peter_dashboard.sql
-- Versioned cache for Peter's head-coach dashboard payload.
-- Daily cron writes v1; manual regen bumps version. Both the /coach
-- dashboard UI and Peter's chat-prompt assembly read the latest row.
--
-- Note: the spec/plan labelled this migration 0031 but slots 0031-0033
-- were claimed by parallel arcs (meal_log_draft_tag, workout_debrief,
-- sleep_start_end) before this branch merged. Bumped to 0034 (and the
-- companion goal-structured migration to 0035) following the same
-- numbering-jump convention documented in 0028.

create table coach_dashboards (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  generated_on  date not null,
  version       int  not null default 1,
  status        text not null default 'ready'
    check (status in ('ready', 'failed')),
  payload       jsonb not null,
  narrative_md  text  not null,
  generated_at  timestamptz not null default now(),
  unique (user_id, generated_on, version)
);

create index coach_dashboards_user_recent_idx
  on coach_dashboards (user_id, generated_on desc, version desc);

alter table coach_dashboards enable row level security;

-- Owner-only read; writes via service-role (cron + regenerate endpoint).
create policy coach_dashboards_select_own
  on coach_dashboards for select
  using (auth.uid() = user_id);
