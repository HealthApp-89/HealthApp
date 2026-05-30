// app/api/strava/webhook/subscribe/route.ts
//
// One-shot admin endpoint to register the Strava webhook subscription against
// the deployed callback URL. Idempotent: if a subscription already exists for
// our client, returns it instead of creating a duplicate (Strava only allows one
// per app). Session-gated so only the logged-in user can hit it.
//
// Usage: visit https://<app>/api/strava/webhook/subscribe in a browser while
// signed in. Reads env vars from the running Vercel deployment — no .env.local
// needed.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const STRAVA_SUBS = "https://www.strava.com/api/v3/push_subscriptions";

type StravaSubscription = { id: number; callback_url: string; created_at: string; updated_at: string };

function missingEnv(): string[] {
  const required = ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_VERIFY_TOKEN", "STRAVA_WEBHOOK_CALLBACK_URL"];
  return required.filter((k) => !process.env[k]);
}

export async function GET() {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized — sign in first" }, { status: 401 });

  const missing = missingEnv();
  if (missing.length > 0) {
    return NextResponse.json(
      { error: "missing_env_vars", missing, hint: "Add these in Vercel → Settings → Environment Variables, then redeploy." },
      { status: 400 },
    );
  }

  const clientId = process.env.STRAVA_CLIENT_ID!;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET!;
  const verifyToken = process.env.STRAVA_VERIFY_TOKEN!;
  const callbackUrl = process.env.STRAVA_WEBHOOK_CALLBACK_URL!;

  // 1. Check for existing subscription (Strava only allows one per app).
  const listRes = await fetch(`${STRAVA_SUBS}?client_id=${clientId}&client_secret=${clientSecret}`);
  if (!listRes.ok) {
    const txt = await listRes.text();
    return NextResponse.json({ error: "list_failed", status: listRes.status, body: txt }, { status: 500 });
  }
  const existing = (await listRes.json()) as StravaSubscription[];
  if (existing.length > 0) {
    const sub = existing[0];
    return NextResponse.json({
      ok: true,
      already_subscribed: true,
      subscription: sub,
      note: sub.callback_url === callbackUrl
        ? "Existing subscription matches the configured callback — nothing to do."
        : `Existing subscription points to ${sub.callback_url}, NOT the configured ${callbackUrl}. Delete the old one first by hitting /api/strava/webhook/subscribe?action=delete&id=${sub.id}.`,
    });
  }

  // 2. Create. Strava's handshake will hit our GET /api/strava/webhook with hub.challenge.
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    callback_url: callbackUrl,
    verify_token: verifyToken,
  });
  const createRes = await fetch(STRAVA_SUBS, { method: "POST", body });
  const createText = await createRes.text();
  if (!createRes.ok) {
    return NextResponse.json(
      {
        error: "create_failed",
        status: createRes.status,
        body: createText,
        hint:
          createRes.status === 400 && createText.includes("callback")
            ? "Strava couldn't reach your callback URL or the verify_token mismatched. Confirm STRAVA_WEBHOOK_CALLBACK_URL is publicly reachable AND that STRAVA_VERIFY_TOKEN in Vercel matches what was sent. If you just changed env vars, did you redeploy?"
            : undefined,
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, created: true, subscription: JSON.parse(createText) });
}

export async function DELETE(req: Request) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });

  const missing = missingEnv();
  if (missing.length > 0) return NextResponse.json({ error: "missing_env_vars", missing }, { status: 400 });

  const clientId = process.env.STRAVA_CLIENT_ID!;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET!;
  const r = await fetch(`${STRAVA_SUBS}/${id}?client_id=${clientId}&client_secret=${clientSecret}`, { method: "DELETE" });
  if (!r.ok) {
    const txt = await r.text();
    return NextResponse.json({ error: "delete_failed", status: r.status, body: txt }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: id });
}
