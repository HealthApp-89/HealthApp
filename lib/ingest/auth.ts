import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

const TOKEN_PREFIX = "ah_";

/** Generate a fresh ingest token. Caller is responsible for showing the raw
 *  token to the user exactly once and storing the hash. */
export function generateRawToken(): string {
  return TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function tokenPrefix(raw: string): string {
  return raw.slice(0, 11); // "ah_" + 8 chars
}

/** Resolve a raw bearer token to a user_id, or null if unknown.
 *  Updates last_used_at + last_used_source on success (best-effort, fire-and-forget). */
export async function resolveIngestToken(
  rawToken: string,
  source: "apple_health" | "strong" | "yazio",
): Promise<string | null> {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const expectedHash = hashToken(rawToken);

  const sr = createSupabaseServiceRoleClient();
  const { data } = await sr
    .from("ingest_tokens")
    .select("user_id, token_hash")
    .eq("token_hash", expectedHash)
    .maybeSingle();

  if (!data) return null;

  // timingSafeEqual on hex strings of equal length — defends against attackers
  // who can hash arbitrary inputs but still need a constant-time confirmation.
  const a = Buffer.from(data.token_hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Best-effort touch — never block the request on this.
  sr.from("ingest_tokens")
    .update({ last_used_at: new Date().toISOString(), last_used_source: source })
    .eq("user_id", data.user_id)
    .then(undefined, () => {});

  return data.user_id;
}

/** Pull bearer token from `Authorization: Bearer <token>` header,
 *  with a fallback to `?token=` query param for iOS Shortcut convenience. */
export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const url = new URL(req.url);
  return url.searchParams.get("token");
}
