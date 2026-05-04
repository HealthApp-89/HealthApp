-- 0005_chat.sql — AI coach chat: messages, images, RPC, Storage RLS
-- Apply via Supabase Dashboard → SQL Editor.
-- PRECONDITION: create the `chat-images` Storage bucket (private) before applying
-- this migration, otherwise the storage.objects policies are no-ops on the bucket.

-- ── chat_messages: one row per turn ──────────────────────────────────────────
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null default '',
  status text not null default 'done'
    check (status in ('streaming','done','error')),
  error text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'error' or error is not null)
);

create index if not exists chat_messages_user_created_idx
  on public.chat_messages (user_id, created_at desc);

-- One in-flight stream per user; second concurrent insert returns 23505 → 409.
create unique index if not exists chat_messages_one_streaming_per_user
  on public.chat_messages (user_id) where status = 'streaming';

-- ── chat_message_images: 0..N images per user message ────────────────────────
create table if not exists public.chat_message_images (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.chat_messages on delete cascade,
  storage_path text not null,
  mime text not null,
  bytes int not null,
  width int,
  height int,
  created_at timestamptz not null default now()
);

create index if not exists chat_message_images_msg_idx
  on public.chat_message_images (message_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.chat_messages       enable row level security;
alter table public.chat_message_images enable row level security;

drop policy if exists "chat_messages self" on public.chat_messages;
create policy "chat_messages self" on public.chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Join-through to chat_messages (matches `exercises` pattern in schema.sql).
-- Note: rows with message_id IS NULL are NOT readable/writable from the user
-- client. That's intentional — unattached images are server-managed only.
drop policy if exists "chat_message_images self" on public.chat_message_images;
create policy "chat_message_images self" on public.chat_message_images
  for all using (exists (
    select 1 from public.chat_messages m
    where m.id = chat_message_images.message_id and m.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.chat_messages m
    where m.id = chat_message_images.message_id and m.user_id = auth.uid()
  ));

-- ── Storage RLS (on storage.objects) ─────────────────────────────────────────
drop policy if exists "chat-images self read" on storage.objects;
create policy "chat-images self read" on storage.objects
  for select using (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "chat-images self write" on storage.objects;
create policy "chat-images self write" on storage.objects
  for insert with check (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "chat-images self delete" on storage.objects;
create policy "chat-images self delete" on storage.objects
  for delete using (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Atomic three-write RPC ───────────────────────────────────────────────────
-- Inserts the user message, attaches images (if any), and inserts the
-- assistant stub. Runs as security definer to bypass RLS on the
-- unattached-image UPDATE. The 23505 from the partial unique index on
-- streaming rows propagates to the caller as a Postgres error.
--
-- TRUST BOUNDARY: caller (service-role Route Handler) MUST pass the verified
-- auth.getUser().id as p_user_id. This function does not (and cannot) validate
-- p_user_id against auth.uid() — auth.uid() is null under the service role.
--
-- updated_at: this repo has no trigger pattern. All UPDATEs to chat_messages
-- (e.g. when finalising the assistant stub) MUST set updated_at = now()
-- explicitly in the application layer.
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
  insert into public.chat_messages (user_id, role, content, status)
    values (p_user_id, 'user', p_content, 'done')
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

  insert into public.chat_messages (user_id, role, content, status, model)
    values (p_user_id, 'assistant', '', 'streaming', p_model)
    returning id into v_asst_id;

  return query select v_user_id, v_asst_id;
end $$;

-- Allow the service-role client to call the RPC.
grant execute on function public.chat_send_user_message(uuid, text, uuid[], text)
  to service_role;
