-- 0025_per_coach_threads.sql
--
-- Per-coach threading. Adds chat_messages.thread (peter|carter|nora|remi).
-- Every message belongs to exactly one thread; this is the conversation lane
-- a user is in when they tap a coach page. Assistant turns get their speaker's
-- thread; user turns inherit from the adjacent assistant turn (best-effort
-- backfill).
--
-- The earlier chat_messages.speaker column (migration 0024) stays — speaker
-- identifies WHO authored a message; thread identifies WHICH conversation it
-- belongs to. For assistant rows the two are equal; for user rows speaker='user'
-- but thread is one of the four coaches.
--
-- See spec: docs/superpowers/specs/2026-05-20-coach-mini-apps-restructure-design.md

alter table chat_messages
  add column thread text not null default 'peter';

alter table chat_messages
  add constraint chat_messages_thread_check
  check (thread in ('peter','carter','nora','remi'));

-- Assistant rows: thread mirrors speaker.
update chat_messages
   set thread = speaker
 where speaker in ('peter','carter','nora','remi');

-- User rows: inherit thread from the next assistant row in the same user's
-- timeline, or the previous one if there is no later one, or 'peter' as a
-- final fallback. Best-effort — historical conversations stay readable.
with user_turns as (
  select id, user_id, created_at
    from chat_messages
   where speaker = 'user'
),
inferred as (
  select u.id,
         coalesce(
           (select cm.thread
              from chat_messages cm
             where cm.user_id = u.user_id
               and cm.speaker in ('peter','carter','nora','remi')
               and cm.created_at > u.created_at
             order by cm.created_at asc
             limit 1),
           (select cm.thread
              from chat_messages cm
             where cm.user_id = u.user_id
               and cm.speaker in ('peter','carter','nora','remi')
               and cm.created_at < u.created_at
             order by cm.created_at desc
             limit 1),
           'peter'
         ) as inferred_thread
    from user_turns u
)
update chat_messages cm
   set thread = i.inferred_thread
  from inferred i
 where cm.id = i.id;

create index chat_messages_thread_idx
  on chat_messages (user_id, thread, created_at desc);
