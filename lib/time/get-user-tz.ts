// lib/time/get-user-tz.ts
//
// Single accessor for the authoritative per-user timezone.
// Reads profiles.timezone via service-role; caches per-process for 10s
// (profile edits invalidate via invalidateUserTimezone).

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

type CacheEntry = { tz: string; at: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 10_000;

const FALLBACK_TZ = (process.env.USER_TIMEZONE || "Asia/Dubai").trim();

export async function getUserTimezone(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;
  const sb = createSupabaseServiceRoleClient();
  const { data } = await sb
    .from("profiles")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  const tz = (data?.timezone as string | undefined) ?? FALLBACK_TZ;
  cache.set(userId, { tz, at: Date.now() });
  return tz;
}

export function invalidateUserTimezone(userId: string): void {
  cache.delete(userId);
}
