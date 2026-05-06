-- 0006_chat_settings.sql — editable coach system prompt + tool-call observability
-- Apply via Supabase Dashboard → SQL Editor (matches 0002–0005 convention).

alter table public.profiles
  add column if not exists system_prompt text;

alter table public.chat_messages
  add column if not exists tool_calls jsonb;

comment on column public.profiles.system_prompt is
  'User-edited coach prompt. NULL = use the code-side default (lib/coach/system-prompts.ts:DEFAULT_SYSTEM_PROMPT).';

comment on column public.chat_messages.tool_calls is
  'Array of tool calls executed for this assistant message: [{name, input, ms, result_rows, range_days, truncated, error}]. NULL on user messages or assistant messages with no tool use.';
