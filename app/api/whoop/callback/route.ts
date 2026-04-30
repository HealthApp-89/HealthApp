import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { exchangeCodeForTokens, saveTokens, whoopGet } from "@/lib/whoop";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return NextResponse.redirect(new URL(`/?whoop_error=${error}`, url.origin));
  if (!code || !state) {
    return NextResponse.redirect(new URL("/?whoop_error=missing_code", url.origin));
  }

  const expectedState = request.headers.get("cookie")?.match(/whoop_oauth_state=([^;]+)/)?.[1];
  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(new URL("/?whoop_error=state_mismatch", url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", url.origin));

  try {
    const tokens = await exchangeCodeForTokens(code);
    let whoopUserId: string | undefined;
    try {
      const profile = await whoopGet<{ user_id: number }>(tokens.access_token, "/v1/user/profile/basic");
      whoopUserId = String(profile.user_id);
    } catch { /* profile fetch is non-critical */ }
    await saveTokens(user.id, tokens, whoopUserId);
  } catch (e) {
    console.error("WHOOP exchange failed", e);
    return NextResponse.redirect(new URL("/?whoop_error=exchange_failed", url.origin));
  }

  const res = NextResponse.redirect(new URL("/?whoop=connected", url.origin));
  res.cookies.delete("whoop_oauth_state");
  return res;
}
