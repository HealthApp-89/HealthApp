import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { extractBearer, resolveIngestToken } from "@/lib/ingest/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Apple Health ingest webhook for the iOS Shortcut.
 *
 *  Authentication: Bearer token from `/api/ingest/token` (one per user).
 *  Source tag: optional `?source=` query (default 'apple_health'); 'yazio' is
 *  also accepted so the same Shortcut can route Yazio→HealthKit→here.
 *
 *  Body shape (all fields optional, partial updates merge by date):
 *  {
 *    "days": [
 *      {
 *        "date": "2026-04-30",
 *        "steps": 8421,
 *        "active_calories": 612,
 *        "calories": 2480,           // total: BMR + active
 *        "distance_km": 6.2,
 *        "exercise_min": 38,
 *        "weight_kg": 78.4,          // if Withings isn't connected
 *        "body_fat_pct": 18.2,
 *        "sleep_hours": 7.6,         // optional, WHOOP usually wins
 *        "calories_eaten": 2310,     // Yazio→HealthKit
 *        "protein_g": 165,
 *        "carbs_g": 230,
 *        "fat_g": 78
 *      }
 *    ],
 *    "workouts": [                   // optional — Strong→HealthKit lifts come this way
 *      {
 *        "external_id": "strong-2026-04-30-1",
 *        "date": "2026-04-30",
 *        "type": "Chest",
 *        "duration_min": 52,
 *        "notes": "felt strong on bench"
 *      }
 *    ]
 *  }
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const sourceParam = (url.searchParams.get("source") ?? "apple_health") as
    | "apple_health"
    | "strong"
    | "yazio";
  if (!["apple_health", "strong", "yazio"].includes(sourceParam)) {
    return NextResponse.json({ ok: false, error: "invalid_source" }, { status: 400 });
  }

  const raw = extractBearer(request);
  if (!raw) return NextResponse.json({ ok: false, reason: "missing_token" }, { status: 401 });

  const userId = await resolveIngestToken(raw, sourceParam);
  if (!userId) return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });

  let body: {
    days?: Array<Record<string, unknown>>;
    workouts?: Array<Record<string, unknown>>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient();
  const result: { days_upserted: number; workouts_upserted: number } = {
    days_upserted: 0,
    workouts_upserted: 0,
  };

  // ── Days ────────────────────────────────────────────────────────────────────
  const ALLOWED_DAY_FIELDS = new Set([
    "steps",
    "active_calories",
    "calories",
    "distance_km",
    "exercise_min",
    "weight_kg",
    "body_fat_pct",
    "sleep_hours",
    "sleep_score",
    "deep_sleep_hours",
    "rem_sleep_hours",
    "calories_eaten",
    "protein_g",
    "carbs_g",
    "fat_g",
    "notes",
  ]);

  // Apple Health quantities arrive as floats (e.g. Dietary Energy = 3543.4298 kcal),
  // but these columns are int in Postgres — round before upsert.
  const INT_DAY_FIELDS = new Set([
    "steps",
    "active_calories",
    "calories",
    "calories_eaten",
    "exercise_min",
  ]);

  if (Array.isArray(body.days) && body.days.length > 0) {
    const rows: Record<string, unknown>[] = [];
    for (const d of body.days) {
      const date = typeof d.date === "string" ? d.date.slice(0, 10) : null;
      if (!date) continue;
      const row: Record<string, unknown> = {
        user_id: userId,
        date,
        source: sourceParam,
        updated_at: new Date().toISOString(),
      };
      for (const [k, v] of Object.entries(d)) {
        if (k === "date") continue;
        if (!ALLOWED_DAY_FIELDS.has(k)) continue;
        if (v === null || v === undefined) continue;
        // iOS Shortcuts often serializes Dictionary values as JSON strings
        // even when the underlying HealthKit Magic Variable is numeric (e.g.
        // `"8421"` for steps). Coerce numeric strings up-front so a Postgres
        // type-mismatch on one field doesn't 500 the entire batch. Empty
        // strings (an empty HealthKit sample) are dropped rather than written
        // as NaN. `notes` is the only ALLOWED_DAY_FIELDS member that stays
        // textual; everything else maps to a numeric column.
        let val: unknown = v;
        if (typeof v === "string" && k !== "notes") {
          if (v.trim() === "") continue;
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          val = n;
        }
        if (INT_DAY_FIELDS.has(k) && typeof val === "number") {
          row[k] = Math.round(val);
        } else {
          row[k] = val;
        }
      }
      rows.push(row);
    }
    if (rows.length > 0) {
      const { error } = await sr
        .from("daily_logs")
        .upsert(rows, { onConflict: "user_id,date" });
      if (error) {
        // Surface the Postgres error in Vercel logs — Shortcuts swallows the
        // 500 response body unless the user added a "Show Result" step, so
        // without this an iOS-side type bug is invisible.
        console.error("[ingest/health] daily_logs upsert failed:", error.message, "rows:", rows);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }
      result.days_upserted = rows.length;
    }
  }

  // ── Workouts (header only — Strong CSV import handles sets) ────────────────
  if (Array.isArray(body.workouts) && body.workouts.length > 0) {
    const ALLOWED_WORKOUT_FIELDS = new Set([
      "external_id",
      "date",
      "type",
      "duration_min",
      "notes",
    ]);
    const rows: Record<string, unknown>[] = [];
    for (const w of body.workouts) {
      if (typeof w.external_id !== "string" || typeof w.date !== "string") continue;
      const row: Record<string, unknown> = {
        user_id: userId,
        source: sourceParam,
      };
      for (const [k, v] of Object.entries(w)) {
        if (!ALLOWED_WORKOUT_FIELDS.has(k)) continue;
        if (v === null || v === undefined) continue;
        // Same Shortcuts stringification quirk as the days loop above: a
        // stringified `duration_min` from a Magic Variable would otherwise
        // 500 the workouts upsert against the int column.
        if (k === "duration_min") {
          let n: number | null = null;
          if (typeof v === "number") n = v;
          else if (typeof v === "string" && v.trim() !== "") {
            const parsed = Number(v);
            if (Number.isFinite(parsed)) n = parsed;
          }
          if (n === null) continue;
          row[k] = Math.round(n);
        } else {
          row[k] = v;
        }
      }
      rows.push(row);
    }
    if (rows.length > 0) {
      const { error } = await sr
        .from("workouts")
        .upsert(rows, { onConflict: "user_id,external_id" });
      if (error) {
        console.error("[ingest/health] workouts upsert failed:", error.message, "rows:", rows);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }
      result.workouts_upserted = rows.length;
    }
  }

  // Invalidate ISR caches so the dashboard / trends / strength pick up
  // newly ingested Apple Health / Strong / Yazio data immediately.
  if (result.days_upserted > 0) {
    revalidatePath("/");
    revalidatePath("/trends");
  }
  if (result.workouts_upserted > 0) {
    revalidatePath("/strength");
  }
  return NextResponse.json({ ok: true, source: sourceParam, ...result });
}
