-- supabase/migrations/0031_meal_log_draft_tag.sql
-- Tag every meal_log chat_message with the draft food_log_entry it belongs
-- to, so the post-commit / post-cancel cleanup can delete by tag instead of
-- by fuzzy time-bounds. Tag-only (no FK) because the draft entry is
-- hard-deleted on cancel and we want the cascade to happen explicitly via
-- our DELETE query, not via a referential trigger we forget about.
--
-- Migration order is documented in the design spec:
--   docs/superpowers/specs/2026-05-23-diet-redesign-and-ephemeral-meal-chat-design.md

alter table public.chat_messages
  add column if not exists draft_entry_id uuid;

-- Hot path for the post-commit / post-cancel DELETE. Partial because
-- draft_entry_id is NULL for every non-meal_log row.
create index if not exists chat_messages_draft_entry_idx
  on public.chat_messages (user_id, draft_entry_id)
  where draft_entry_id is not null;

-- ── One-shot historical cleanup ───────────────────────────────────────────
-- Retroactively remove the meal_log clutter the user is complaining about
-- today: chat rows whose draft entry is already committed. Best-effort for
-- text-bubble rows (no ui column to join through), so we use same-day
-- proximity. Blast radius is bounded to kind='meal_log'.
delete from public.chat_messages cm
  where cm.kind = 'meal_log'
    and (
      -- Preview/committed rows: drop if entry exists and is committed.
      exists (
        select 1
        from public.food_log_entries fle
        where fle.id = (cm.ui->>'entry_id')::uuid
          and fle.status = 'committed'
      )
      -- Plain text rows (no ui.entry_id): drop if any committed entry
      -- exists on the same date for this user.
      or (
        cm.ui is null
        and exists (
          select 1
          from public.food_log_entries x
          where x.user_id = cm.user_id
            and x.status = 'committed'
            and date(x.eaten_at) = date(cm.created_at)
        )
      )
    );
