import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseVoiceSetLLM } from "@/lib/logger/parse-voice-llm";

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { transcript: string };
  try {
    body = (await req.json()) as { transcript: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.transcript !== "string" || body.transcript.trim().length === 0) {
    return NextResponse.json({ error: "transcript must be a non-empty string" }, { status: 400 });
  }
  if (body.transcript.length > 200) {
    return NextResponse.json({ error: "transcript too long" }, { status: 400 });
  }

  const parsed = await parseVoiceSetLLM(body.transcript);
  if (!parsed) return NextResponse.json({ parsed: null });
  return NextResponse.json({ parsed });
}
