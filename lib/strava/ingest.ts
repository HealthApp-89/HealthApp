// lib/strava/ingest.ts — Strava activity → endurance_activities row + daily_logs re-aggregation.
//
// Flow per activity:
//  1. fetch detail (we usually already have summary from list endpoint; detail adds calories)
//  2. fetch HR stream if HR was recorded
//  3. compute hr_zone_distribution + hrTSS using user's threshold_hr
//  4. upsert endurance_activities by (user_id, source, external_id)
//  5. call sum_endurance_for_day(user_id, local_date) and upsert daily_logs

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getActivityDetail, getActivityStreams } from "./client";
import { bucketZones } from "@/lib/coach/endurance/hr-zones";
import { computeTssForActivity } from "@/lib/coach/endurance/tss";
import type { StravaActivityDetail } from "./types";
import type { EnduranceProfile } from "@/lib/coach/endurance/types";
import type { HrZoneDistribution } from "@/lib/data/types";

function mapSport(t: string): "cycling" | "running" | "swimming" | "other" {
  const v = t.toLowerCase();
  if (v.includes("ride") || v.includes("cycl") || v === "virtualride") return "cycling";
  if (v.includes("run")) return "running";
  if (v.includes("swim")) return "swimming";
  return "other";
}

function localDateFromStrava(startLocalIso: string): string {
  // Strava's start_date_local is ISO without timezone suffix; it's already in
  // local time at the activity's start location. Slice the date portion.
  return startLocalIso.slice(0, 10);
}

async function readEnduranceProfile(userId: string): Promise<EnduranceProfile | null> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb
    .from("athlete_profile_documents")
    .select("endurance_profile")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`readEnduranceProfile: ${error.message}`);
  return (data?.endurance_profile as EnduranceProfile | null) ?? null;
}

export async function ingestActivity(args: {
  userId: string;
  stravaActivityId: number;
  prefetchedDetail?: StravaActivityDetail;
}): Promise<{ activityId: string; localDate: string }> {
  const { userId, stravaActivityId } = args;
  const sb = createSupabaseServiceRoleClient();

  const detail = args.prefetchedDetail ?? (await getActivityDetail(userId, stravaActivityId));
  const profile = await readEnduranceProfile(userId);
  const thresholdHr = profile?.threshold_hr ?? null;

  // HR-stream fetch only if HR was recorded; saves API calls.
  let hrZoneDist: HrZoneDistribution | null = null;
  if (detail.average_heartrate && thresholdHr) {
    try {
      const streams = await getActivityStreams(userId, stravaActivityId, ["heartrate"]);
      const hr = streams.heartrate?.data ?? [];
      hrZoneDist = bucketZones(hr, thresholdHr);
    } catch {
      // stream may 404 for some activities (rare); fall through
    }
  }

  const tss = computeTssForActivity({
    durationS: detail.moving_time,
    avgHr: detail.average_heartrate ?? null,
    thresholdHr,
    avgPowerW: detail.average_watts ?? null,
    ftpWatts: profile?.ftp_watts ?? null,
  });

  const localDate = localDateFromStrava(detail.start_date_local);

  const row = {
    user_id: userId,
    source: "strava" as const,
    external_id: String(detail.id),
    sport: mapSport(detail.sport_type ?? detail.type),
    started_at: detail.start_date,
    local_date: localDate,
    duration_s: detail.moving_time,
    distance_m: detail.distance ?? null,
    elevation_gain_m: detail.total_elevation_gain ?? null,
    avg_hr: detail.average_heartrate ? Math.round(detail.average_heartrate) : null,
    max_hr: detail.max_heartrate ? Math.round(detail.max_heartrate) : null,
    hr_zone_distribution: hrZoneDist,
    avg_power_w: detail.average_watts ? Math.round(detail.average_watts) : null,
    normalized_power_w: detail.weighted_average_watts ? Math.round(detail.weighted_average_watts) : null,
    intensity_factor: null as number | null,
    tss,
    avg_pace_s_per_km: detail.average_speed && detail.average_speed > 0
      ? Math.round(1000 / detail.average_speed)
      : null,
    avg_speed_kmh: detail.average_speed ? Math.round(detail.average_speed * 3.6 * 10) / 10 : null,
    calories: detail.calories ? Math.round(detail.calories) : null,
    raw: detail as unknown,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from("endurance_activities")
    .upsert(row, { onConflict: "user_id,source,external_id" })
    .select("id")
    .single();
  if (error) throw new Error(`upsert endurance_activities: ${error.message}`);

  await reaggregateDay(userId, localDate);
  return { activityId: data.id, localDate };
}

export async function softDeleteActivity(args: {
  userId: string;
  stravaActivityId: number;
}): Promise<void> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb
    .from("endurance_activities")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", args.userId)
    .eq("source", "strava")
    .eq("external_id", String(args.stravaActivityId))
    .select("local_date")
    .maybeSingle();
  if (error) throw new Error(`softDeleteActivity: ${error.message}`);
  if (data?.local_date) await reaggregateDay(args.userId, data.local_date);
}

export async function reaggregateDay(userId: string, localDate: string): Promise<void> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb.rpc("sum_endurance_for_day", { p_user_id: userId, p_date: localDate });
  if (error) throw new Error(`sum_endurance_for_day: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const tssSum = Number(row?.tss_sum ?? 0);
  const minSum = Number(row?.duration_minutes_sum ?? 0);
  const z2Sum = Number(row?.z2_minutes_sum ?? 0);
  const { error: upErr } = await sb
    .from("daily_logs")
    .upsert(
      {
        user_id: userId,
        date: localDate,
        endurance_load: tssSum,
        endurance_minutes: minSum,
        endurance_z2_minutes: z2Sum,
      },
      { onConflict: "user_id,date" },
    );
  if (upErr) throw new Error(`daily_logs upsert: ${upErr.message}`);
}
