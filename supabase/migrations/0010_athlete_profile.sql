-- 0010_athlete_profile.sql — athlete profile phase 1
--
-- One new table (athlete_profile_documents). Captures a durable, versioned,
-- user-acknowledged athlete profile (medical, training history, equipment,
-- lifestyle, nutrition baseline, sleep baseline, goal-with-why). Phase 1
-- writes intake_payload + rendered_md only; plan_payload is reserved-null
-- and populated by Phase 2 when AI plan generation lands.

create table if not exists public.athlete_profile_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  version         int not null,
  status          text not null default 'draft'
    check (status in ('draft', 'active', 'superseded', 'discarded')),
  intake_payload  jsonb not null,
  plan_payload    jsonb,
  rendered_md     text,
  acknowledged_at timestamptz,
  superseded_at   timestamptz,
  superseded_by   uuid references public.athlete_profile_documents on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  check ((acknowledged_at is null) = (status in ('draft', 'discarded'))),
  check ((status = 'superseded') = (superseded_at is not null)),
  unique (user_id, version)
);

-- At most one active per user
create unique index if not exists athlete_profile_documents_one_active_per_user
  on public.athlete_profile_documents (user_id) where status = 'active';

-- At most one draft per user
create unique index if not exists athlete_profile_documents_one_draft_per_user
  on public.athlete_profile_documents (user_id) where status = 'draft';

-- Common reads: history list ordered by version desc
create index if not exists athlete_profile_documents_user_status_version_idx
  on public.athlete_profile_documents (user_id, status, version desc);

alter table public.athlete_profile_documents enable row level security;

drop policy if exists "athlete_profile_documents self" on public.athlete_profile_documents;
create policy "athlete_profile_documents self"
  on public.athlete_profile_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Comments (load-bearing context for future contributors) ──────────────────
comment on column public.athlete_profile_documents.plan_payload is
  'NULL in Phase 1 (intake-only). Phase 2 populates with structured plan from AI generation. Forward-compatible nullable column avoids ALTER between phases.';

comment on column public.athlete_profile_documents.rendered_md is
  'Frozen markdown rendered from intake_payload at acknowledgment time (Phase 1) or from intake+plan in Phase 2. Byte-stable for the lifetime of the version — never regenerated. The artifact the user signs.';

comment on column public.athlete_profile_documents.status is
  'Lifecycle: draft (in progress) → active (acknowledged) → superseded (replaced by newer version) | discarded (manually abandoned). One active and one draft maximum per user (partial unique indexes).';

comment on column public.athlete_profile_documents.version is
  'Monotonically increasing per user, enforced by code at insert time. Each acknowledgment commits a new version.';
