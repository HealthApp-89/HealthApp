// Static training-plan constants — ported from the prototype.
// Stage 5 will move these into profiles.training_plan if you want per-week edits.

export type PlannedExercise = {
  name: string;
  warmup?: boolean;
  reps?: string;
  baseKg?: number;
  baseReps?: number;
  sets?: number;
  key?: string;
  note?: string;
};

export const SESSION_PLANS: Record<string, PlannedExercise[]> = {
  Chest: [
    { name: "Push Up", warmup: true, reps: "12×3" },
    { name: "Decline Bench Press (Barbell)", baseKg: 60, baseReps: 8, sets: 3, key: "decline_bench" },
    { name: "Incline Bench Press (Dumbbell)", baseKg: 32, baseReps: 11, sets: 3, key: "incline_db" },
    { name: "Chest Fly", baseKg: 22, baseReps: 15, sets: 3, key: "chest_fly" },
    { name: "Overhead Press (Barbell)", baseKg: 30, baseReps: 7, sets: 3, key: "ohp", note: "Do BEFORE Incline DB" },
    { name: "Lateral Raise (Dumbbell)", baseKg: 12, baseReps: 12, sets: 4, key: "lateral_raise", note: "Jump from 8kg — next DB is 12kg" },
    { name: "Triceps Pushdown (Cable)", baseKg: 23, baseReps: 15, sets: 3, key: "triceps" },
  ],
  Legs: [
    { name: "Squat (Barbell)", baseKg: 62.5, baseReps: 6, sets: 3, key: "squat" },
    { name: "Leg Press", baseKg: 85, baseReps: 12, sets: 3, key: "leg_press" },
    { name: "Leg Extension (Machine)", baseKg: 31, baseReps: 12, sets: 3, key: "leg_ext" },
    { name: "Romanian Deadlift (Barbell)", baseKg: 65, baseReps: 6, sets: 4, key: "rdl" },
    { name: "Seated Leg Curl (Machine)", baseKg: 30, baseReps: 12, sets: 3, key: "leg_curl" },
    { name: "Seated Calf Raise", baseKg: 40, baseReps: 15, sets: 3, key: "calf" },
    { name: "Hip Abductor (Machine)", baseKg: 56, baseReps: 15, sets: 3, key: "abductor" },
  ],
  Back: [
    { name: "Deadlift (Barbell)", baseKg: 82.5, baseReps: 6, sets: 2, key: "deadlift" },
    { name: "Lat Pulldown (Cable)", baseKg: 45, baseReps: 10, sets: 4, key: "lat_pulldown" },
    { name: "Seated Row (Machine)", baseKg: 38, baseReps: 12, sets: 3, key: "seated_row" },
    { name: "Pullover (Dumbbell)", baseKg: 18, baseReps: 12, sets: 3, key: "pullover" },
    { name: "Shrug (Barbell)", baseKg: 45, baseReps: 15, sets: 3, key: "shrug" },
    { name: "Back Extension", reps: "10×3", key: "back_ext" },
  ],
  Mobility: [
    { name: "Diaphragmatic Breathing", reps: "5×2" },
    { name: "Cat-Cow", reps: "8×2" },
    { name: "90/90 Hip Mobility", reps: "6×3" },
    { name: "Wall Slides", reps: "10×3" },
    { name: "Thread the Needle", reps: "8×2 each side" },
    { name: "Glute Bridge", reps: "12×3" },
    { name: "Child's Pose", reps: "Hold 60s×2" },
    { name: "Shoulder CARs", reps: "5 circles each×2" },
  ],
};

export const WEEKLY_SESSIONS: Record<string, string> = {
  Monday: "Chest",
  Tuesday: "Legs",
  Wednesday: "Mobility",
  Thursday: "Back",
  Friday: "Legs",
  Saturday: "REST",
  Sunday: "REST",
};

export function getTodaySession(): string {
  const day = new Date().toLocaleDateString("en-US", { weekday: "long" });
  return WEEKLY_SESSIONS[day] ?? "REST";
}
