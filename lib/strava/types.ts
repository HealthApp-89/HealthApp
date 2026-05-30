// lib/strava/types.ts — Strava API response shapes (subset we consume).
// Full responses preserved in endurance_activities.raw for replay.

export type StravaTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  expires_in: number;
  token_type: "Bearer";
  athlete?: { id: number };
};

export type StravaActivitySummary = {
  id: number;
  external_id: string | null;
  name: string;
  type: string;          // "Ride" | "Run" | "Swim" | …
  sport_type?: string;   // newer field, prefer when present
  start_date: string;        // UTC iso
  start_date_local: string;  // ISO without tz suffix — already local
  timezone: string;          // e.g. "(GMT+04:00) Asia/Dubai"
  utc_offset: number;
  elapsed_time: number;      // seconds
  moving_time: number;
  distance: number;          // meters
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  average_speed?: number;    // m/s
  calories?: number;
  device_watts?: boolean;
};

export type StravaActivityDetail = StravaActivitySummary & {
  calories: number;
  description?: string;
  // detail endpoint returns much more; we keep what we use
};

export type StravaStream = {
  type: "heartrate" | "time" | "cadence" | "watts" | "distance";
  data: number[];
  series_type: "time" | "distance";
  original_size: number;
  resolution: "low" | "medium" | "high";
};

export type StravaWebhookEvent = {
  aspect_type: "create" | "update" | "delete";
  event_time: number;
  object_id: number;
  object_type: "activity" | "athlete";
  owner_id: number;
  subscription_id: number;
  updates?: Record<string, string>;
};
