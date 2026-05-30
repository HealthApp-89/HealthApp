// lib/strava/client.ts — fetch wrapper that auto-refreshes the access token.
// Mirrors the WHOOP pattern: read tokens from strava_tokens table via the
// service-role client, refresh if within 5min of expiry, persist back.

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type {
  StravaActivityDetail,
  StravaActivitySummary,
  StravaStream,
  StravaTokenResponse,
} from "./types";

const STRAVA_BASE = "https://www.strava.com/api/v3";
const REFRESH_BUFFER_S = 300; // refresh if expires within 5min

type Tokens = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
  strava_athlete_id: string | null;
};

async function readTokens(userId: string): Promise<Tokens | null> {
  const sb = createSupabaseServiceRoleClient();
  const { data, error } = await sb
    .from("strava_tokens")
    .select("user_id, access_token, refresh_token, expires_at, strava_athlete_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`readTokens: ${error.message}`);
  return data ?? null;
}

async function writeTokens(userId: string, t: StravaTokenResponse): Promise<void> {
  const sb = createSupabaseServiceRoleClient();
  const { error } = await sb.from("strava_tokens").upsert({
    user_id: userId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
    ...(t.athlete?.id ? { strava_athlete_id: String(t.athlete.id) } : {}),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`writeTokens: ${error.message}`);
}

async function refreshAccessToken(refreshToken: string): Promise<StravaTokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID ?? "",
    client_secret: process.env.STRAVA_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Strava token refresh failed ${r.status}: ${txt}`);
  }
  return (await r.json()) as StravaTokenResponse;
}

async function ensureFreshToken(userId: string): Promise<Tokens> {
  const t = await readTokens(userId);
  if (!t) throw new Error(`No strava_tokens row for user ${userId}; user must OAuth first.`);
  const expiresAtS = Math.floor(new Date(t.expires_at).getTime() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  if (expiresAtS - nowS > REFRESH_BUFFER_S) return t;
  const fresh = await refreshAccessToken(t.refresh_token);
  await writeTokens(userId, fresh);
  return {
    user_id: userId,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: new Date(fresh.expires_at * 1000).toISOString(),
    strava_athlete_id: t.strava_athlete_id,
  };
}

async function call<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
  const t = await ensureFreshToken(userId);
  const r = await fetch(`${STRAVA_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${t.access_token}` },
  });
  if (r.status === 401) {
    // Token died mid-flight; force refresh and retry once.
    const fresh = await refreshAccessToken(t.refresh_token);
    await writeTokens(userId, fresh);
    const r2 = await fetch(`${STRAVA_BASE}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${fresh.access_token}` },
    });
    if (!r2.ok) throw new Error(`Strava ${path} ${r2.status}: ${await r2.text()}`);
    return (await r2.json()) as T;
  }
  if (!r.ok) throw new Error(`Strava ${path} ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

export async function listActivities(
  userId: string,
  opts: { after?: number; before?: number; page?: number; perPage?: number } = {},
): Promise<StravaActivitySummary[]> {
  const q = new URLSearchParams();
  if (opts.after) q.set("after", String(opts.after));
  if (opts.before) q.set("before", String(opts.before));
  q.set("page", String(opts.page ?? 1));
  q.set("per_page", String(opts.perPage ?? 30));
  return call<StravaActivitySummary[]>(userId, `/athlete/activities?${q}`);
}

export async function getActivityDetail(userId: string, id: number): Promise<StravaActivityDetail> {
  return call<StravaActivityDetail>(userId, `/activities/${id}?include_all_efforts=false`);
}

export async function getActivityStreams(
  userId: string,
  id: number,
  keys: Array<"heartrate" | "watts" | "time" | "cadence" | "distance"> = ["heartrate", "time"],
): Promise<Record<string, StravaStream>> {
  const data = await call<StravaStream[]>(
    userId,
    `/activities/${id}/streams?keys=${keys.join(",")}&key_by_type=true`,
  );
  // When key_by_type=true Strava returns an object map, not an array, despite the docs.
  return data as unknown as Record<string, StravaStream>;
}

export async function deauthorizeUser(userId: string): Promise<void> {
  // Calls Strava's deauthorize endpoint and then nukes the local row.
  const t = await readTokens(userId);
  if (!t) return;
  await fetch("https://www.strava.com/oauth/deauthorize", {
    method: "POST",
    headers: { authorization: `Bearer ${t.access_token}` },
  }).catch((e) => { console.warn("[strava] deauthorize call failed (best-effort):", e); });
  const sb = createSupabaseServiceRoleClient();
  await sb.from("strava_tokens").delete().eq("user_id", userId);
}
