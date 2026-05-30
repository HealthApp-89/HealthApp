// lib/strava/oauth.ts — authorization URL + token exchange.

import type { StravaTokenResponse } from "./types";

const SCOPES = "read,activity:read_all,profile:read_all";

export function buildAuthorizationUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: redirectUri,
    approval_prompt: "auto",
    scope: SCOPES,
    state,
  });
  return `https://www.strava.com/oauth/authorize?${q}`;
}

export async function exchangeCodeForTokens(code: string): Promise<StravaTokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID ?? "",
    client_secret: process.env.STRAVA_CLIENT_SECRET ?? "",
    code,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`exchangeCodeForTokens failed ${r.status}: ${txt}`);
  }
  return (await r.json()) as StravaTokenResponse;
}
