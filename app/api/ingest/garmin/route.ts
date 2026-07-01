import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { extractBearer, resolveIngestToken } from "@/lib/ingest/auth";
import {
  edwardsTrimp,
  banisterTrimp,
  trimpToStrain,
  type HrSample,
} from "@/lib/coach/garmin/derive-strain";
import { mapToDailyLogs, type GarminDayInput } from "@/lib/coach/garmin/map-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Age-based HRmax fallback when profile.age is present (Tanaka: 208 - 0.7*age).
// Refined by observed peaks would be better; v1 uses the estimate.
const DEFAULT_HR_MAX = 190;

const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hrv: z.number().nullish(),
  resting_hr: z.number().nullish(),
  training_readiness: z.number().nullish(),
  body_battery_low: z.number().nullish(),
  body_battery_peak: z.number().nullish(),
  sleep_hours: z.number().nullish(),
  sleep_score: z.number().nullish(),
  deep_sleep_hours: z.number().nullish(),
  rem_sleep_hours: z.number().nullish(),
  sleep_start_at: z.string().nullish(),
  sleep_end_at: z.string().nullish(),
  respiratory_rate: z.number().nullish(),
  steps: z.number().nullish(),
  distance_km: z.number().nullish(),
  calories: z.number().nullish(),
  active_calories: z.number().nullish(),
  spo2: z.number().nullish(),
  skin_temp_variation: z.number().nullish(),
  acute_load: z.number().nullish(),
  chronic_load: z.number().nullish(),
  vo2max: z.number().nullish(),
  // [epoch_ms, bpm] pairs, 2-min-sampled all-day HR (TRIMP input).
  hr_samples: z.array(z.tuple([z.number(), z.number()])).nullish(),
});

const bodySchema = z.object({ days: z.array(daySchema).max(31) });

export async function POST(request: Request) {
  const raw = extractBearer(request);
  if (!raw) return NextResponse.json({ ok: false, reason: "missing_token" }, { status: 401 });

  const userId = await resolveIngestToken(raw, "garmin");
  if (!userId) return NextResponse.json({ ok: false, reason: "invalid_token" }, { status: 401 });

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (e) {
    return NextResponse.json({ ok: false, error: "invalid_payload", detail: String(e) }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient();

  // Cutover knob: does Garmin own daily_logs yet?
  const { data: profile } = await sr
    .from("profiles")
    .select("metrics_source, age")
    .eq("user_id", userId)
    .maybeSingle();
  const garminOwnsDaily = profile?.metrics_source === "garmin";
  const hrMax = profile?.age ? Math.round(208 - 0.7 * profile.age) : DEFAULT_HR_MAX;

  const garminRows: Record<string, unknown>[] = [];
  const dailyRows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  for (const d of parsed.days) {
    const samples: HrSample[] = (d.hr_samples ?? []).map(([ts, bpm]) => ({ ts, bpm }));
    const hrRest = d.resting_hr ?? 50;
    const edw = samples.length ? edwardsTrimp(samples, hrMax) : null;
    const ban = samples.length ? banisterTrimp(samples, hrRest, hrMax) : null;
    // Edwards is the default strain source; swap to Banister after the
    // parallel-month calibration if it tracks WHOOP better (spec §5).
    const strain = edw !== null ? trimpToStrain(edw) : null;

    garminRows.push({
      user_id: userId,
      date: d.date,
      hrv: d.hrv ?? null,
      resting_hr: d.resting_hr ?? null,
      training_readiness: d.training_readiness ?? null,
      body_battery_low: d.body_battery_low ?? null,
      body_battery_peak: d.body_battery_peak ?? null,
      sleep_hours: d.sleep_hours ?? null,
      sleep_score: d.sleep_score ?? null,
      deep_sleep_hours: d.deep_sleep_hours ?? null,
      rem_sleep_hours: d.rem_sleep_hours ?? null,
      sleep_start_at: d.sleep_start_at ?? null,
      sleep_end_at: d.sleep_end_at ?? null,
      respiratory_rate: d.respiratory_rate ?? null,
      steps: d.steps != null ? Math.round(d.steps) : null,
      distance_km: d.distance_km ?? null,
      calories: d.calories != null ? Math.round(d.calories) : null,
      active_calories: d.active_calories != null ? Math.round(d.active_calories) : null,
      spo2: d.spo2 ?? null,
      skin_temp_variation: d.skin_temp_variation ?? null,
      acute_load: d.acute_load ?? null,
      chronic_load: d.chronic_load ?? null,
      vo2max: d.vo2max ?? null,
      strain,
      trimp_edwards: edw,
      trimp_banister: ban,
      raw: d,
      updated_at: now,
    });

    if (garminOwnsDaily) {
      // Strip hr_samples before mapping (not a daily_logs field).
      const { hr_samples: _omit, ...dayInput } = d;
      dailyRows.push({ ...mapToDailyLogs(dayInput as GarminDayInput, strain), user_id: userId, updated_at: now });
    }
  }

  if (garminRows.length > 0) {
    const { error } = await sr.from("garmin_daily").upsert(garminRows, { onConflict: "user_id,date" });
    if (error) {
      console.error("[ingest/garmin] garmin_daily upsert failed:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  let daysUpserted = 0;
  if (dailyRows.length > 0) {
    const { error } = await sr.from("daily_logs").upsert(dailyRows, { onConflict: "user_id,date" });
    if (error) {
      console.error("[ingest/garmin] daily_logs upsert failed:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    daysUpserted = dailyRows.length;
    revalidatePath("/");
    revalidatePath("/coach");
  }

  return NextResponse.json({
    ok: true,
    source: "garmin",
    garmin_daily_upserted: garminRows.length,
    daily_logs_upserted: daysUpserted,
    owns_daily: garminOwnsDaily,
  });
}
