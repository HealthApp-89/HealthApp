"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { todayInUserTz } from "@/lib/time";

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

  const date = (formData.get("date") as string) || todayInUserTz();

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
  const sickRaw = formData.get("feel_sick");
  const sick = typeof sickRaw === "string" && sickRaw === "1";
  const bloatingRaw = formData.get("feel_bloating");
  const bloating: boolean | null =
    typeof bloatingRaw === "string" && bloatingRaw !== ""
      ? bloatingRaw === "1"
      : null;
  const sorenessAreasRaw = formData.get("feel_soreness_areas");
  const sorenessAreas: string[] | null =
    typeof sorenessAreasRaw === "string" && sorenessAreasRaw.trim() !== ""
      ? sorenessAreasRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;

  const checkinRow = {
    user_id: user.id,
    date,
    readiness: intOrNull(formData.get("feel_readiness")),
    energy_label: str(formData.get("feel_energy")),
    mood: str(formData.get("feel_mood")),
    soreness: str(formData.get("feel_soreness")),
    feel_notes: str(formData.get("feel_notes")),
    sick,
    sickness_notes: str(formData.get("feel_sickness_notes")),
    fatigue: str(formData.get("feel_fatigue")),
    bloating,
    soreness_areas: sorenessAreas,
    soreness_severity: str(formData.get("feel_soreness_severity")),
  };

  // Auto-mark intake_state='delivered' when the user fills in enough via the
  // form for the bot to be redundant for the day. "Enough" = readiness + the
  // gate fields needed by readiness math (energy, sick OR all three of
  // {fatigue, bloating, soreness gate answered}).
  const requiredFilled =
    checkinRow.readiness !== null &&
    checkinRow.energy_label !== null &&
    (checkinRow.sick ||
      (checkinRow.fatigue !== null &&
        checkinRow.bloating !== null &&
        checkinRow.soreness_areas !== null));

  const hasFeelInput = Object.entries(checkinRow).some(([k, v]) => {
    if (k === "user_id" || k === "date") return false;
    if (v === null || v === false || v === "") return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });

  if (hasFeelInput) {
    const finalRow = {
      ...checkinRow,
      ...(requiredFilled ? { intake_state: "delivered" as const } : {}),
    };
    const { error: cErr } = await supabase
      .from("checkins")
      .upsert(finalRow, { onConflict: "user_id,date" });
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

  const date = (formData.get("date") as string) || todayInUserTz();
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
