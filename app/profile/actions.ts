"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizePromptForCompare } from "@/lib/coach/system-prompts";

export async function saveProfile(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const num = (k: string) => {
    const v = formData.get(k);
    if (typeof v !== "string" || v.trim() === "") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  // system_prompt: persist exactly what the user submitted (after normalising
  // \r\n drift from clipboard round-trips). NULL = never saved → code uses
  // DEFAULT_SYSTEM_PROMPT. Any non-empty string = pinned, even if it happens
  // to byte-match the current default. The previous heuristic (flip to NULL
  // when normalised text equalled the default) silently dropped a user's
  // saved intent any time DEFAULT_SYSTEM_PROMPT was updated to coincidentally
  // match. To clear a pinned prompt, the user empties the textarea and saves.
  const systemPromptInput = formData.get("system_prompt");
  let systemPrompt: string | null = null;
  if (typeof systemPromptInput === "string" && systemPromptInput.trim() !== "") {
    systemPrompt = normalizePromptForCompare(systemPromptInput);
  }

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      name: str("name"),
      age: num("age"),
      height_cm: num("height_cm"),
      goal: str("goal"),
      system_prompt: systemPrompt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  revalidatePath("/profile");
  revalidatePath("/");
}

/** Single-field toggle for the Yazio opt-out. Lives separately from
 *  saveProfile because IngestPanel doesn't host the full ProfileForm — the
 *  toggle is a one-click affordance inside the ingest section. */
export async function setDisableYazioIngest(next: boolean) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("profiles")
    .update({ disable_yazio_ingest: next, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);
  if (error) throw error;
  revalidatePath("/profile");
  revalidatePath("/");
}
