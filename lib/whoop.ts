import { createSupabaseServiceRoleClient } from "./supabase/server";

export const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

export const WHOOP_SCOPES = [
  "read:recovery",
  "read:sleep",
  "read:cycles",
  "read:workout",
  "read:profile",
  "offline",
];

export type WhoopTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
};

export type WhoopRecovery = {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  score?: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
};

export type WhoopCycle = {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end?: string;
  timezone_offset: string;
  score_state: string;
  score?: { strain: number; kilojoule: number; average_heart_rate: number; max_heart_rate: number };
};

export type WhoopSleep = {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  score_state: string;
  score?: {
    stage_summary?: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_no_data_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed?: { baseline_milli: number; need_from_sleep_debt_milli: number };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
};

export type WhoopWorkout = {
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_id: number;
  score_state: string;
  score?: { strain: number; average_heart_rate: number; max_heart_rate: number; kilojoule: number };
};

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.WHOOP_CLIENT_ID!,
    redirect_uri: process.env.WHOOP_REDIRECT_URI!,
    response_type: "code",
    scope: WHOOP_SCOPES.join(" "),
    state,
  });
  return `${WHOOP_AUTH_URL}?${params}`;
}

export async function exchangeCodeForTokens(code: string): Promise<WhoopTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.WHOOP_REDIRECT_URI!,
    client_id: process.env.WHOOP_CLIENT_ID!,
    client_secret: process.env.WHOOP_CLIENT_SECRET!,
  });
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`WHOOP token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function refreshTokens(refreshToken: string): Promise<WhoopTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.WHOOP_CLIENT_ID!,
    client_secret: process.env.WHOOP_CLIENT_SECRET!,
    scope: WHOOP_SCOPES.join(" "),
  });
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`WHOOP refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function saveTokens(userId: string, tokens: WhoopTokens, whoopUserId?: string) {
  const supabase = createSupabaseServiceRoleClient();
  const expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const { error } = await supabase.from("whoop_tokens").upsert({
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at,
    scope: tokens.scope ?? WHOOP_SCOPES.join(" "),
    whoop_user_id: whoopUserId ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getValidAccessToken(userId: string): Promise<string | null> {
  const supabase = createSupabaseServiceRoleClient();
  const { data } = await supabase.from("whoop_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  const expiresAt = new Date(data.expires_at).getTime();
  // Refresh if within 60s of expiry
  if (Date.now() < expiresAt - 60_000) return data.access_token;
  const refreshed = await refreshTokens(data.refresh_token);
  await saveTokens(userId, refreshed, data.whoop_user_id);
  return refreshed.access_token;
}

export async function whoopGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${WHOOP_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`WHOOP GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
