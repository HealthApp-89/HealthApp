// app/api/strava/webhook/route.ts
// GET = subscription validation handshake (echoes hub.challenge).
// POST = activity events (create/update/delete).
// Strava sends owner_id (athlete id); we map back to our user via strava_tokens.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { ingestActivity, softDeleteActivity } from "@/lib/strava/ingest";
import type { StravaWebhookEvent } from "@/lib/strava/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.STRAVA_VERIFY_TOKEN && challenge) {
    return NextResponse.json({ "hub.challenge": challenge });
  }
  return NextResponse.json({ error: "bad_handshake" }, { status: 400 });
}

export async function POST(req: Request) {
  let evt: StravaWebhookEvent;
  try {
    evt = (await req.json()) as StravaWebhookEvent;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Acknowledge immediately — Strava times out at 2s.
  // Spawn the actual work in the background.
  void handleEvent(evt).catch((e) => console.error("[strava webhook]", e));
  return NextResponse.json({ ok: true });
}

async function handleEvent(evt: StravaWebhookEvent): Promise<void> {
  if (evt.object_type !== "activity") return;

  const sb = createSupabaseServiceRoleClient();
  const { data: tok, error } = await sb
    .from("strava_tokens")
    .select("user_id")
    .eq("strava_athlete_id", String(evt.owner_id))
    .maybeSingle();
  if (error || !tok) {
    console.warn("[strava webhook] no token for owner", evt.owner_id);
    return;
  }

  if (evt.aspect_type === "create" || evt.aspect_type === "update") {
    await ingestActivity({ userId: tok.user_id, stravaActivityId: evt.object_id });
  } else if (evt.aspect_type === "delete") {
    await softDeleteActivity({ userId: tok.user_id, stravaActivityId: evt.object_id });
  }
}
