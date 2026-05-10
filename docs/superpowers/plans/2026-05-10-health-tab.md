# Health Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/health` tab with Withings body-composition delta cards, monthly circumference capture (14 fields + optional photo), trend charts, and a derived-metrics layer (WHR, symmetry).

**Architecture:** New `body_measurements` table + private `health-photos` Supabase Storage bucket. New TanStack-Query fetcher/hook pair scoped to body comp; mutations on three new route handlers. UI mirrors `/strength`: server prefetch → `<HealthClient>` with a 3-pill sub-nav (`Today | Trend | Log`). Derived metrics are pure functions computed on read. Spec: [docs/superpowers/specs/2026-05-10-health-tab-design.md](../specs/2026-05-10-health-tab-design.md).

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + Storage), TanStack Query, TypeScript strict, Tailwind v4. No test suite — verification is `npm run typecheck` + manual local exercise of affected pages, per [CLAUDE.md](../../../CLAUDE.md). Each task ends with typecheck + commit.

**Branch:** `feat/health-tab` off `main`.

---

## File Structure

**New files:**

- `supabase/migrations/0009_body_measurements.sql` — table, RLS, storage policies
- `lib/query/fetchers/bodyMeasurements.ts` — server + browser fetcher pair
- `lib/query/fetchers/healthTrend.ts` — narrow body-comp projection (the existing `dailyLogs.trend` projection lacks `fat_mass_kg / fat_free_mass_kg / muscle_mass_kg`; `/health` needs them, so we add a sibling fetcher rather than widen the `/trends` one)
- `lib/query/hooks/useBodyMeasurements.ts`
- `lib/query/hooks/useHealthTrend.ts`
- `lib/health/measurements.ts` — derived metrics (WHR, symmetry, delta)
- `lib/charts/circumferenceChartConfig.ts` — Trend-view sparkline field list
- `app/api/health/measurements/photo/route.ts` — POST multipart upload to `health-photos`
- `app/api/health/measurements/route.ts` — POST upsert
- `app/api/health/measurements/[id]/route.ts` — DELETE
- `app/api/health/photo-url/route.ts` — GET signed URL for an existing photo path (for viewer)
- `app/health/page.tsx` — server entry
- `app/health/loading.tsx`
- `components/health/HealthClient.tsx` — orchestrator (view state + modal state)
- `components/health/HealthNav.tsx` — sub-tab pills
- `components/health/BodyCompCard.tsx` — Today: Withings card
- `components/health/MeasurementCard.tsx` — Today: latest measurement table + derived row
- `components/health/MeasurementHistory.tsx` — Log view
- `components/health/TrendView.tsx` — Trend view
- `components/health/MeasurementForm.tsx` — modal (create + edit)
- `components/dashboard/BodyTile.tsx` — home-dashboard entry point

**Modified files:**

- `lib/data/types.ts` — add `BodyMeasurement` row shape
- `lib/query/keys.ts` — add `bodyMeasurements` + `healthTrend` namespaces
- `components/layout/Fab.tsx` — add "Body" item to FAB sheet
- `app/page.tsx` — render `<BodyTile>` near `<RecentLiftsCard>`
- [CLAUDE.md](../../../CLAUDE.md) — new migration step + ownership note

---

## Task 1: Migration + storage bucket

**Files:**
- Create: `supabase/migrations/0009_body_measurements.sql`

**Pre-condition (manual, one-time):** Create the `health-photos` bucket in the Supabase Dashboard before running `db push`. Storage policies in this migration reference `bucket_id = 'health-photos'`.

- [ ] **Step 1: Create the bucket**

In Supabase Dashboard → Storage → "New bucket":
- Name: `health-photos`
- Public: **off** (private)
- Click Create.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0009_body_measurements.sql`:

```sql
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
```

- [ ] **Step 3: Apply the migration**

Run: `supabase db push`

Expected output ends with `Applying migration 0009_body_measurements.sql...` followed by `Finished supabase db push.`. If a "migration already applied" error appears for prior files, run `supabase migration repair --status applied <history>` per CLAUDE.md guidance, then retry `db push`.

- [ ] **Step 4: Verify the table exists**

Run:
```bash
supabase db remote inspect 2>/dev/null || echo "use dashboard"
```
Or open Supabase Dashboard → Database → Tables → confirm `body_measurements` is present with the 14 numeric columns + `photo_path`, `notes`, `created_at`, `unique(user_id, measured_on)`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0009_body_measurements.sql
git commit -m "feat(health): migration for body_measurements + health-photos storage policies"
```

---

## Task 2: Type + query-key additions

**Files:**
- Modify: [lib/data/types.ts](../../../lib/data/types.ts) (append at end)
- Modify: [lib/query/keys.ts](../../../lib/query/keys.ts) (add to `queryKeys` object)

- [ ] **Step 1: Add `BodyMeasurement` type**

Append to `lib/data/types.ts`:

```typescript
// ── body_measurements ────────────────────────────────────────────────────────

/** Row shape for `body_measurements`. All circumference fields are nullable
 *  to permit partial entry. `photo_path` is a Supabase Storage object key in
 *  the `health-photos` bucket. */
export type BodyMeasurement = {
  id: string;
  user_id: string;
  measured_on: string; // YYYY-MM-DD
  neck_cm: number | null;
  left_upper_arm_cm: number | null;
  right_upper_arm_cm: number | null;
  chest_cm: number | null;
  high_waist_cm: number | null;
  mid_waist_cm: number | null;
  low_waist_cm: number | null;
  hips_cm: number | null;
  left_thigh_cm: number | null;
  left_thigh_min_cm: number | null;
  right_thigh_cm: number | null;
  right_thigh_min_cm: number | null;
  left_calf_cm: number | null;
  right_calf_cm: number | null;
  photo_path: string | null;
  notes: string | null;
  created_at: string;
};

/** Field key list — the 14 circumference columns, in display order
 *  (Upper → Core → Lower). Used by the form modal, the latest-measurement
 *  table, and the trend config. */
export const BODY_MEASUREMENT_FIELDS = [
  "neck_cm",
  "left_upper_arm_cm",
  "right_upper_arm_cm",
  "chest_cm",
  "high_waist_cm",
  "mid_waist_cm",
  "low_waist_cm",
  "hips_cm",
  "left_thigh_cm",
  "left_thigh_min_cm",
  "right_thigh_cm",
  "right_thigh_min_cm",
  "left_calf_cm",
  "right_calf_cm",
] as const;

export type BodyMeasurementField = (typeof BODY_MEASUREMENT_FIELDS)[number];
```

- [ ] **Step 2: Add query keys**

In `lib/query/keys.ts`, inside the `queryKeys = { ... }` object, add (anywhere before the closing brace, alphabetical works — adjacent to `dailyLogs` is fine):

```typescript
  bodyMeasurements: {
    all: (userId: string) => ["body-measurements", userId] as const,
  },
  healthTrend: {
    range: (userId: string, from: string, to: string) =>
      ["health-trend", userId, from, to] as const,
  },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: clean exit (no errors). If it reports unrelated existing errors, verify they pre-existed by running `git stash && npm run typecheck && git stash pop`.

- [ ] **Step 4: Commit**

```bash
git add lib/data/types.ts lib/query/keys.ts
git commit -m "feat(health): add BodyMeasurement type and query keys"
```

---

## Task 3: bodyMeasurements fetcher pair + hook

**Files:**
- Create: `lib/query/fetchers/bodyMeasurements.ts`
- Create: `lib/query/hooks/useBodyMeasurements.ts`

- [ ] **Step 1: Write the fetcher pair**

Create `lib/query/fetchers/bodyMeasurements.ts`:

```typescript
// lib/query/fetchers/bodyMeasurements.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { BodyMeasurement } from "@/lib/data/types";

const COLS =
  "id, user_id, measured_on, neck_cm, left_upper_arm_cm, right_upper_arm_cm, chest_cm, high_waist_cm, mid_waist_cm, low_waist_cm, hips_cm, left_thigh_cm, left_thigh_min_cm, right_thigh_cm, right_thigh_min_cm, left_calf_cm, right_calf_cm, photo_path, notes, created_at";

/** Cap. Personal-app: nobody hits 60 monthly measurements in human time. */
const MAX_ROWS = 60;

/** Server variant — caller (Server Component) supplies the SSR Supabase
 *  client so cookie/auth scoping is explicit. */
export async function fetchBodyMeasurementsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<BodyMeasurement[]> {
  const { data, error } = await supabase
    .from("body_measurements")
    .select(COLS)
    .eq("user_id", userId)
    .order("measured_on", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return (data ?? []) as BodyMeasurement[];
}

/** Browser variant — self-constructs the cookie-bound browser client. */
export async function fetchBodyMeasurementsBrowser(
  userId: string,
): Promise<BodyMeasurement[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("body_measurements")
    .select(COLS)
    .eq("user_id", userId)
    .order("measured_on", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return (data ?? []) as BodyMeasurement[];
}
```

- [ ] **Step 2: Write the hook**

Create `lib/query/hooks/useBodyMeasurements.ts`:

```typescript
// lib/query/hooks/useBodyMeasurements.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchBodyMeasurementsBrowser } from "@/lib/query/fetchers/bodyMeasurements";

export function useBodyMeasurements(userId: string) {
  return useQuery({
    queryKey: queryKeys.bodyMeasurements.all(userId),
    queryFn: () => fetchBodyMeasurementsBrowser(userId),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` — clean.

- [ ] **Step 4: Commit**

```bash
git add lib/query/fetchers/bodyMeasurements.ts lib/query/hooks/useBodyMeasurements.ts
git commit -m "feat(health): bodyMeasurements fetcher pair + hook"
```

---

## Task 4: healthTrend fetcher pair + hook

The `/health → Trend` view needs `weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg` over a 12-month window. The existing `fetchDailyLogsTrendServer` projection is narrower (HRV/RHR/sleep/strain/weight/BF only) and serving `/trends`. Adding a sibling rather than widening keeps `/trends` payload small.

**Files:**
- Create: `lib/query/fetchers/healthTrend.ts`
- Create: `lib/query/hooks/useHealthTrend.ts`

- [ ] **Step 1: Write the fetcher pair**

Create `lib/query/fetchers/healthTrend.ts`:

```typescript
// lib/query/fetchers/healthTrend.ts
//
// Narrow body-comp projection for /health Trend view + the Today body-comp
// card. Separate from lib/query/fetchers/dailyLogs.ts:fetchDailyLogsTrend to
// avoid widening the /trends payload (which only charts weight/BF% from
// body comp).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DailyLog } from "@/lib/data/types";

const COLS =
  "date, weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg";

export type HealthTrendPoint = Pick<
  DailyLog,
  "date" | "weight_kg" | "body_fat_pct" | "fat_mass_kg" | "fat_free_mass_kg" | "muscle_mass_kg"
>;

export async function fetchHealthTrendServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<HealthTrendPoint[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as HealthTrendPoint[];
}

export async function fetchHealthTrendBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<HealthTrendPoint[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as HealthTrendPoint[];
}
```

- [ ] **Step 2: Write the hook**

Create `lib/query/hooks/useHealthTrend.ts`:

```typescript
// lib/query/hooks/useHealthTrend.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchHealthTrendBrowser } from "@/lib/query/fetchers/healthTrend";

export function useHealthTrend(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.healthTrend.range(userId, from, to),
    queryFn: () => fetchHealthTrendBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add lib/query/fetchers/healthTrend.ts lib/query/hooks/useHealthTrend.ts
git commit -m "feat(health): healthTrend fetcher pair + hook"
```

---

## Task 5: Photo upload route

Mirrors [app/api/chat/images/route.ts](../../../app/api/chat/images/route.ts) but simpler: no separate DB row (the path is stored directly in `body_measurements.photo_path`). Auth via cookie client, upload via service-role client.

**Files:**
- Create: `app/api/health/measurements/photo/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/health/measurements/photo/route.ts`:

```typescript
// app/api/health/measurements/photo/route.ts
//
// POST multipart/form-data with field "file". Validates size + MIME, uploads
// to `health-photos/<user_id>/measurements/_unattached/<uuid>.<ext>`, returns
// the storage path + a 1h signed URL for the optimistic preview.
//
// "Unattached" path segment marks blobs not yet linked to a body_measurements
// row — left in place if the user closes the modal mid-flow (acceptable leak,
// see spec § Risks; sweep cron deferred).

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — scanner exports occasionally exceed 4 MB
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, reason: "missing_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, reason: "too_large" }, { status: 413 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { ok: false, reason: "bad_mime", mime: file.type },
      { status: 415 },
    );
  }

  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
      ? "webp"
      : file.type === "image/heic"
      ? "heic"
      : "jpg";
  const uuid = randomUUID();
  const path = `${user.id}/measurements/_unattached/${uuid}.${ext}`;

  const sr = createSupabaseServiceRoleClient();
  const { error: upErr } = await sr.storage
    .from("health-photos")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) {
    return NextResponse.json(
      { ok: false, reason: "upload_failed", error: upErr.message },
      { status: 500 },
    );
  }

  const { data: signed } = await sr.storage
    .from("health-photos")
    .createSignedUrl(path, 60 * 60); // 1 hour, optimistic preview only

  return NextResponse.json({
    ok: true,
    path,
    signed_url: signed?.signedUrl ?? null,
  });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/api/health/measurements/photo/route.ts
git commit -m "feat(health): photo upload route → health-photos bucket"
```

---

## Task 6: Measurement upsert route

**Files:**
- Create: `app/api/health/measurements/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/health/measurements/route.ts`:

```typescript
// app/api/health/measurements/route.ts
//
// POST: upsert one body_measurements row keyed on (user_id, measured_on).
// Re-saving the same date overwrites — used both for "fix a typo" and for
// the explicit Edit flow. Empty/non-numeric circumference fields are stored
// as null. Negative values are rejected (hard validation per spec); values
// > 300 cm are accepted (soft warn lives in the form UI).
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  BODY_MEASUREMENT_FIELDS,
  type BodyMeasurementField,
} from "@/lib/data/types";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Body = {
  measured_on?: string;
  photo_path?: string | null;
  notes?: string | null;
} & Partial<Record<BodyMeasurementField, number | null>>;

function asNumOrNull(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number") return "invalid";
  if (!Number.isFinite(v)) return "invalid";
  if (v < 0) return "invalid";
  return v;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const measured_on = body.measured_on;
  if (!measured_on || !ISO_DATE.test(measured_on)) {
    return NextResponse.json({ ok: false, reason: "bad_date" }, { status: 400 });
  }

  // Validate + project the 14 numeric fields.
  const fields: Record<BodyMeasurementField, number | null> = {} as Record<
    BodyMeasurementField,
    number | null
  >;
  let anyValue = false;
  for (const k of BODY_MEASUREMENT_FIELDS) {
    const parsed = asNumOrNull(body[k]);
    if (parsed === "invalid") {
      return NextResponse.json(
        { ok: false, reason: "bad_value", field: k },
        { status: 400 },
      );
    }
    fields[k] = parsed;
    if (parsed !== null) anyValue = true;
  }
  if (!anyValue) {
    return NextResponse.json(
      { ok: false, reason: "empty_measurement" },
      { status: 400 },
    );
  }

  const photo_path =
    typeof body.photo_path === "string" && body.photo_path.length > 0
      ? body.photo_path
      : null;
  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;

  const { data: row, error } = await supabase
    .from("body_measurements")
    .upsert(
      {
        user_id: user.id,
        measured_on,
        ...fields,
        photo_path,
        notes,
      },
      { onConflict: "user_id,measured_on" },
    )
    .select("*")
    .single();
  if (error || !row) {
    return NextResponse.json(
      { ok: false, reason: "db_error", error: error?.message },
      { status: 500 },
    );
  }

  revalidatePath("/health");
  return NextResponse.json({ ok: true, row });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/api/health/measurements/route.ts
git commit -m "feat(health): POST /api/health/measurements (upsert)"
```

---

## Task 7: Measurement delete route

**Files:**
- Create: `app/api/health/measurements/[id]/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/health/measurements/[id]/route.ts`:

```typescript
// app/api/health/measurements/[id]/route.ts
//
// DELETE one measurement row. RLS scopes by user_id, but we re-check before
// blob removal so we don't fire a service-role delete on someone else's path.
// Photo blob is best-effort: if the storage delete fails we still return ok
// (orphan blob is preferable to a stuck row).
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ ok: false, reason: "missing_id" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  // Read first to grab photo_path + verify ownership via RLS.
  const { data: existing, error: readErr } = await supabase
    .from("body_measurements")
    .select("id, user_id, photo_path")
    .eq("id", id)
    .single();
  if (readErr || !existing) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  if (existing.user_id !== user.id) {
    // Defensive: RLS should have already filtered, but belt-and-braces.
    return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
  }

  const { error: delErr } = await supabase
    .from("body_measurements")
    .delete()
    .eq("id", id);
  if (delErr) {
    return NextResponse.json(
      { ok: false, reason: "db_error", error: delErr.message },
      { status: 500 },
    );
  }

  if (existing.photo_path) {
    const sr = createSupabaseServiceRoleClient();
    await sr.storage.from("health-photos").remove([existing.photo_path]);
    // Best-effort: ignore failure.
  }

  revalidatePath("/health");
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/api/health/measurements/[id]/route.ts
git commit -m "feat(health): DELETE /api/health/measurements/[id]"
```

---

## Task 8: Photo signed-URL route

For the viewer/thumbnail. Signed URLs are not stored in the cached `BodyMeasurement` row — minted on demand here so they don't expire stale.

**Files:**
- Create: `app/api/health/photo-url/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/health/photo-url/route.ts`:

```typescript
// app/api/health/photo-url/route.ts
//
// GET ?path=<storage-key>. Verifies the path is under the calling user's
// prefix, mints a 1h signed URL via service-role. Used by MeasurementCard
// thumbnails and the fullscreen viewer.
import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ ok: false, reason: "missing_path" }, { status: 400 });
  }
  if (!path.startsWith(`${user.id}/`)) {
    return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
  }

  const sr = createSupabaseServiceRoleClient();
  const { data: signed, error } = await sr.storage
    .from("health-photos")
    .createSignedUrl(path, 60 * 60);
  if (error || !signed) {
    return NextResponse.json(
      { ok: false, reason: "sign_failed", error: error?.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, signed_url: signed.signedUrl });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/api/health/photo-url/route.ts
git commit -m "feat(health): GET /api/health/photo-url (signed URLs for viewer)"
```

---

## Task 9: Derived metrics + chart config (pure modules)

**Files:**
- Create: `lib/health/measurements.ts`
- Create: `lib/charts/circumferenceChartConfig.ts`

- [ ] **Step 1: Write `lib/health/measurements.ts`**

```typescript
// lib/health/measurements.ts
//
// Pure functions for derived measurement metrics. Inputs that include null
// produce null outputs — UI renders "—" rather than synthetic zeros.
import type { BodyMeasurement, BodyMeasurementField } from "@/lib/data/types";
import { BODY_MEASUREMENT_FIELDS } from "@/lib/data/types";

/** Waist–hip ratio: mid_waist_cm / hips_cm. */
export function whr(m: BodyMeasurement): number | null {
  if (m.mid_waist_cm == null || m.hips_cm == null || m.hips_cm === 0) return null;
  return m.mid_waist_cm / m.hips_cm;
}

/** Waist–chest ratio: mid_waist_cm / chest_cm (V-taper proxy). */
export function waistChest(m: BodyMeasurement): number | null {
  if (m.mid_waist_cm == null || m.chest_cm == null || m.chest_cm === 0) return null;
  return m.mid_waist_cm / m.chest_cm;
}

/** Average upper-arm circumference. */
export function armAvg(m: BodyMeasurement): number | null {
  return avg2(m.left_upper_arm_cm, m.right_upper_arm_cm);
}

/** Average thigh circumference (max girth, not min). */
export function thighAvg(m: BodyMeasurement): number | null {
  return avg2(m.left_thigh_cm, m.right_thigh_cm);
}

/** Average calf circumference. */
export function calfAvg(m: BodyMeasurement): number | null {
  return avg2(m.left_calf_cm, m.right_calf_cm);
}

/** Symmetry as a percentage: |L−R| / ((L+R)/2) * 100. 0 = perfect symmetry. */
export function symmetryPct(l: number | null, r: number | null): number | null {
  if (l == null || r == null) return null;
  const mean = (l + r) / 2;
  if (mean === 0) return null;
  return (Math.abs(l - r) / mean) * 100;
}

/** Per-field delta vs prior measurement. abs is `curr − prev`; pct is the
 *  percentage change (null when prev is 0 or either side is null). */
export function delta(
  curr: BodyMeasurement,
  prev: BodyMeasurement | null,
): Record<BodyMeasurementField, { abs: number; pct: number | null } | null> {
  const out = {} as Record<
    BodyMeasurementField,
    { abs: number; pct: number | null } | null
  >;
  for (const k of BODY_MEASUREMENT_FIELDS) {
    const a = curr[k];
    const b = prev?.[k] ?? null;
    if (a == null || b == null) {
      out[k] = null;
      continue;
    }
    const abs = a - b;
    const pct = b === 0 ? null : (abs / b) * 100;
    out[k] = { abs, pct };
  }
  return out;
}

function avg2(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return (a + b) / 2;
}
```

- [ ] **Step 2: Write `lib/charts/circumferenceChartConfig.ts`**

```typescript
// lib/charts/circumferenceChartConfig.ts
//
// Field list driving the six headline sparklines on /health → Trend.
// The other 8 raw circumferences are exposed via inline expand on the
// latest-measurement table (MeasurementCard), not here.
import type { BodyMeasurement } from "@/lib/data/types";

export type CircumferenceMetric = {
  /** Stable id used in keys/configs. */
  id: string;
  /** Display label. */
  label: string;
  /** Unit shown next to the value. */
  unit: string;
  /** Color for line + icon chip. */
  color: string;
  /** Pull a numeric value out of a BodyMeasurement row, or null if missing. */
  read: (m: BodyMeasurement) => number | null;
};

export const CIRCUMFERENCE_METRICS: CircumferenceMetric[] = [
  {
    id: "mid_waist",
    label: "Mid waist",
    unit: "cm",
    color: "#ef4444",
    read: (m) => m.mid_waist_cm,
  },
  {
    id: "hips",
    label: "Hips",
    unit: "cm",
    color: "#f59e0b",
    read: (m) => m.hips_cm,
  },
  {
    id: "whr",
    label: "Waist : Hips",
    unit: "",
    color: "#a855f7",
    read: (m) => {
      if (m.mid_waist_cm == null || m.hips_cm == null || m.hips_cm === 0) return null;
      return m.mid_waist_cm / m.hips_cm;
    },
  },
  {
    id: "chest",
    label: "Chest",
    unit: "cm",
    color: "#3b82f6",
    read: (m) => m.chest_cm,
  },
  {
    id: "arm_avg",
    label: "Avg upper arm",
    unit: "cm",
    color: "#14b870",
    read: (m) => {
      if (m.left_upper_arm_cm == null || m.right_upper_arm_cm == null) return null;
      return (m.left_upper_arm_cm + m.right_upper_arm_cm) / 2;
    },
  },
  {
    id: "thigh_avg",
    label: "Avg thigh",
    unit: "cm",
    color: "#06b6d4",
    read: (m) => {
      if (m.left_thigh_cm == null || m.right_thigh_cm == null) return null;
      return (m.left_thigh_cm + m.right_thigh_cm) / 2;
    },
  },
];
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add lib/health/measurements.ts lib/charts/circumferenceChartConfig.ts
git commit -m "feat(health): derived metrics module + circumference chart config"
```

---

## Task 10: HealthNav (sub-tab pills)

**Files:**
- Create: `components/health/HealthNav.tsx`

- [ ] **Step 1: Write the component**

Mirrors [components/strength/StrengthNav.tsx](../../../components/strength/StrengthNav.tsx).

Create `components/health/HealthNav.tsx`:

```typescript
"use client";

import { RangePills } from "@/components/ui/RangePills";

const VIEWS = [
  { id: "today", label: "Today",  href: "/health" },
  { id: "trend", label: "Trend",  href: "/health?view=trend" },
  { id: "log",   label: "Log",    href: "/health?view=log" },
] as const;

export type HealthView = (typeof VIEWS)[number]["id"];

export function HealthNav({
  active,
  onChange,
}: {
  active: HealthView;
  onChange?: (view: HealthView) => void;
}) {
  return (
    <RangePills
      options={VIEWS as unknown as { id: string; label: string; href: string }[]}
      active={active}
      onChange={onChange ? (id) => onChange(id as HealthView) : undefined}
    />
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add components/health/HealthNav.tsx
git commit -m "feat(health): HealthNav sub-tab pills"
```

---

## Task 11: MeasurementForm modal

The largest UI component. Handles new + edit, photo upload, soft validation, submit.

**Files:**
- Create: `components/health/MeasurementForm.tsx`

- [ ] **Step 1: Write the component**

Create `components/health/MeasurementForm.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { todayInUserTz } from "@/lib/time";
import { queryKeys } from "@/lib/query/keys";
import {
  BODY_MEASUREMENT_FIELDS,
  type BodyMeasurement,
  type BodyMeasurementField,
} from "@/lib/data/types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type GroupKey = "Upper" | "Core" | "Lower";

const GROUPS: { group: GroupKey; fields: { key: BodyMeasurementField; label: string }[] }[] = [
  {
    group: "Upper",
    fields: [
      { key: "neck_cm",            label: "Neck" },
      { key: "left_upper_arm_cm",  label: "Left upper arm" },
      { key: "right_upper_arm_cm", label: "Right upper arm" },
      { key: "chest_cm",           label: "Chest" },
    ],
  },
  {
    group: "Core",
    fields: [
      { key: "high_waist_cm", label: "High waist" },
      { key: "mid_waist_cm",  label: "Mid waist" },
      { key: "low_waist_cm",  label: "Low waist" },
      { key: "hips_cm",       label: "Hips" },
    ],
  },
  {
    group: "Lower",
    fields: [
      { key: "left_thigh_cm",      label: "Left thigh" },
      { key: "left_thigh_min_cm",  label: "Left thigh (min)" },
      { key: "right_thigh_cm",     label: "Right thigh" },
      { key: "right_thigh_min_cm", label: "Right thigh (min)" },
      { key: "left_calf_cm",       label: "Left calf" },
      { key: "right_calf_cm",      label: "Right calf" },
    ],
  },
];

type FormState = {
  measured_on: string;
  notes: string;
  photo_path: string | null;
  photo_signed_url: string | null;
  photo_uploading: boolean;
  photo_error: string | null;
  values: Record<BodyMeasurementField, string>; // string in form, parsed to number on save
};

function emptyValues(): Record<BodyMeasurementField, string> {
  const v = {} as Record<BodyMeasurementField, string>;
  for (const k of BODY_MEASUREMENT_FIELDS) v[k] = "";
  return v;
}

function fromMeasurement(m: BodyMeasurement): Record<BodyMeasurementField, string> {
  const v = {} as Record<BodyMeasurementField, string>;
  for (const k of BODY_MEASUREMENT_FIELDS) {
    const raw = m[k];
    v[k] = raw == null ? "" : fmtNum(raw);
  }
  return v;
}

function isOutOfSoftRange(s: string): boolean {
  if (s.trim() === "") return false;
  const n = Number(s);
  if (!Number.isFinite(n)) return true;
  return n <= 0 || n > 300;
}

export function MeasurementForm({
  userId,
  existing,
  onClose,
  existingDates,
}: {
  userId: string;
  /** When supplied, the modal is in Edit mode for that row. */
  existing?: BodyMeasurement | null;
  onClose: () => void;
  /** Existing measured_on values; used to confirm overwrite when creating new. */
  existingDates: string[];
}) {
  const qc = useQueryClient();
  const [state, setState] = useState<FormState>(() => ({
    measured_on: existing?.measured_on ?? todayInUserTz(),
    notes: existing?.notes ?? "",
    photo_path: existing?.photo_path ?? null,
    photo_signed_url: null,
    photo_uploading: false,
    photo_error: null,
    values: existing ? fromMeasurement(existing) : emptyValues(),
  }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const anyValue = BODY_MEASUREMENT_FIELDS.some((k) => state.values[k].trim() !== "");
  const dateValid = ISO_DATE.test(state.measured_on);

  async function onPickPhoto(file: File) {
    setState((s) => ({ ...s, photo_uploading: true, photo_error: null }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/health/measurements/photo", {
        method: "POST",
        body: fd,
      });
      const json = (await res.json()) as
        | { ok: true; path: string; signed_url: string | null }
        | { ok: false; reason: string };
      if (!json.ok) {
        setState((s) => ({
          ...s,
          photo_uploading: false,
          photo_error: json.reason,
        }));
        return;
      }
      setState((s) => ({
        ...s,
        photo_uploading: false,
        photo_path: json.path,
        photo_signed_url: json.signed_url,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        photo_uploading: false,
        photo_error: err instanceof Error ? err.message : "upload_failed",
      }));
    }
  }

  function clearPhoto() {
    setState((s) => ({ ...s, photo_path: null, photo_signed_url: null }));
  }

  async function onSave() {
    if (!anyValue || !dateValid || submitting) return;

    // Confirm overwrite: only when creating new (not editing) and the date
    // already exists.
    if (
      !existing &&
      existingDates.includes(state.measured_on) &&
      !window.confirm(
        `A measurement already exists for ${state.measured_on}. Overwrite?`,
      )
    ) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    const fields: Record<BodyMeasurementField, number | null> = {} as Record<
      BodyMeasurementField,
      number | null
    >;
    for (const k of BODY_MEASUREMENT_FIELDS) {
      const s = state.values[k].trim();
      if (s === "") {
        fields[k] = null;
        continue;
      }
      const n = Number(s);
      if (!Number.isFinite(n) || n < 0) {
        setSubmitting(false);
        setSubmitError(`Invalid value for ${k}`);
        return;
      }
      fields[k] = n;
    }

    try {
      const res = await fetch("/api/health/measurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          measured_on: state.measured_on,
          ...fields,
          photo_path: state.photo_path,
          notes: state.notes.trim() || null,
        }),
      });
      const json = (await res.json()) as
        | { ok: true; row: BodyMeasurement }
        | { ok: false; reason: string };
      if (!json.ok) {
        setSubmitting(false);
        setSubmitError(json.reason);
        return;
      }
      qc.invalidateQueries({ queryKey: queryKeys.bodyMeasurements.all(userId) });
      onClose();
    } catch (err) {
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : "save_failed");
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(15,20,48,0.5)",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLOR.surface,
          borderRadius: 0,
          padding: "16px",
          width: "100%",
          maxWidth: "560px",
          alignSelf: "stretch",
          boxShadow: SHADOW.floating,
          minHeight: "100dvh",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: "14px",
              color: COLOR.textMuted,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "8px 4px",
            }}
          >
            ← Cancel
          </button>
          <strong style={{ fontSize: "15px", color: COLOR.textStrong }}>
            {existing ? "Edit measurement" : "Log measurement"}
          </strong>
          <button
            type="button"
            onClick={onSave}
            disabled={!anyValue || !dateValid || submitting}
            style={{
              fontSize: "14px",
              fontWeight: 700,
              color: anyValue && dateValid ? COLOR.accent : COLOR.textFaint,
              background: "none",
              border: "none",
              cursor: anyValue && dateValid ? "pointer" : "default",
              padding: "8px 4px",
            }}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>

        {submitError && (
          <div style={{ background: COLOR.dangerSoft, color: COLOR.danger, padding: "8px 12px", borderRadius: RADIUS.cardSmall, fontSize: "13px", marginBottom: "12px" }}>
            {submitError}
          </div>
        )}

        {/* Date */}
        <label style={{ display: "block", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>
            Date
          </div>
          <input
            type="date"
            value={state.measured_on}
            onChange={(e) => setState((s) => ({ ...s, measured_on: e.target.value }))}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: COLOR.surfaceAlt,
              border: "none",
              borderRadius: RADIUS.input,
              fontSize: "14px",
              color: COLOR.textStrong,
            }}
          />
        </label>

        {/* Photo */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" }}>
            Photo (optional)
          </div>
          {state.photo_path ? (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall }}>
              {state.photo_signed_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={state.photo_signed_url} alt="measurement" style={{ width: "60px", height: "60px", objectFit: "cover", borderRadius: RADIUS.cardSmall }} />
              ) : (
                <div style={{ width: "60px", height: "60px", borderRadius: RADIUS.cardSmall, background: COLOR.divider }} />
              )}
              <span style={{ flex: 1, fontSize: "12px", color: COLOR.textMid }}>Attached</span>
              <button type="button" onClick={clearPhoto} style={{ background: "none", border: "none", color: COLOR.textMuted, cursor: "pointer", fontSize: "16px" }}>
                ✕
              </button>
            </div>
          ) : (
            <label style={{ display: "block" }}>
              <div style={{ padding: "12px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall, fontSize: "13px", color: COLOR.textMid, cursor: state.photo_uploading ? "default" : "pointer", textAlign: "center" }}>
                {state.photo_uploading ? "Uploading…" : "📷 Attach scanner screenshot"}
              </div>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                disabled={state.photo_uploading}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickPhoto(f);
                }}
              />
            </label>
          )}
          {state.photo_error && (
            <div style={{ fontSize: "12px", color: COLOR.danger, marginTop: "4px" }}>
              {state.photo_error}
            </div>
          )}
        </div>

        {/* Field groups */}
        {GROUPS.map((g) => (
          <div key={g.group} style={{ marginBottom: "12px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" }}>
              {g.group}
            </div>
            {g.fields.map(({ key, label }) => {
              const v = state.values[key];
              const oor = isOutOfSoftRange(v);
              return (
                <label key={key} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "8px", alignItems: "center", padding: "8px 12px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall, marginBottom: "4px", border: `1px solid ${oor ? COLOR.danger : "transparent"}` }}>
                  <span style={{ fontSize: "13px", color: COLOR.textStrong }}>{label}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={v}
                    onChange={(e) =>
                      setState((s) => ({
                        ...s,
                        values: { ...s.values, [key]: e.target.value },
                      }))
                    }
                    style={{
                      width: "70px",
                      textAlign: "right",
                      background: COLOR.surface,
                      border: "none",
                      borderRadius: RADIUS.chip,
                      padding: "6px 8px",
                      fontSize: "13px",
                      color: COLOR.textStrong,
                    }}
                  />
                  <span style={{ fontSize: "11px", color: COLOR.textMuted }}>cm</span>
                </label>
              );
            })}
            {g.fields.some((f) => isOutOfSoftRange(state.values[f.key])) && (
              <div style={{ fontSize: "11px", color: COLOR.danger, marginTop: "2px" }}>
                Unusual value — double-check before saving.
              </div>
            )}
          </div>
        ))}

        {/* Notes */}
        <label style={{ display: "block", marginTop: "8px", marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "4px" }}>
            Notes (optional)
          </div>
          <textarea
            value={state.notes}
            onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))}
            rows={3}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: COLOR.surfaceAlt,
              border: "none",
              borderRadius: RADIUS.input,
              fontSize: "13px",
              color: COLOR.textStrong,
              resize: "vertical",
            }}
          />
        </label>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add components/health/MeasurementForm.tsx
git commit -m "feat(health): MeasurementForm modal (create + edit + photo upload)"
```

---

## Task 12: BodyCompCard (Today view's Withings card)

**Files:**
- Create: `components/health/BodyCompCard.tsx`

- [ ] **Step 1: Write the component**

Create `components/health/BodyCompCard.tsx`:

```typescript
"use client";

import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { HealthTrendPoint } from "@/lib/query/fetchers/healthTrend";

type Field = {
  key: keyof Pick<
    HealthTrendPoint,
    "weight_kg" | "body_fat_pct" | "fat_mass_kg" | "fat_free_mass_kg" | "muscle_mass_kg"
  >;
  label: string;
  unit: string;
  /** Direction "good" — lower BF% / fat_mass = good; higher lean / muscle = good. */
  goodWhenLower: boolean;
};

const FIELDS: Field[] = [
  { key: "weight_kg",        label: "Weight",     unit: "kg", goodWhenLower: true },
  { key: "body_fat_pct",     label: "Body fat",   unit: "%",  goodWhenLower: true },
  { key: "fat_mass_kg",      label: "Fat mass",   unit: "kg", goodWhenLower: true },
  { key: "fat_free_mass_kg", label: "Lean mass",  unit: "kg", goodWhenLower: false },
  { key: "muscle_mass_kg",   label: "Muscle",     unit: "kg", goodWhenLower: false },
];

/** Latest non-null value within window. */
function latest(points: HealthTrendPoint[], key: Field["key"]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i][key];
    if (v != null) return v;
  }
  return null;
}

/** Most recent non-null reading whose date is in [today-35, today-25]. */
function baseline35to25(
  points: HealthTrendPoint[],
  todayIso: string,
  key: Field["key"],
): number | null {
  const today = new Date(todayIso + "T00:00:00Z");
  const lo = new Date(today);
  lo.setUTCDate(lo.getUTCDate() - 35);
  const hi = new Date(today);
  hi.setUTCDate(hi.getUTCDate() - 25);
  const loIso = lo.toISOString().slice(0, 10);
  const hiIso = hi.toISOString().slice(0, 10);

  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p.date < loIso || p.date > hiIso) continue;
    if (p[key] != null) return p[key]!;
  }
  return null;
}

export function BodyCompCard({
  points,
  todayIso,
}: {
  points: HealthTrendPoint[];
  todayIso: string;
}) {
  return (
    <Card>
      <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: "10px" }}>
        Body composition · vs 30d
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "6px 12px", alignItems: "baseline" }}>
        {FIELDS.map((f) => {
          const curr = latest(points, f.key);
          const prev = baseline35to25(points, todayIso, f.key);
          const d = curr != null && prev != null ? curr - prev : null;
          const isGood =
            d == null
              ? null
              : f.goodWhenLower
              ? d < 0
              : d > 0;
          const deltaColor =
            d == null
              ? COLOR.textFaint
              : d === 0
              ? COLOR.textFaint
              : isGood
              ? COLOR.success
              : COLOR.danger;
          return (
            <FieldRow
              key={f.key}
              label={f.label}
              value={curr}
              unit={f.unit}
              delta={d}
              deltaColor={deltaColor}
            />
          );
        })}
      </div>
    </Card>
  );
}

function FieldRow({
  label,
  value,
  unit,
  delta,
  deltaColor,
}: {
  label: string;
  value: number | null;
  unit: string;
  delta: number | null;
  deltaColor: string;
}) {
  return (
    <>
      <span style={{ fontSize: "13px", color: COLOR.textMid }}>{label}</span>
      <span data-tnum style={{ fontSize: "15px", fontWeight: 700, color: COLOR.textStrong, textAlign: "right" }}>
        {fmtNum(value)} {unit}
      </span>
      <span data-tnum style={{ fontSize: "12px", fontWeight: 600, color: deltaColor, textAlign: "right" }}>
        {delta == null ? "—" : `${delta > 0 ? "+" : ""}${fmtNum(delta)}`}
      </span>
    </>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add components/health/BodyCompCard.tsx
git commit -m "feat(health): BodyCompCard with 30d delta on Today view"
```

---

## Task 13: MeasurementCard (Today view's measurement card)

**Files:**
- Create: `components/health/MeasurementCard.tsx`

- [ ] **Step 1: Write the component**

Create `components/health/MeasurementCard.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import {
  whr,
  waistChest,
  symmetryPct,
  delta as deltaFor,
} from "@/lib/health/measurements";
import type { BodyMeasurement, BodyMeasurementField } from "@/lib/data/types";

type Group = { name: "Upper" | "Core" | "Lower"; rows: { key: BodyMeasurementField; label: string }[] };

const GROUPS: Group[] = [
  {
    name: "Upper",
    rows: [
      { key: "neck_cm",            label: "Neck" },
      { key: "left_upper_arm_cm",  label: "Left upper arm" },
      { key: "right_upper_arm_cm", label: "Right upper arm" },
      { key: "chest_cm",           label: "Chest" },
    ],
  },
  {
    name: "Core",
    rows: [
      { key: "high_waist_cm", label: "High waist" },
      { key: "mid_waist_cm",  label: "Mid waist" },
      { key: "low_waist_cm",  label: "Low waist" },
      { key: "hips_cm",       label: "Hips" },
    ],
  },
  {
    name: "Lower",
    rows: [
      { key: "left_thigh_cm",      label: "Left thigh" },
      { key: "left_thigh_min_cm",  label: "Left thigh (min)" },
      { key: "right_thigh_cm",     label: "Right thigh" },
      { key: "right_thigh_min_cm", label: "Right thigh (min)" },
      { key: "left_calf_cm",       label: "Left calf" },
      { key: "right_calf_cm",      label: "Right calf" },
    ],
  },
];

export function MeasurementCard({
  latest,
  prev,
  onLogNew,
  onEdit,
}: {
  latest: BodyMeasurement | null;
  prev: BodyMeasurement | null;
  onLogNew: () => void;
  onEdit: () => void;
}) {
  if (!latest) {
    return (
      <Card>
        <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: "10px" }}>
          Measurements
        </div>
        <p style={{ fontSize: "13px", color: COLOR.textFaint, marginBottom: "12px" }}>
          No measurements yet. Log your first one to start tracking circumference progress.
        </p>
        <button
          type="button"
          onClick={onLogNew}
          style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "10px 14px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
        >
          Log first measurement
        </button>
      </Card>
    );
  }

  const d = deltaFor(latest, prev);
  const whrVal = whr(latest);
  const wcVal = waistChest(latest);
  const armSym = symmetryPct(latest.left_upper_arm_cm, latest.right_upper_arm_cm);
  const thighSym = symmetryPct(latest.left_thigh_cm, latest.right_thigh_cm);

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Measurements · {latest.measured_on}
        </span>
        <button
          type="button"
          onClick={onEdit}
          style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          Edit
        </button>
      </div>

      {/* Header row */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 0.8fr", gap: "4px 10px", marginBottom: "4px", fontSize: "10px", fontWeight: 700, color: COLOR.textFaint, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        <span>Item</span>
        <span style={{ textAlign: "right" }}>Present</span>
        <span style={{ textAlign: "right" }}>Last</span>
        <span style={{ textAlign: "right" }}>Net</span>
      </div>

      {GROUPS.map((g) => (
        <div key={g.name} style={{ marginBottom: "8px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: COLOR.textMuted, marginTop: "6px", marginBottom: "2px", letterSpacing: "0.04em" }}>
            {g.name}
          </div>
          {g.rows.map(({ key, label }) => {
            const curr = latest[key];
            const last = prev?.[key] ?? null;
            const dRow = d[key];
            const sign = dRow == null ? "—" : dRow.abs > 0 ? "+" : "";
            const dColor =
              dRow == null
                ? COLOR.textFaint
                : dRow.abs === 0
                ? COLOR.textFaint
                : dRow.abs < 0
                ? COLOR.success
                : COLOR.danger;
            return (
              <div key={key} style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 0.8fr", gap: "4px 10px", padding: "4px 0", borderTop: `1px solid ${COLOR.divider}`, fontSize: "12px" }}>
                <span style={{ color: COLOR.textMid }}>{label}</span>
                <span data-tnum style={{ textAlign: "right", color: COLOR.textStrong, fontWeight: 600 }}>
                  {fmtNum(curr)}
                </span>
                <span data-tnum style={{ textAlign: "right", color: COLOR.textFaint }}>
                  {fmtNum(last)}
                </span>
                <span data-tnum style={{ textAlign: "right", color: dColor, fontWeight: 600 }}>
                  {dRow == null ? "—" : `${sign}${fmtNum(dRow.abs)}`}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {/* Derived row */}
      <div style={{ marginTop: "12px", padding: "10px", background: COLOR.surfaceAlt, borderRadius: RADIUS.cardSmall, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px" }}>
        <DerivedCell label="WHR"          value={whrVal == null ? "—" : fmtNum(whrVal, 3)} />
        <DerivedCell label="W : C"        value={wcVal == null ? "—" : fmtNum(wcVal, 3)} />
        <DerivedCell label="Arm sym %"    value={armSym == null ? "—" : fmtNum(armSym, 1)} />
        <DerivedCell label="Thigh sym %"  value={thighSym == null ? "—" : fmtNum(thighSym, 1)} />
      </div>

      {latest.photo_path && <PhotoThumb path={latest.photo_path} />}

      {latest.notes && (
        <div style={{ marginTop: "10px", fontSize: "12px", color: COLOR.textMid, fontStyle: "italic" }}>
          {latest.notes}
        </div>
      )}
    </Card>
  );
}

function DerivedCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: "10px", color: COLOR.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div data-tnum style={{ fontSize: "14px", color: COLOR.textStrong, fontWeight: 700, marginTop: "2px" }}>
        {value}
      </div>
    </div>
  );
}

function PhotoThumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/health/photo-url?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; signed_url?: string }) => {
        if (!cancelled && j.ok && j.signed_url) setUrl(j.signed_url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!url) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ marginTop: "10px", padding: 0, background: "none", border: "none", cursor: "pointer" }}
        aria-label="View photo"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" style={{ width: "72px", height: "72px", objectFit: "cover", borderRadius: RADIUS.cardSmall }} />
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,20,48,0.85)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add components/health/MeasurementCard.tsx
git commit -m "feat(health): MeasurementCard (latest entry, deltas, derived ratios, photo)"
```

---

## Task 14: MeasurementHistory (Log view)

**Files:**
- Create: `components/health/MeasurementHistory.tsx`

- [ ] **Step 1: Write the component**

Create `components/health/MeasurementHistory.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { whr } from "@/lib/health/measurements";
import { queryKeys } from "@/lib/query/keys";
import type { BodyMeasurement } from "@/lib/data/types";

export function MeasurementHistory({
  userId,
  rows,
  weightByDate,
  onEdit,
}: {
  userId: string;
  rows: BodyMeasurement[];
  /** date → weight_kg from daily_logs, used to enrich each row's display. */
  weightByDate: Map<string, number | null>;
  onEdit: (row: BodyMeasurement) => void;
}) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <Card>
        <p style={{ fontSize: "13px", color: COLOR.textFaint }}>
          No measurements logged yet.
        </p>
      </Card>
    );
  }

  async function onDelete(id: string) {
    if (!window.confirm("Delete this measurement? This also removes the photo.")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/health/measurements/${id}`, { method: "DELETE" });
      if (res.ok) {
        qc.invalidateQueries({ queryKey: queryKeys.bodyMeasurements.all(userId) });
      } else {
        alert("Delete failed");
      }
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card>
      <div style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: "10px" }}>
        History · {rows.length}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr 0.8fr", gap: "4px 8px", fontSize: "10px", fontWeight: 700, color: COLOR.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", padding: "4px 0", borderBottom: `1px solid ${COLOR.divider}` }}>
        <span>Date</span>
        <span style={{ textAlign: "right" }}>Mid waist</span>
        <span style={{ textAlign: "right" }}>Weight</span>
        <span style={{ textAlign: "right" }}>Hips</span>
        <span style={{ textAlign: "right" }}>WHR</span>
      </div>
      {rows.map((r) => {
        const w = weightByDate.get(r.measured_on) ?? null;
        const whrVal = whr(r);
        const expanded = openId === r.id;
        return (
          <div key={r.id} style={{ borderBottom: `1px solid ${COLOR.divider}` }}>
            <button
              type="button"
              onClick={() => setOpenId(expanded ? null : r.id)}
              style={{ width: "100%", display: "grid", gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr 0.8fr", gap: "4px 8px", padding: "8px 0", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontSize: "12px" }}
            >
              <span style={{ color: COLOR.textStrong, fontWeight: 600 }}>
                {r.measured_on}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {fmtNum(r.mid_waist_cm)}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {fmtNum(w)}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {fmtNum(r.hips_cm)}
              </span>
              <span data-tnum style={{ textAlign: "right", color: COLOR.textMid }}>
                {whrVal == null ? "—" : fmtNum(whrVal, 3)}
              </span>
            </button>
            {expanded && (
              <div style={{ padding: "8px 0 12px", display: "grid", gap: "6px" }}>
                <DetailGrid row={r} />
                {r.notes && (
                  <div style={{ fontSize: "12px", color: COLOR.textMid, fontStyle: "italic" }}>
                    {r.notes}
                  </div>
                )}
                <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                  <button
                    type="button"
                    onClick={() => onEdit(r)}
                    style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={deletingId === r.id}
                    onClick={() => void onDelete(r.id)}
                    style={{ background: "none", color: COLOR.danger, border: `1px solid ${COLOR.danger}`, borderRadius: RADIUS.pill, padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                  >
                    {deletingId === r.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function DetailGrid({ row }: { row: BodyMeasurement }) {
  const ROWS: { label: string; value: number | null }[] = [
    { label: "Neck",            value: row.neck_cm },
    { label: "Left arm",        value: row.left_upper_arm_cm },
    { label: "Right arm",       value: row.right_upper_arm_cm },
    { label: "Chest",           value: row.chest_cm },
    { label: "High waist",      value: row.high_waist_cm },
    { label: "Mid waist",       value: row.mid_waist_cm },
    { label: "Low waist",       value: row.low_waist_cm },
    { label: "Hips",            value: row.hips_cm },
    { label: "Left thigh",      value: row.left_thigh_cm },
    { label: "Left thigh (min)",  value: row.left_thigh_min_cm },
    { label: "Right thigh",     value: row.right_thigh_cm },
    { label: "Right thigh (min)", value: row.right_thigh_min_cm },
    { label: "Left calf",       value: row.left_calf_cm },
    { label: "Right calf",      value: row.right_calf_cm },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: "12px" }}>
      {ROWS.map((r) => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: COLOR.textMuted }}>{r.label}</span>
          <span data-tnum style={{ color: COLOR.textStrong, fontWeight: 600 }}>
            {fmtNum(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add components/health/MeasurementHistory.tsx
git commit -m "feat(health): MeasurementHistory list (Log view) with edit/delete"
```

---

## Task 15: TrendView

**Files:**
- Create: `components/health/TrendView.tsx`

- [ ] **Step 1: Write the component**

Create `components/health/TrendView.tsx`:

```typescript
"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { CIRCUMFERENCE_METRICS } from "@/lib/charts/circumferenceChartConfig";
import type { HealthTrendPoint } from "@/lib/query/fetchers/healthTrend";
import type { BodyMeasurement } from "@/lib/data/types";

const RANGES = [
  { id: "3m",  label: "3M",  days: 90 },
  { id: "6m",  label: "6M",  days: 180 },
  { id: "1y",  label: "1Y",  days: 365 },
  { id: "all", label: "All", days: 0 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

export function TrendView({
  bodyComp,
  measurements,
  todayIso,
}: {
  bodyComp: HealthTrendPoint[];
  measurements: BodyMeasurement[]; // newest-first
  todayIso: string;
}) {
  const [range, setRange] = useState<RangeId>("1y");

  const cutoff = useMemo(() => {
    const r = RANGES.find((x) => x.id === range)!;
    if (r.days === 0) return null;
    const d = new Date(todayIso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - r.days);
    return d.toISOString().slice(0, 10);
  }, [range, todayIso]);

  const filteredBodyComp = useMemo(
    () => (cutoff ? bodyComp.filter((p) => p.date >= cutoff) : bodyComp),
    [bodyComp, cutoff],
  );

  // measurements is newest-first; we need oldest-first for sparklines
  const measAsc = useMemo(() => [...measurements].reverse(), [measurements]);
  const filteredMeas = useMemo(
    () => (cutoff ? measAsc.filter((m) => m.measured_on >= cutoff) : measAsc),
    [measAsc, cutoff],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Range
        </span>
        <div style={{ display: "flex", gap: "6px" }}>
          {RANGES.map((r) => {
            const active = r.id === range;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setRange(r.id)}
                style={{
                  padding: "6px 10px",
                  fontSize: "11px",
                  fontWeight: 700,
                  border: "none",
                  borderRadius: RADIUS.pill,
                  background: active ? COLOR.accent : COLOR.surfaceAlt,
                  color: active ? "#fff" : COLOR.textMid,
                  cursor: "pointer",
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <BodyCompTrendCards points={filteredBodyComp} />

      <CircumferenceSparklines measurements={filteredMeas} />
    </div>
  );
}

function BodyCompTrendCards({ points }: { points: HealthTrendPoint[] }) {
  const FIELDS: { key: keyof HealthTrendPoint; label: string; unit: string; color: string }[] = [
    { key: "weight_kg",        label: "Weight",    unit: "kg", color: "#4f5dff" },
    { key: "body_fat_pct",     label: "Body fat",  unit: "%",  color: "#ef4444" },
    { key: "fat_free_mass_kg", label: "Lean mass", unit: "kg", color: "#14b870" },
    { key: "muscle_mass_kg",   label: "Muscle",    unit: "kg", color: "#3b82f6" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
      {FIELDS.map((f) => {
        const series = points
          .map((p) => ({ x: p.date, y: (p[f.key] as number | null) ?? null }))
          .filter((p) => p.y != null) as { x: string; y: number }[];
        const first = series[0]?.y ?? null;
        const last = series[series.length - 1]?.y ?? null;
        const d = first != null && last != null ? last - first : null;
        return (
          <Card variant="compact" key={f.key as string}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {f.label}
            </div>
            <div data-tnum style={{ fontSize: "18px", fontWeight: 700, color: COLOR.textStrong, marginTop: "4px" }}>
              {fmtNum(last)} <span style={{ fontSize: "11px", color: COLOR.textMuted }}>{f.unit}</span>
            </div>
            <div data-tnum style={{ fontSize: "11px", color: d == null ? COLOR.textFaint : d < 0 ? COLOR.success : COLOR.danger, fontWeight: 600 }}>
              {d == null ? "—" : `${d > 0 ? "+" : ""}${fmtNum(d)}`} since start
            </div>
            <Sparkline series={series} color={f.color} />
          </Card>
        );
      })}
    </div>
  );
}

function CircumferenceSparklines({ measurements }: { measurements: BodyMeasurement[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
      {CIRCUMFERENCE_METRICS.map((m) => {
        const series = measurements
          .map((row) => ({ x: row.measured_on, y: m.read(row) }))
          .filter((p) => p.y != null) as { x: string; y: number }[];
        const first = series[0]?.y ?? null;
        const last = series[series.length - 1]?.y ?? null;
        const d = first != null && last != null ? last - first : null;
        return (
          <Card variant="compact" key={m.id}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {m.label}
            </div>
            <div data-tnum style={{ fontSize: "18px", fontWeight: 700, color: COLOR.textStrong, marginTop: "4px" }}>
              {last == null ? "—" : fmtNum(last, m.id === "whr" ? 3 : 1)}
              {m.unit && <span style={{ fontSize: "11px", color: COLOR.textMuted, marginLeft: "4px" }}>{m.unit}</span>}
            </div>
            <div data-tnum style={{ fontSize: "11px", color: d == null ? COLOR.textFaint : d < 0 ? COLOR.success : COLOR.danger, fontWeight: 600 }}>
              {d == null ? "—" : `${d > 0 ? "+" : ""}${fmtNum(d, m.id === "whr" ? 3 : 1)}`} since start
            </div>
            <Sparkline series={series} color={m.color} />
          </Card>
        );
      })}
    </div>
  );
}

/** Minimal SVG sparkline — avoids depending on /trends' chart primitives
 *  (their range pills and interpolation aren't needed at this resolution). */
function Sparkline({ series, color }: { series: { x: string; y: number }[]; color: string }) {
  if (series.length < 2) {
    return (
      <div style={{ height: "32px", display: "flex", alignItems: "center", fontSize: "10px", color: COLOR.textFaint }}>
        Need ≥ 2 points
      </div>
    );
  }
  const values = series.map((p) => p.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const W = 120;
  const H = 32;
  const range = max - min || 1;
  const pts = series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * W;
      const y = H - ((p.y - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ marginTop: "6px", display: "block" }}>
      <polyline fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" points={pts} />
      {series.map((_, i) => {
        const x = (i / (series.length - 1)) * W;
        const y = H - ((series[i].y - min) / range) * H;
        return <circle key={i} cx={x} cy={y} r={1.6} fill={color} />;
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add components/health/TrendView.tsx
git commit -m "feat(health): TrendView with body-comp + circumference sparklines"
```

---

## Task 16: HealthClient orchestrator

**Files:**
- Create: `components/health/HealthClient.tsx`

- [ ] **Step 1: Write the component**

Create `components/health/HealthClient.tsx`:

```typescript
"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { useBodyMeasurements } from "@/lib/query/hooks/useBodyMeasurements";
import { useHealthTrend } from "@/lib/query/hooks/useHealthTrend";
import { HealthNav, type HealthView } from "@/components/health/HealthNav";
import { BodyCompCard } from "@/components/health/BodyCompCard";
import { MeasurementCard } from "@/components/health/MeasurementCard";
import { MeasurementHistory } from "@/components/health/MeasurementHistory";
import { TrendView } from "@/components/health/TrendView";
import { MeasurementForm } from "@/components/health/MeasurementForm";
import type { BodyMeasurement } from "@/lib/data/types";

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86_400_000);
}

export function HealthClient({
  userId,
  todayIso,
  trendFromIso,
  initialView,
}: {
  userId: string;
  todayIso: string;
  /** ymFrom — 12 months before todayIso, ISO date. */
  trendFromIso: string;
  initialView: HealthView;
}) {
  const [view, setView] = useState<HealthView>(initialView);
  const [editing, setEditing] = useState<BodyMeasurement | null | "new">(null);

  const meas = useBodyMeasurements(userId);
  const bodyComp = useHealthTrend(userId, trendFromIso, todayIso);

  const measRows = meas.data ?? [];
  const latest = measRows[0] ?? null;
  const prev = measRows[1] ?? null;

  const bodyCompPoints = bodyComp.data ?? [];

  // Map daily_logs date → weight_kg for the Log view's joined display.
  const weightByDate = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const p of bodyCompPoints) m.set(p.date, p.weight_kg);
    return m;
  }, [bodyCompPoints]);

  const existingDates = useMemo(() => measRows.map((r) => r.measured_on), [measRows]);

  const overdue =
    latest && daysBetween(latest.measured_on, todayIso) > 30
      ? daysBetween(latest.measured_on, todayIso)
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "12px", paddingBottom: "100px" }}>
      <HealthNav active={view} onChange={setView} />

      {view === "today" && (
        <>
          {overdue !== null && (
            <Card variant="compact">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                <span style={{ fontSize: "13px", color: COLOR.textMid }}>
                  Last measured {overdue} days ago
                </span>
                <button
                  type="button"
                  onClick={() => setEditing("new")}
                  style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                >
                  Log new
                </button>
              </div>
            </Card>
          )}

          <BodyCompCard points={bodyCompPoints} todayIso={todayIso} />

          <MeasurementCard
            latest={latest}
            prev={prev}
            onLogNew={() => setEditing("new")}
            onEdit={() => latest && setEditing(latest)}
          />

          {latest && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "12px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}
            >
              + Log new measurement
            </button>
          )}
        </>
      )}

      {view === "trend" && (
        <TrendView
          bodyComp={bodyCompPoints}
          measurements={measRows}
          todayIso={todayIso}
        />
      )}

      {view === "log" && (
        <>
          <MeasurementHistory
            userId={userId}
            rows={measRows}
            weightByDate={weightByDate}
            onEdit={(row) => setEditing(row)}
          />
          <button
            type="button"
            onClick={() => setEditing("new")}
            style={{ background: COLOR.accent, color: "#fff", border: "none", borderRadius: RADIUS.pill, padding: "12px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}
          >
            + Log new measurement
          </button>
        </>
      )}

      {editing !== null && (
        <MeasurementForm
          userId={userId}
          existing={editing === "new" ? null : editing}
          existingDates={existingDates}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add components/health/HealthClient.tsx
git commit -m "feat(health): HealthClient orchestrator (view + modal state)"
```

---

## Task 17: app/health/page.tsx + loading.tsx

**Files:**
- Create: `app/health/page.tsx`
- Create: `app/health/loading.tsx`

- [ ] **Step 1: Write the loading skeleton**

Create `app/health/loading.tsx` (a thin two-card skeleton matching the Today view's shape):

```typescript
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

export default function Loading() {
  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <Card>
        <div style={{ height: "16px", background: COLOR.surfaceAlt, borderRadius: "6px", marginBottom: "12px", width: "40%" }} />
        <div style={{ height: "120px", background: COLOR.surfaceAlt, borderRadius: "10px" }} />
      </Card>
      <Card>
        <div style={{ height: "16px", background: COLOR.surfaceAlt, borderRadius: "6px", marginBottom: "12px", width: "60%" }} />
        <div style={{ height: "240px", background: COLOR.surfaceAlt, borderRadius: "10px" }} />
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `app/health/page.tsx`:

```typescript
import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { queryKeys } from "@/lib/query/keys";
import { fetchBodyMeasurementsServer } from "@/lib/query/fetchers/bodyMeasurements";
import { fetchHealthTrendServer } from "@/lib/query/fetchers/healthTrend";
import { HealthClient } from "@/components/health/HealthClient";
import type { HealthView } from "@/components/health/HealthNav";
import { todayInUserTz } from "@/lib/time";

export const revalidate = 60;

function ymFrom(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 12);
  return d.toISOString().slice(0, 10);
}

export default async function HealthPage(props: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await props.searchParams;
  const initialView: HealthView =
    sp.view === "trend" ? "trend" : sp.view === "log" ? "log" : "today";

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const todayIso = todayInUserTz();
  const trendFromIso = ymFrom(todayIso);
  const queryClient = makeServerQueryClient();

  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.bodyMeasurements.all(user.id),
      queryFn: () => fetchBodyMeasurementsServer(supabase, user.id),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.healthTrend.range(user.id, trendFromIso, todayIso),
      queryFn: () => fetchHealthTrendServer(supabase, user.id, trendFromIso, todayIso),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HealthClient
        userId={user.id}
        todayIso={todayIso}
        trendFromIso={trendFromIso}
        initialView={initialView}
      />
    </HydrationBoundary>
  );
}
```

- [ ] **Step 3: Typecheck + dev smoke**

```bash
npm run typecheck
```

Then run `npm run dev`, log in, navigate to http://localhost:3000/health. Expected:
- Page renders Today view (default).
- Empty state in MeasurementCard ("Log your first measurement").
- BodyCompCard shows 5 fields (weight, body fat, fat mass, lean mass, muscle) with values from the latest non-null daily_logs row, deltas may show "—" if no 30d-prior reading exists.
- Sub-nav switches to Trend / Log without page reload.

- [ ] **Step 4: Commit**

```bash
git add app/health/loading.tsx app/health/page.tsx
git commit -m "feat(health): /health route + loading skeleton + server prefetch"
```

---

## Task 18: BodyTile on home dashboard + FAB link

**Files:**
- Create: `components/dashboard/BodyTile.tsx`
- Modify: [app/page.tsx](../../../app/page.tsx) — render `<BodyTile>` near `<RecentLiftsCard>`
- Modify: [components/layout/Fab.tsx](../../../components/layout/Fab.tsx) — add Body item to `ITEMS`

- [ ] **Step 1: Write `BodyTile`**

The tile needs the latest body comp (from `daily_logs`) and the latest measurement (from `body_measurements`). To keep `app/page.tsx` simple, BodyTile is a Server Component that does its own two-query fetch.

Create `components/dashboard/BodyTile.tsx`:

```typescript
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";

function isoNDaysAgo(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function BodyTile({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const todayIso = todayInUserTz();
  // Reach back 60 days so the 30d-prior baseline lookup (today-35 .. today-25)
  // has a chance of hitting a non-null reading even when Withings sync gaps.
  const lookbackFromIso = isoNDaysAgo(todayIso, 60);

  // Pull recent body-comp + latest measurement in parallel.
  const [{ data: logs }, { data: meas }] = await Promise.all([
    supabase
      .from("daily_logs")
      .select("date, weight_kg")
      .eq("user_id", userId)
      .gte("date", lookbackFromIso)
      .lte("date", todayIso)
      .not("weight_kg", "is", null)
      .order("date", { ascending: false })
      .limit(60),
    supabase
      .from("body_measurements")
      .select("measured_on, mid_waist_cm")
      .eq("user_id", userId)
      .order("measured_on", { ascending: false })
      .limit(2),
  ]);

  // Latest weight + 30d-prior baseline (nearest non-null in [today-35, today-25]).
  const weightLatest = logs && logs.length ? (logs[0].weight_kg as number | null) : null;
  let weightBaseline: number | null = null;
  if (logs && logs.length) {
    const lo = isoNDaysAgo(todayIso, 35);
    const hi = isoNDaysAgo(todayIso, 25);
    for (const r of logs) {
      const d = r.date as string;
      if (d >= lo && d <= hi && r.weight_kg != null) {
        weightBaseline = r.weight_kg as number;
        break;
      }
    }
  }
  const dWeight =
    weightLatest != null && weightBaseline != null ? weightLatest - weightBaseline : null;

  // Latest mid-waist + Δ vs prior measurement (any cadence).
  const mLatest = meas && meas.length ? meas[0] : null;
  const mPrev = meas && meas.length > 1 ? meas[1] : null;
  const waistLatest = mLatest?.mid_waist_cm ?? null;
  const dWaist =
    waistLatest != null && mPrev?.mid_waist_cm != null
      ? waistLatest - (mPrev.mid_waist_cm as number)
      : null;

  // Overdue chip
  let overdue = false;
  if (mLatest) {
    const last = new Date(mLatest.measured_on + "T00:00:00Z");
    const today = new Date(todayIso + "T00:00:00Z");
    overdue = (today.getTime() - last.getTime()) / 86_400_000 > 30;
  }

  return (
    <Link href="/health" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
          <span style={{ fontSize: "11px", fontWeight: 700, color: COLOR.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Body
          </span>
          <span style={{ fontSize: "11px", color: COLOR.accent, fontWeight: 600 }}>
            {overdue ? "30d+ overdue ›" : "Open ›"}
          </span>
        </div>

        <Row label="Weight" value={weightLatest} unit="kg" delta={dWeight} goodWhenLower />
        <Row
          label="Mid waist"
          value={waistLatest}
          unit="cm"
          delta={dWaist}
          goodWhenLower
          emptyHint={mLatest ? null : "Log first measurement"}
        />
      </Card>
    </Link>
  );
}

function Row({
  label,
  value,
  unit,
  delta,
  goodWhenLower,
  emptyHint,
}: {
  label: string;
  value: number | null;
  unit: string;
  delta: number | null;
  goodWhenLower: boolean;
  emptyHint?: string | null;
}) {
  if (value == null && emptyHint) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: `1px solid ${COLOR.divider}`, fontSize: "13px" }}>
        <span style={{ color: COLOR.textMid }}>{label}</span>
        <span style={{ color: COLOR.textFaint, fontStyle: "italic" }}>{emptyHint}</span>
      </div>
    );
  }
  const dColor =
    delta == null
      ? COLOR.textFaint
      : delta === 0
      ? COLOR.textFaint
      : (goodWhenLower ? delta < 0 : delta > 0)
      ? COLOR.success
      : COLOR.danger;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "10px", padding: "6px 0", borderTop: `1px solid ${COLOR.divider}`, alignItems: "baseline" }}>
      <span style={{ fontSize: "13px", color: COLOR.textMid }}>{label}</span>
      <span data-tnum style={{ fontSize: "14px", color: COLOR.textStrong, fontWeight: 700, textAlign: "right" }}>
        {fmtNum(value)} {unit}
      </span>
      <span data-tnum style={{ fontSize: "11px", color: dColor, fontWeight: 600, textAlign: "right" }}>
        {delta == null ? "—" : `${delta > 0 ? "+" : ""}${fmtNum(delta)}`}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Add `<BodyTile>` to `app/page.tsx`**

Locate the existing render site of `<RecentLiftsCard>`:

```bash
grep -n "RecentLiftsCard" app/page.tsx
```

Add the import alongside the existing `RecentLiftsCard` import:

```typescript
import { BodyTile } from "@/components/dashboard/BodyTile";
```

In the JSX, render `<BodyTile userId={user.id} />` immediately **after** the `<RecentLiftsCard ... />` element, inside the same parent container. If the surrounding markup wraps `<RecentLiftsCard>` in a `<Suspense fallback={...}>`, copy the same wrapping for `<BodyTile>` — read the surrounding 5 lines to confirm. If `<RecentLiftsCard>` is rendered bare, render `<BodyTile>` bare too.

- [ ] **Step 3: Add Body to FAB**

In [components/layout/Fab.tsx](../../../components/layout/Fab.tsx), update the `ITEMS` array (currently lines 21-27) — add Body adjacent to Strength:

```typescript
const ITEMS: SheetItem[] = [
  { kind: "link",   label: "Log entry",          icon: "✎",  href: "/log" },
  { kind: "chat",   label: "Ask coach",          icon: "💬" },
  { kind: "link",   label: "Strength",           icon: "💪", href: "/strength?view=today" },
  { kind: "link",   label: "Body",               icon: "📏", href: "/health" },
  { kind: "upload", label: "Upload Strong CSV",  icon: "⬆",  accept: ".csv", endpoint: "/api/ingest/strong" },
  { kind: "link",   label: "Manage connections", icon: "🔗", href: "/profile" },
];
```

- [ ] **Step 4: Typecheck + dev smoke + commit**

```bash
npm run typecheck
```

Run `npm run dev`. On `/`, the home dashboard now renders a "Body" card showing weight + mid-waist (or "Log first measurement" hint). The FAB sheet contains a "Body" entry that navigates to `/health`.

```bash
git add components/dashboard/BodyTile.tsx app/page.tsx components/layout/Fab.tsx
git commit -m "feat(health): BodyTile on dashboard + Body in FAB sheet"
```

---

## Task 19: CLAUDE.md updates

**Files:**
- Modify: [CLAUDE.md](../../../CLAUDE.md)

- [ ] **Step 1: Append migration step**

In CLAUDE.md's `## Database migrations` section, append a new numbered step (the existing list ends at step 7 for `0008_weekly_planning.sql`):

```markdown
8. [supabase/migrations/0009_body_measurements.sql](supabase/migrations/0009_body_measurements.sql) — adds `body_measurements` (monthly circumference rows, 14 numeric fields + photo_path + notes, unique on `(user_id, measured_on)`); also requires the `health-photos` private Storage bucket created beforehand (Storage RLS policies attach to it)
```

- [ ] **Step 2: Add ownership note**

In CLAUDE.md's `### Data sources & precedence` section, append a new bullet to the existing list:

```markdown
- **Body measurements** ([components/health/MeasurementForm.tsx](components/health/MeasurementForm.tsx), API at [app/api/health/measurements/route.ts](app/api/health/measurements/route.ts)) — owns the 14 circumference fields on the `body_measurements` table. Distinct from Withings body composition (which writes to `daily_logs`); circumferences live in their own table because cadence is monthly and rows own a photo. Photos sit in the `health-photos` private Storage bucket under `${user_id}/measurements/...`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document 0009 migration + body_measurements ownership"
```

---

## Task 20: End-to-end smoke verification

No new files. Exercise the full flow locally and confirm before merging.

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 2: Run dev server, log in**

```bash
npm run dev
```

Open http://localhost:3000, log in.

- [ ] **Step 3: Navigate to `/health`**

Click the FAB → "Body". URL should be `/health`. Today view loads with:
- BodyCompCard showing latest Withings body comp + 30d deltas (or `—` deltas if no 30d-prior reading exists).
- MeasurementCard empty state ("Log your first measurement").

- [ ] **Step 4: Log a measurement (no photo)**

Tap "Log first measurement" → modal opens with today's date.

Type values into 4-5 fields, mix of groups (e.g., neck=38.6, chest=115.8, mid_waist=112.5, hips=116.6, left_thigh=70.1).

Save. Modal closes; MeasurementCard re-renders showing the new entry, deltas all `—` (no prior). Derived row shows WHR ≈ 0.965.

- [ ] **Step 5: Log a second measurement (with photo)**

Pick "yesterday" via the date input.

Tap "Attach scanner screenshot" → pick any local image. Wait for thumbnail.

Type the same fields with slightly different numbers. Save.

Check that:
- Modal closes.
- Today still shows yesterday's entry as `prev` (because today's entry from Step 4 is the most recent on insert order — but `measured_on` desc ordering means today wins). Re-check: latest = today's row (Step 4), prev = yesterday's row (Step 5). Δ values populated.
- Photo thumbnail visible on today's card; tap → fullscreen.

- [ ] **Step 6: Trend view**

Switch to Trend pill. Verify:
- Body comp cards show 4 metrics with current values + sparklines.
- Circumference sparklines show 6 cards; "Need ≥ 2 points" hint appears for fields where you only entered one value.

- [ ] **Step 7: Log view**

Switch to Log pill. Verify:
- 2 rows ordered newest first.
- Tap a row → expands, shows all 14 fields + Edit/Delete buttons.

Tap Edit on the older row → modal preloads its values + photo path. Cancel.

- [ ] **Step 8: Delete**

Expand the older row → Delete → confirm. Row disappears, list re-renders, Today's MeasurementCard updates (prev = null again).

- [ ] **Step 9: Overdue banner**

Stop the dev server. In Supabase SQL Editor, manually backdate the remaining row 35 days:

```sql
update body_measurements
set measured_on = current_date - 35
where user_id = auth.uid();
```

Restart dev server, refresh `/health`. Today view should show the soft "Last measured 35 days ago" banner above the card.

(Roll back the backdate when done: re-edit via the Edit modal to set `measured_on` back to today, or re-create.)

- [ ] **Step 10: Verify `/` dashboard tile**

Navigate to `/`. The Body tile shows weight + mid-waist with deltas. If the row is still backdated > 30d, the tile shows "30d+ overdue ›" in the header. Tap → lands on `/health`.

- [ ] **Step 11: Final commit (optional, if any wire-up tweaks)**

If smoke testing surfaced minor fixes (typos, missing imports, etc.), commit them under:

```bash
git commit -m "fix(health): smoke-test wire-up"
```

- [ ] **Step 12: Push branch + open PR**

```bash
git push -u origin feat/health-tab
gh pr create --title "feat: health tab — body comp + monthly measurements" \
  --body "$(cat <<'EOF'
Implements [docs/superpowers/specs/2026-05-10-health-tab-design.md](docs/superpowers/specs/2026-05-10-health-tab-design.md).

- New `body_measurements` table (14 circumference fields + photo + notes), unique on `(user_id, measured_on)`.
- New `health-photos` private Storage bucket (must be created in Dashboard before applying migration `0009`).
- `/health` route mirroring `/strength`: Today (BodyCompCard + MeasurementCard) / Trend (body-comp + circumference sparklines) / Log (history + edit/delete).
- BodyTile on `/` dashboard, Body link in FAB sheet.
- Derived metrics (WHR, W:C, symmetry %) computed on read.
- Photo upload flow: separate endpoint, runs in parallel with form typing.
- Renderer-only "30d+" overdue nudge — no cron, no push.

Out of scope (follow-ons): OCR (`feat/health-ocr`), coach context (`feat/health-coach-context`), orphan-photo GC (`feat/health-storage-gc`), CSV import (`feat/health-csv-import`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

After completing all tasks, perform the self-review described in `superpowers:requesting-code-review` and address any issues before requesting human review of the PR.
