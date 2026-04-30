"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      name: str("name"),
      age: num("age"),
      height_cm: num("height_cm"),
      goal: str("goal"),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  revalidatePath("/profile");
  revalidatePath("/");
}
