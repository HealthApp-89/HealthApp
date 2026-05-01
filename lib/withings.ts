import { createSupabaseServiceRoleClient } from "./supabase/server";

// Withings API endpoints — all OAuth bodies/responses are wrapped in
// {"status": 0, "body": {...}}; non-zero status = error.
export const WITHINGS_AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
export const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";
export const WITHINGS_API_BASE = "https://wbsapi.withings.net";

// Scopes: metrics covers scale (weight, body fat, etc); activity covers steps/calories;
// info is the user identity for storage. We don't request sleep/HR — WHOOP owns those.
export const WITHINGS_SCOPES = ["user.metrics", "user.activity", "user.info"];

export type WithingsTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  userid?: number | string;
};

// Withings measurement type IDs we care about. Full list:
// https://developer.withings.com/api-reference/#tag/measure
export const WITHINGS_MEAS_TYPE = {
  WEIGHT: 1,            // kg
  FAT_FREE_MASS: 5,     // kg
  FAT_RATIO: 6,         // %
  FAT_MASS: 8,          // kg
  HEART_PULSE: 11,      // bpm
  MUSCLE_MASS: 76,      // kg
  HYDRATION: 77,        // kg
  BONE_MASS: 88,        // kg
} as const;

type WithingsBody<T> = { status: number; body: T; error?: string };

export type WithingsMeasureGroup = {
  grpid: number;
  date: number;        // unix seconds
  category: number;    // 1 = real, 2 = user-entered objective
  measures: { type: number; value: number; unit: number }[];
};

export type WithingsActivity = {
  date: string;        // YYYY-MM-DD
  steps?: number;
  distance?: number;   // meters
  elevation?: number;
  calories?: number;   // active kcal
  totalcalories?: number;
  hr_average?: number;
  hr_min?: number;
  hr_max?: number;
  soft?: number;       // light activity sec
  moderate?: number;   // moderate activity sec
  intense?: number;    // intense activity sec
};

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.WITHINGS_CLIENT_ID!,
    state,
    scope: WITHINGS_SCOPES.join(","),
    redirect_uri: process.env.WITHINGS_REDIRECT_URI!,
  });
  return `${WITHINGS_AUTH_URL}?${params}`;
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Withings ${url} HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as WithingsBody<T>;
  if (json.status !== 0) {
    throw new Error(`Withings ${url} status=${json.status}: ${json.error ?? "unknown"}`);
  }
  return json.body;
}

export async function exchangeCodeForTokens(code: string): Promise<WithingsTokens> {
  const body = new URLSearchParams({
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: process.env.WITHINGS_CLIENT_ID!,
    client_secret: process.env.WITHINGS_CLIENT_SECRET!,
    code,
    redirect_uri: process.env.WITHINGS_REDIRECT_URI!,
  });
  return postForm<WithingsTokens>(WITHINGS_TOKEN_URL, body);
}

export async function refreshTokens(refreshToken: string): Promise<WithingsTokens> {
  const body = new URLSearchParams({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: process.env.WITHINGS_CLIENT_ID!,
    client_secret: process.env.WITHINGS_CLIENT_SECRET!,
    refresh_token: refreshToken,
  });
  return postForm<WithingsTokens>(WITHINGS_TOKEN_URL, body);
}

export async function saveTokens(userId: string, tokens: WithingsTokens) {
  const supabase = createSupabaseServiceRoleClient();
  const expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const { error } = await supabase.from("withings_tokens").upsert({
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at,
    scope: tokens.scope ?? WITHINGS_SCOPES.join(","),
    withings_user_id: tokens.userid != null ? String(tokens.userid) : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getValidAccessToken(userId: string): Promise<string | null> {
  const supabase = createSupabaseServiceRoleClient();
  const { data } = await supabase
    .from("withings_tokens")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  const expiresAt = new Date(data.expires_at).getTime();
  // Refresh if within 60s of expiry. Withings rotates refresh_token on every refresh,
  // so we must persist the new one or the next call will 401.
  if (Date.now() < expiresAt - 60_000) return data.access_token;
  const refreshed = await refreshTokens(data.refresh_token);
  await saveTokens(userId, refreshed);
  return refreshed.access_token;
}

/** Withings API call. The endpoint is identified by `service` (e.g. "measure")
 *  and `action` is sent in the form body. All measure endpoints return wrapped
 *  responses; this unwraps to body and throws on non-zero status. */
export async function withingsCall<T>(
  accessToken: string,
  service: string,
  params: Record<string, string | number>,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  const res = await fetch(`${WITHINGS_API_BASE}/${service}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`Withings ${service} HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as WithingsBody<T>;
  if (json.status !== 0) {
    throw new Error(`Withings ${service} status=${json.status}: ${json.error ?? "unknown"}`);
  }
  return json.body;
}

/** Pull all measurement groups in a date window (unix seconds). Withings paginates
 *  via `more` + `offset`. Each group's `measures` array contains typed readings. */
export async function getMeasures(
  accessToken: string,
  startEpoch: number,
  endEpoch: number,
): Promise<WithingsMeasureGroup[]> {
  const out: WithingsMeasureGroup[] = [];
  let offset = 0;
  for (let i = 0; i < 50; i++) {
    const body = await withingsCall<{
      measuregrps: WithingsMeasureGroup[];
      more?: number;
      offset?: number;
    }>(accessToken, "measure", {
      action: "getmeas",
      meastypes: Object.values(WITHINGS_MEAS_TYPE).join(","),
      category: 1,
      startdate: startEpoch,
      enddate: endEpoch,
      offset,
    });
    out.push(...(body.measuregrps ?? []));
    if (!body.more) break;
    offset = body.offset ?? offset + body.measuregrps.length;
  }
  return out;
}

/** Daily activity rollups (steps, distance, calories, exercise minutes) per day. */
export async function getActivity(
  accessToken: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,
): Promise<WithingsActivity[]> {
  const body = await withingsCall<{ activities: WithingsActivity[] }>(
    accessToken,
    "v2/measure",
    {
      action: "getactivity",
      startdateymd: startDate,
      enddateymd: endDate,
      data_fields:
        "steps,distance,calories,totalcalories,hr_average,hr_min,hr_max,soft,moderate,intense",
    },
  );
  return body.activities ?? [];
}

/** Convert a Withings (value, unit) pair to a real number.
 *  unit is the power-of-ten exponent: real = value × 10^unit. */
export function toReal(value: number, unit: number): number {
  return value * Math.pow(10, unit);
}
