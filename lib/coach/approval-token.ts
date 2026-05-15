// lib/coach/approval-token.ts
//
// HMAC-signed short-lived tokens that gate "this changes the user's plan"
// tool calls. Every propose_* tool emits a token; the matching commit_*
// tool requires it. Bounded validity prevents replay; payload-bound hash
// prevents drift between propose/commit phases.
//
// Server-only — uses process.env.COACH_TOOL_SECRET. Importing this module
// from a Client Component will throw at module-eval time.

import { createHash, createHmac } from "node:crypto";

const TOKEN_VERSION = "v1";
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function getSecret(): string {
  const s = process.env.COACH_TOOL_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "COACH_TOOL_SECRET must be set to a 32+ char random string. " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return s;
}

// Recursively sort object keys so nested structures (e.g. session_plan with
// weekday keys) serialize identically regardless of the order Postgres returns
// jsonb fields. Arrays are left in order — array order is semantic, not
// coincidental. `null` short-circuits at the top to keep it as-is.
function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(
    Object.keys(v as object)
      .sort()
      .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])
  );
}

function payloadHash(payload: unknown): string {
  // Inner integrity-check string — the outer signature via COACH_TOOL_SECRET
  // (signApprovalToken / verifyApprovalToken) provides the real authentication,
  // so this uses createHash, not createHmac.
  const stable = JSON.stringify(sortDeep(payload));
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/** Sign a token for a propose_* call. Caller hands the returned string back
 *  to the model in the tool_result. The chat UI later passes it to the
 *  matching commit_* call. */
export function signApprovalToken(args: {
  userId: string;
  action: "block" | "week" | "plan" | "weekly_review";
  payload: unknown;
}): string {
  const ts = Date.now();
  const ph = payloadHash(args.payload);
  const body = `${TOKEN_VERSION}.${args.userId}.${args.action}.${ph}.${ts}`;
  const mac = createHmac("sha256", getSecret()).update(body).digest("hex").slice(0, 24);
  return `${body}.${mac}`;
}

/** Verify a token. Returns the validated payload-hash + action; throws on
 *  any failure (bad shape, wrong user, wrong action, expired, bad MAC). */
export function verifyApprovalToken(args: {
  token: string;
  userId: string;
  action: "block" | "week" | "plan" | "weekly_review";
  payload: unknown;
}): { ok: true; payloadHash: string } {
  const parts = args.token.split(".");
  if (parts.length !== 6) throw new Error("approval-token: malformed token");
  const [version, uid, action, ph, tsRaw, mac] = parts;
  if (version !== TOKEN_VERSION) throw new Error("approval-token: version mismatch");
  if (uid !== args.userId) throw new Error("approval-token: user mismatch");
  if (action !== args.action) throw new Error("approval-token: action mismatch");
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) throw new Error("approval-token: bad timestamp");
  if (Date.now() - ts > TTL_MS) throw new Error("approval-token: expired");
  if (Date.now() - ts < 0) throw new Error("approval-token: future timestamp");

  const expectPh = payloadHash(args.payload);
  if (ph !== expectPh) throw new Error("approval-token: payload drift since propose");

  const body = `${version}.${uid}.${action}.${ph}.${ts}`;
  const expectMac = createHmac("sha256", getSecret()).update(body).digest("hex").slice(0, 24);
  if (mac !== expectMac) throw new Error("approval-token: signature mismatch");

  return { ok: true, payloadHash: ph };
}
