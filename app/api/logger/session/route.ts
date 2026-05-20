import { NextResponse } from "next/server";
import { commitSession } from "@/lib/logger/commit-session";
import type { CommitSessionPayload } from "@/lib/logger/types";

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
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("authenticated") || msg.includes("mismatch") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
