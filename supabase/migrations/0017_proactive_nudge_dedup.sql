-- 0017_proactive_nudge_dedup.sql
--
-- Replaces the prior "scan chat_messages.ui->>trigger_key within 7 days"
-- dedup with a dedicated table. The chat-messages-based check was fragile:
-- if the user dismissed/deleted a nudge row, the next cron run re-fired the
-- same trigger because the dedup signal was gone with the row. The audit
-- trail of why a nudge was suppressed also lived nowhere — only what fired.
--
-- proactive_nudge_dedup is the source of truth for "this trigger has fired
-- recently." Inserted atomically with the chat_messages row by the cron's
-- orchestrator (lib/coach/proactive/index.ts).

create table if not exists public.proactive_nudge_dedup (
  user_id uuid not null references auth.users on delete cascade,
  trigger_key text not null,
  fired_on date not null,
  fired_at timestamptz not null default now(),
  chat_message_id uuid references public.chat_messages on delete set null,
  primary key (user_id, trigger_key, fired_on)
);

create index if not exists proactive_nudge_dedup_user_recent_idx
  on public.proactive_nudge_dedup (user_id, fired_at desc);

alter table public.proactive_nudge_dedup enable row level security;

create policy "proactive_nudge_dedup self read"
  on public.proactive_nudge_dedup
  for select using (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policy: writes go through the cron via service role.

comment on table public.proactive_nudge_dedup is
  'Source of truth for "trigger fired in the last 7 days." Cron checks here, not chat_messages, so deleting a nudge row does NOT reset the dedup window. fired_on is the user-tz date the trigger fired; (user_id, trigger_key, fired_on) is unique so a same-day re-fire is silently absorbed.';
