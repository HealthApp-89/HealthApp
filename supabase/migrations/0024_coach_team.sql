-- 0024_coach_team.sql
--
-- Multi-coach team architecture (sub-project #2 of coach-team arc). Adds:
--   - chat_messages.speaker: who authored the message
--     ('peter', 'carter', 'nora', 'remi', 'user')
--   - chat_messages.kind extended with 'system_routing' (hidden audit rows
--     capturing Peter's routing decision before he delegated to a specialist)
--   - Backfills existing rows: role='user' → speaker='user'; everything else
--     → speaker='peter' (the previous single coach becomes structurally the
--     Head Coach).
--
-- See CLAUDE.md "Coach / AI" section after this migration applies.

-- ── speaker column ────────────────────────────────────────────────────────
alter table chat_messages
  add column speaker text not null default 'peter'
  check (speaker in ('peter', 'carter', 'nora', 'remi', 'user'));

-- Backfill: user messages get 'user'; everything else stays 'peter' (default).
update chat_messages
  set speaker = 'user'
  where role = 'user';

-- ── Extend kind allowlist with 'system_routing' ──────────────────────────
alter table chat_messages
  drop constraint if exists chat_messages_kind_check;
alter table chat_messages
  add constraint chat_messages_kind_check check (
    kind in (
      'coach',
      'morning_intake',
      'morning_brief',
      'weekly_review',
      'proactive_nudge',
      'system_routing'
    )
  );

-- ── Index for filtering visible chat history (excludes system_routing) ──
-- Used by the chat history loader. Partial index since system_routing rows
-- are << visible rows; full index would waste space.
create index chat_messages_visible_idx
  on chat_messages (user_id, created_at desc)
  where kind != 'system_routing';
