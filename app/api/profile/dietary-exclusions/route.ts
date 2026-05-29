// app/api/profile/dietary-exclusions/route.ts
//
// PATCH the structured dietary_exclusions jsonb on profiles. Partial:
// { tags?: ExclusionTag[], free_text?: string|null } — undefined keys keep,
// null clears (for free_text), arrays replace.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ExclusionTag } from "@/lib/data/types";

const ALL_TAGS: ExclusionTag[] = [
  "pork", "shellfish", "alcohol", "gluten", "dairy", "eggs",
  "peanuts", "tree_nuts", "soy", "red_meat", "all_meat", "fish",
];

const Body = z.object({
  tags: z.array(z.enum(ALL_TAGS as [ExclusionTag, ...ExclusionTag[]])).optional(),
  free_text: z.union([z.string().max(500), z.null()]).optional(),
});

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid", issues: parsed.error.issues }, { status: 400 });
  }

  // Load current, merge, write back. profiles row exists for every authed user.
  const { data: row, error: readErr } = await supabase
    .from("profiles")
    .select("dietary_exclusions")
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) {
    console.error("[dietary-exclusions] read failed", readErr);
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }

  const current = (row?.dietary_exclusions ?? { tags: [], free_text: null, version: 1 }) as {
    tags: ExclusionTag[];
    free_text: string | null;
    version: 1;
  };

  const next = {
    tags: parsed.data.tags ?? current.tags,
    free_text: parsed.data.free_text === undefined ? current.free_text : parsed.data.free_text,
    version: 1 as const,
  };

  const { error: writeErr } = await supabase
    .from("profiles")
    .update({ dietary_exclusions: next })
    .eq("user_id", user.id);
  if (writeErr) {
    console.error("[dietary-exclusions] write failed", writeErr);
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }

  return NextResponse.json({ dietary_exclusions: next });
}
