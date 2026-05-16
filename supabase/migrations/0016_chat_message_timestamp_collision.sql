-- supabase/migrations/0016_chat_message_timestamp_collision.sql
--
-- Fix: user/assistant chat_messages rows inserted by chat_send_user_message
-- collided on created_at to the microsecond, because Postgres `now()` returns
-- transaction-start time (constant within a single RPC call). When the chat
-- feed sorted by created_at without a deterministic tiebreaker, Postgres
-- returned the two rows in an arbitrary order. After the client's reverse
-- (DESC fetch → ASC render), the user's message sometimes appeared BELOW the
-- assistant reply it preceded — a recurring visual ordering bug.
--
-- Two changes:
--   (A) Recreate chat_send_user_message to use clock_timestamp() for both
--       inserts. clock_timestamp() advances between calls, so user and
--       assistant rows get distinct microsecond-resolution timestamps.
--   (B) One-time retro cleanup: every existing user/assistant pair with
--       identical created_at gets the assistant shifted forward by 1
--       microsecond. Restores visual ordering for the existing thread.

-- ── (A) Replace the RPC ─────────────────────────────────────────────────────

create or replace function public.chat_send_user_message(
  p_user_id uuid,
  p_content text,
  p_image_ids uuid[],
  p_model text
) returns table (user_message_id uuid, assistant_message_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_asst_id uuid;
begin
  -- clock_timestamp() (wall-clock now) rather than the table default now()
  -- so the two inserts in this function get distinct timestamps. The chat
  -- feed sorts by created_at; identical values made the user/assistant
  -- order non-deterministic.
  insert into public.chat_messages (user_id, role, content, status, created_at)
    values (p_user_id, 'user', p_content, 'done', clock_timestamp())
    returning id into v_user_id;

  if p_image_ids is not null and array_length(p_image_ids, 1) > 0 then
    -- Defense-in-depth: only attach images whose storage_path is under the
    -- caller's user_id prefix. The API layer already validates this, but
    -- enforcing it here closes the latent privilege-escalation path.
    update public.chat_message_images
       set message_id = v_user_id
     where id = any(p_image_ids)
       and message_id is null
       and storage_path like p_user_id::text || '/%';
  end if;

  insert into public.chat_messages (user_id, role, content, status, model, created_at)
    values (p_user_id, 'assistant', '', 'streaming', p_model, clock_timestamp())
    returning id into v_asst_id;

  return query select v_user_id, v_asst_id;
end $$;

-- ── (B) Retroactive cleanup ─────────────────────────────────────────────────

-- Pair every user message with the assistant message inserted in the same
-- RPC call (same user, same created_at). Shift the assistant forward by 1µs
-- so the pair becomes orderable. Doesn't touch updated_at (the existing
-- rows have their original updated_at preserved).

with collisions as (
  select a.id as assistant_id, a.created_at
  from public.chat_messages a
  join public.chat_messages u
    on u.user_id = a.user_id
   and u.role = 'user'
   and a.role = 'assistant'
   and u.created_at = a.created_at
)
update public.chat_messages cm
   set created_at = cm.created_at + interval '1 microsecond'
  from collisions c
 where cm.id = c.assistant_id;
