// app/api/profile/timezone/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { invalidateUserTimezone } from "@/lib/time/get-user-tz";

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const sb = await createSupabaseServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { timezone?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const tz = body.timezone;
  if (typeof tz !== "string" || tz.length === 0 || !isValidIanaTimezone(tz)) {
    return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
  }

  const { error } = await sb
    .from("profiles")
    .update({ timezone: tz })
    .eq("user_id", user.id);
  if (error) {
    return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
  }

  invalidateUserTimezone(user.id);
  return NextResponse.json({ ok: true, timezone: tz });
}
