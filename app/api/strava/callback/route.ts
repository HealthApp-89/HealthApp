// app/api/strava/callback/route.ts — exchange code, persist tokens, redirect to /profile.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { exchangeCodeForTokens } from "@/lib/strava/oauth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  if (error) {
    return NextResponse.redirect(`${base}/profile?strava_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${base}/profile?strava_error=missing_code_or_state`);
  }

  const jar = await cookies();
  const expectedState = jar.get("strava_oauth_state")?.value;
  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(`${base}/profile?strava_error=csrf_mismatch`);
  }
  jar.delete("strava_oauth_state");

  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(`${base}/login`);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(`${base}/profile?strava_error=${encodeURIComponent(msg)}`);
  }

  const svc = createSupabaseServiceRoleClient();
  const { error: upErr } = await svc.from("strava_tokens").upsert({
    user_id: user.id,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(tokens.expires_at * 1000).toISOString(),
    strava_athlete_id: tokens.athlete?.id ? String(tokens.athlete.id) : null,
    updated_at: new Date().toISOString(),
  });
  if (upErr) {
    return NextResponse.redirect(`${base}/profile?strava_error=${encodeURIComponent(upErr.message)}`);
  }

  return NextResponse.redirect(`${base}/profile?strava=connected`);
}
