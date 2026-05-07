"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  DEFAULT_SYSTEM_PROMPT,
  normalizePromptForCompare,
} from "@/lib/coach/system-prompts";

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

  // system_prompt: empty/whitespace → null. Otherwise compare normalized form
  // against the normalized canonical default; if they match, persist null so
  // future code-side updates of DEFAULT_SYSTEM_PROMPT propagate. Else persist
  // the normalized value (also strips \r\n drift from clipboard round-trips).
  const systemPromptInput = formData.get("system_prompt");
  let systemPrompt: string | null = null;
  if (typeof systemPromptInput === "string" && systemPromptInput.trim() !== "") {
    const normalized = normalizePromptForCompare(systemPromptInput);
    const defaultNormalized = normalizePromptForCompare(DEFAULT_SYSTEM_PROMPT);
    systemPrompt = normalized === defaultNormalized ? null : normalized;
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
