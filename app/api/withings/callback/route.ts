import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { exchangeCodeForTokens, saveTokens } from "@/lib/withings";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return NextResponse.redirect(new URL(`/profile?withings_error=${error}`, url.origin));
  if (!code || !state) {
    return NextResponse.redirect(new URL("/profile?withings_error=missing_code", url.origin));
  }

  const expectedState = request.headers.get("cookie")?.match(/withings_oauth_state=([^;]+)/)?.[1];
  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(new URL("/profile?withings_error=state_mismatch", url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", url.origin));

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveTokens(user.id, tokens);
  } catch (e) {
    console.error("Withings exchange failed", e);
    return NextResponse.redirect(new URL("/profile?withings_error=exchange_failed", url.origin));
  }

  const res = NextResponse.redirect(new URL("/profile?withings=connected", url.origin));
  res.cookies.delete("withings_oauth_state");
  return res;
}
