// app/api/strava/auth/route.ts — kick off OAuth.
// Mints a CSRF state, stashes it in a cookie, redirects to Strava.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildAuthorizationUrl } from "@/lib/strava/oauth";

export async function GET() {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"));

  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("strava_oauth_state", state, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600,
  });

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const redirectUri = `${base}/api/strava/callback`;
  return NextResponse.redirect(buildAuthorizationUrl(state, redirectUri));
}
