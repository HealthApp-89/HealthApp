import { NextResponse } from "next/server";
import { commitSession } from "@/lib/logger/commit-session";
import type { CommitSessionPayload } from "@/lib/logger/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator";

export async function POST(req: Request) {
  let payload: CommitSessionPayload;
  try {
    payload = (await req.json()) as CommitSessionPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !payload.user_id ||
    !payload.external_id ||
    !payload.date ||
    !payload.type ||
    !Array.isArray(payload.exercises)
  ) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const result = await commitSession(payload);

    // Target-hit evaluator: scan active block for primary-lift PR ≥ target_value
    // and stamp training_blocks.target_hit_at_week. Non-fatal — retries next commit.
    try {
      const supabase = await createSupabaseServerClient();
      await evaluateAndStampTargetHit({ supabase, userId: payload.user_id });
    } catch (err) {
      console.error("[logger/session] evaluateAndStampTargetHit failed:", err);
    }

    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("authenticated") || msg.includes("mismatch") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
