// lib/coach/approval-token.ts
//
// HMAC-signed stateless tokens that gate "this changes the user's plan"
// tool calls. Every propose_* tool emits a token; the matching commit_*
// tool verifies it. Bounded validity prevents replay; the envelope is
// embedded in the token so commit_* needs no server-side cache to recover
// the proposal payload (survives multi-process Vercel deployments).
//
// Server-only — uses process.env.COACH_TOOL_SECRET. Importing this module
// from a Client Component will throw at module-eval time.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 2 as const;
const TTL_MS = 30 * 60 * 1000; // 30 minutes — users may step away to read a long proposal before approving

export type ApprovalAction = "block" | "week" | "plan" | "weekly_review" | "nutrition_targets";

// What gets HMAC-signed and embedded base64url in the token. `payload` is
// the full proposal for actions whose payload fits comfortably (block, week,
// weekly_review). For `plan`, the payload lives in athlete_profile_documents
// and the envelope carries only a reference + hash so the commit path can
// detect drift between propose and commit by comparing the DB row's hash to
// `ref.payload_hash`.
export type ApprovalEnvelope = {
  v: typeof TOKEN_VERSION;
  user_id: string;
  action: ApprovalAction;
  ts: number;
  payload?: unknown;
  ref?: { doc_id: string; payload_hash: string };
};

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
// jsonb fields. Arrays are left in order — array order is semantic. `undefined`
// values are stripped (matching JSON.stringify's behavior) so that a payload
// constructed with `{ rir_target: undefined }` hashes the same as one where
// the key was omitted entirely.
function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(
    Object.keys(v as object)
      .sort()
      .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])
      .filter(([, val]) => val !== undefined),
  );
}

/** Stable hash of a payload — used for ref-based drift detection (action=plan). */
export function payloadHash(payload: unknown): string {
  const stable = JSON.stringify(sortDeep(payload));
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function macOf(body: string): string {
  return createHmac("sha256", getSecret()).update(body).digest("hex").slice(0, 32);
}

/** Sign a token for a propose_* call. */
export function signApprovalToken(args: {
  userId: string;
  action: ApprovalAction;
  payload?: unknown;
  ref?: { doc_id: string; payload_hash: string };
}): string {
  const envelope: ApprovalEnvelope = {
    v: TOKEN_VERSION,
    user_id: args.userId,
    action: args.action,
    ts: Date.now(),
    ...(args.payload !== undefined ? { payload: sortDeep(args.payload) } : {}),
    ...(args.ref ? { ref: args.ref } : {}),
  };
  const body = b64urlEncode(JSON.stringify(envelope));
  const mac = macOf(body);
  return `${body}.${mac}`;
}

export type ApprovalTokenErrorCode =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "user_mismatch"
  | "action_mismatch"
  | "version_mismatch"
  | "future_timestamp";

export class ApprovalTokenError extends Error {
  readonly code: ApprovalTokenErrorCode;
  constructor(code: ApprovalTokenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Map an approval-token failure to a string safe to relay back to the user.
 *  Keeps technical detail in `code` for telemetry but never surfaces it to
 *  the chat surface — the user shouldn't read "signature mismatch" or
 *  "future timestamp." */
export function approvalTokenUserMessage(code: ApprovalTokenErrorCode): string {
  switch (code) {
    case "expired":
      return "That approval expired before it was committed. Tap Approve again to re-issue and commit.";
    case "bad_signature":
    case "malformed":
    case "version_mismatch":
      return "That approval token is invalid. Please re-propose and approve again.";
    case "user_mismatch":
      return "That approval belongs to a different account. Please re-propose.";
    case "action_mismatch":
      return "That approval was for a different action. Please re-propose.";
    case "future_timestamp":
      return "Clock skew detected on this approval. Try again in a few seconds.";
  }
}

/** Verify a token and return the decoded envelope. Throws ApprovalTokenError
 *  on any failure (bad shape, wrong user, wrong action, expired, bad MAC).
 *  The envelope's `payload` (block/week/weekly_review) or `ref` (plan) is
 *  what the executor uses to act — no cache lookup required. */
export function verifyApprovalToken(args: {
  token: string;
  userId: string;
  action: ApprovalAction;
}): ApprovalEnvelope {
  if (typeof args.token !== "string" || args.token.length < 32) {
    throw new ApprovalTokenError("malformed", "approval-token: empty or too short");
  }
  const parts = args.token.split(".");
  if (parts.length !== 2) {
    throw new ApprovalTokenError("malformed", "approval-token: malformed token");
  }
  const [body, mac] = parts;

  // Enforce mac shape explicitly — Buffer.from(...,"hex") silently drops
  // non-hex characters, so an attacker-controlled mac with garbage chars
  // would otherwise short-decode and rely on the length check alone. We
  // assert the canonical 32-hex-char shape here for defense in depth.
  if (!/^[0-9a-f]{32}$/.test(mac)) {
    throw new ApprovalTokenError("bad_signature", "approval-token: signature mismatch");
  }

  const expectMac = macOf(body);
  // Use timing-safe compare on equal-length buffers to avoid leaking
  // signature bytes via response timing.
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expectMac, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApprovalTokenError("bad_signature", "approval-token: signature mismatch");
  }

  let envelope: ApprovalEnvelope;
  try {
    envelope = JSON.parse(b64urlDecode(body)) as ApprovalEnvelope;
  } catch {
    throw new ApprovalTokenError("malformed", "approval-token: undecodable envelope");
  }

  if (envelope.v !== TOKEN_VERSION) {
    throw new ApprovalTokenError("version_mismatch", `approval-token: version ${String(envelope.v)} not supported`);
  }
  if (envelope.user_id !== args.userId) {
    throw new ApprovalTokenError("user_mismatch", "approval-token: user mismatch");
  }
  if (envelope.action !== args.action) {
    throw new ApprovalTokenError("action_mismatch", "approval-token: action mismatch");
  }
  if (!Number.isFinite(envelope.ts)) {
    throw new ApprovalTokenError("malformed", "approval-token: bad timestamp");
  }
  const age = Date.now() - envelope.ts;
  if (age > TTL_MS) {
    throw new ApprovalTokenError("expired", "approval-token: expired");
  }
  if (age < 0) {
    throw new ApprovalTokenError("future_timestamp", "approval-token: future timestamp");
  }

  return envelope;
}

export const APPROVAL_TOKEN_TTL_MS = TTL_MS;
