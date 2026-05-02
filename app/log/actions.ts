"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function num(v: FormDataEntryValue | null): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v: FormDataEntryValue | null): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}
function str(v: FormDataEntryValue | null): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function saveDailyLog(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const date = (formData.get("date") as string) || new Date().toISOString().slice(0, 10);

  const row = {
    user_id: user.id,
    date,
    // Recovery
    hrv: num(formData.get("hrv")),
    resting_hr: num(formData.get("resting_hr")),
    spo2: num(formData.get("spo2")),
    skin_temp_c: num(formData.get("skin_temp_c")),
    respiratory_rate: num(formData.get("respiratory_rate")),
    // Sleep
    sleep_hours: num(formData.get("sleep_hours")),
    sleep_score: num(formData.get("sleep_score")),
    deep_sleep_hours: num(formData.get("deep_sleep_hours")),
    rem_sleep_hours: num(formData.get("rem_sleep_hours")),
    // Training / activity
    strain: num(formData.get("strain")),
    steps: intOrNull(formData.get("steps")),
    distance_km: num(formData.get("distance_km")),
    active_calories: intOrNull(formData.get("active_calories")),
    calories: intOrNull(formData.get("calories")),
    exercise_min: intOrNull(formData.get("exercise_min")),
    // Nutrition
    calories_eaten: intOrNull(formData.get("calories_eaten")),
    protein_g: num(formData.get("protein_g")),
    carbs_g: num(formData.get("carbs_g")),
    fat_g: num(formData.get("fat_g")),
    // Body composition
    weight_kg: num(formData.get("weight_kg")),
    body_fat_pct: num(formData.get("body_fat_pct")),
    fat_mass_kg: num(formData.get("fat_mass_kg")),
    fat_free_mass_kg: num(formData.get("fat_free_mass_kg")),
    muscle_mass_kg: num(formData.get("muscle_mass_kg")),
    bone_mass_kg: num(formData.get("bone_mass_kg")),
    hydration_kg: num(formData.get("hydration_kg")),
    // Meta
    notes: str(formData.get("notes")),
    source: "manual",
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("daily_logs").upsert(row, { onConflict: "user_id,date" });
  if (error) throw error;

  // Save the morning-feel checkin in the same submit
  const checkinRow = {
    user_id: user.id,
    date,
    readiness: intOrNull(formData.get("feel_readiness")),
    energy_label: str(formData.get("feel_energy")),
    mood: str(formData.get("feel_mood")),
    soreness: str(formData.get("feel_soreness")),
    feel_notes: str(formData.get("feel_notes")),
  };
  const hasFeelInput = Object.values(checkinRow).some(
    (v, i) => i >= 2 && v !== null && v !== "",
  );
  if (hasFeelInput) {
    const { error: cErr } = await supabase
      .from("checkins")
      .upsert(checkinRow, { onConflict: "user_id,date" });
    if (cErr) throw cErr;
  }

  revalidatePath("/log");
  revalidatePath("/");
}

export async function saveCheckin(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const date = (formData.get("date") as string) || new Date().toISOString().slice(0, 10);
  const row = {
    user_id: user.id,
    date,
    readiness: intOrNull(formData.get("feel_readiness")),
    energy_label: str(formData.get("feel_energy")),
    mood: str(formData.get("feel_mood")),
    soreness: str(formData.get("feel_soreness")),
    feel_notes: str(formData.get("feel_notes")),
  };
  const { error } = await supabase
    .from("checkins")
    .upsert(row, { onConflict: "user_id,date" });
  if (error) throw error;
  revalidatePath("/");
  revalidatePath("/log");
}
