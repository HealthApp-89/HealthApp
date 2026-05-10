-- 0009_body_measurements.sql
--
-- Adds the `body_measurements` table for monthly circumference capture
-- (Health tab). Photos are stored in the `health-photos` private bucket;
-- the bucket MUST exist before this migration runs (see CLAUDE.md
-- "Database migrations" section).

create table public.body_measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  measured_on date not null,

  neck_cm                 numeric(5,1),
  left_upper_arm_cm       numeric(5,1),
  right_upper_arm_cm      numeric(5,1),
  chest_cm                numeric(5,1),
  high_waist_cm           numeric(5,1),
  mid_waist_cm            numeric(5,1),
  low_waist_cm            numeric(5,1),
  hips_cm                 numeric(5,1),
  left_thigh_cm           numeric(5,1),
  left_thigh_min_cm       numeric(5,1),
  right_thigh_cm          numeric(5,1),
  right_thigh_min_cm      numeric(5,1),
  left_calf_cm            numeric(5,1),
  right_calf_cm           numeric(5,1),

  photo_path  text,
  notes       text,
  created_at  timestamptz not null default now(),

  unique (user_id, measured_on)
);

create index body_measurements_user_date_idx
  on public.body_measurements (user_id, measured_on desc);

alter table public.body_measurements enable row level security;

create policy "own_measurements_select" on public.body_measurements
  for select using (auth.uid() = user_id);
create policy "own_measurements_modify" on public.body_measurements
  for all   using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Storage RLS for health-photos: owner-only by path prefix (mirrors
-- chat-images pattern). The bucket itself is created manually in the
-- Supabase Dashboard before this migration runs.
create policy "own_health_photos_select" on storage.objects
  for select using (
    bucket_id = 'health-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "own_health_photos_insert" on storage.objects
  for insert with check (
    bucket_id = 'health-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "own_health_photos_delete" on storage.objects
  for delete using (
    bucket_id = 'health-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
