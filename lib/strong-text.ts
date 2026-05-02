// Parser for Strong's per-workout "Share as Text" format. Example input:
//
//   Back
//   Thursday, 30 April 2026 at 12:50
//
//   Deadlift (Barbell)
//   W1: 60 kg × 10 [Warm-up]
//   Set 1: 80 kg × 6
//   Set 2: 80 kg × 6
//
//   Pullover (Dumbbell)
//   Set 1: 16 kg × 15
//
//   Back Extension
//   Set 1: 10 reps
//
//   https://link.strong.app/dfhqtkng
//
// Strong uses U+00D7 (×) as the multiplication symbol, but we accept ASCII 'x' too.

export type ParsedStrongSet = {
  index: number;
  kg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  warmup: boolean;
};

export type ParsedStrongExercise = {
  name: string;
  sets: ParsedStrongSet[];
};

export type ParsedStrongWorkout = {
  workoutName: string;
  date: string; // YYYY-MM-DD
  exercises: ParsedStrongExercise[];
};

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

function parseDateLine(line: string): string | null {
  // "Thursday, 30 April 2026 at 12:50" — extract "30 April 2026".
  // Also handles "April 30, 2026" (US locale, just in case).
  const m1 = line.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m1) {
    const day = m1[1].padStart(2, "0");
    const month = MONTHS[m1[2].toLowerCase()];
    if (month) return `${m1[3]}-${month}-${day}`;
  }
  const m2 = line.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m2) {
    const month = MONTHS[m2[1].toLowerCase()];
    if (month) return `${m2[3]}-${month}-${m2[2].padStart(2, "0")}`;
  }
  return null;
}

function parseSetValue(value: string): { kg: number | null; reps: number | null; durationSeconds: number | null } {
  // Normalize the multiplication symbol — Strong uses ×, also accept x.
  const v = value.replace(/×/g, "x").trim();

  // "80 kg x 6" / "80kg x 6"
  const kgReps = v.match(/^([\d.]+)\s*kg\s*x\s*(\d+)/i);
  if (kgReps) return { kg: parseFloat(kgReps[1]), reps: parseInt(kgReps[2], 10), durationSeconds: null };

  // "10 reps" / "12 reps"
  const repsOnly = v.match(/^(\d+)\s*reps?$/i);
  if (repsOnly) return { kg: null, reps: parseInt(repsOnly[1], 10), durationSeconds: null };

  // "30:00" or "1:30:00" duration
  const dur = v.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (dur) {
    const a = parseInt(dur[1], 10);
    const b = parseInt(dur[2], 10);
    const c = dur[3] != null ? parseInt(dur[3], 10) : null;
    const seconds = c != null ? a * 3600 + b * 60 + c : a * 60 + b;
    return { kg: null, reps: null, durationSeconds: seconds };
  }

  // Bodyweight ("BW x 12") or unknown — record as reps if reps hint present, else null
  const bw = v.match(/^bw\s*x\s*(\d+)/i);
  if (bw) return { kg: null, reps: parseInt(bw[1], 10), durationSeconds: null };

  return { kg: null, reps: null, durationSeconds: null };
}

/** True if the input looks like Strong's text-share format (header lines + at least one Set/W line). */
export function looksLikeStrongText(text: string): boolean {
  const lines = text.split(/\r?\n/).slice(0, 30);
  const hasSetLine = lines.some((l) => /^(W\d+|Set\s*\d+):/i.test(l.trim()));
  const hasDateHint = lines.slice(0, 5).some((l) => parseDateLine(l) != null);
  return hasSetLine && hasDateHint;
}

export function parseStrongText(text: string): ParsedStrongWorkout | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.length < 3) return null;

  // First non-empty line = workout name.
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const workoutName = lines[i] || "Workout";
  i++;

  // Next non-empty line containing a recognizable date.
  let date: string | null = null;
  while (i < lines.length) {
    const l = lines[i];
    if (l === "") { i++; continue; }
    date = parseDateLine(l);
    if (date) { i++; break; }
    // Not a date — bail; format probably isn't Strong text.
    return null;
  }
  if (!date) return null;

  const exercises: ParsedStrongExercise[] = [];
  let current: ParsedStrongExercise | null = null;
  let setCounter = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      // Blank line separates exercises; reset is implicit because next non-blank
      // either starts a new exercise (no Set: prefix) or continues the current one.
      continue;
    }
    if (line.startsWith("https://link.strong.app/")) continue;

    // Set line: "W1: …", "Set 1: …", optionally with "[Warm-up]"
    const setMatch = line.match(/^(W\d+|Set\s*\d+):\s*(.+)$/i);
    if (setMatch) {
      if (!current) continue; // orphan set line, skip
      const isWarmup = /^W\d+/i.test(setMatch[1]) || /\[warm-?up\]/i.test(line);
      const valuePart = setMatch[2].replace(/\[warm-?up\]/gi, "").trim();
      const parsed = parseSetValue(valuePart);
      setCounter++;
      current.sets.push({
        index: setCounter,
        kg: parsed.kg,
        reps: parsed.reps,
        durationSeconds: parsed.durationSeconds,
        warmup: isWarmup,
      });
      continue;
    }

    // Otherwise it's an exercise name header.
    current = { name: line, sets: [] };
    setCounter = 0;
    exercises.push(current);
  }

  if (exercises.length === 0) return null;
  return { workoutName, date, exercises };
}
