-- supabase/migrations/0038_nora_suggestion_engine.sql
-- Nora suggestion engine: structured dietary exclusions + cached 90d eating identity rollup.

alter table profiles
  add column if not exists dietary_exclusions jsonb not null
    default '{"tags": [], "free_text": null, "version": 1}'::jsonb,
  add column if not exists eating_identity_cache jsonb;

comment on column profiles.dietary_exclusions is
  'Structured hard-NO list for Nora suggestion engine. Shape: { tags: ExclusionTag[], free_text: string|null, version: 1 }. Tags drive deterministic filter; free_text is advisory for Nora prose.';

comment on column profiles.eating_identity_cache is
  '90d log rollup for Nora suggestion engine. Shape: EatingIdentity (see lib/data/types.ts). Cron-populated at 03:30 UTC daily. NULL = first-run user, not yet synced.';
