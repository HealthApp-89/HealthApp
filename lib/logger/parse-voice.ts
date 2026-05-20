export type ParsedSet = { kg: number | null; reps: number };

/**
 * Normalize and parse a voice transcript into { kg, reps }.
 * Returns null if no pattern matches — caller falls back to LLM.
 *
 * Examples that parse:
 *   "60 kg 8 reps"          → { kg: 60, reps: 8 }
 *   "60 8"                  → { kg: 60, reps: 8 }
 *   "bodyweight 12 reps"    → { kg: null, reps: 12 }
 *   "8 reps at 60"          → { kg: 60, reps: 8 }
 *   "sixty kilos eight reps" → null (word-form numbers handled by LLM)
 *   "135 lbs 5 reps"        → { kg: 61, reps: 5 } (rounded to nearest 0.5)
 */
export function parseVoiceSet(transcript: string): ParsedSet | null {
  // 1. Normalize.
  let t = transcript.toLowerCase().trim();
  // Collapse whitespace.
  t = t.replace(/\s+/g, " ");
  // Unit aliases.
  t = t.replace(/\bkilograms?\b|\bkilos?\b|\bkilo\b/g, "kg");
  t = t.replace(/\bpounds?\b|\blbs?\b|\blb\b/g, "lbs");
  // Rep aliases.
  t = t.replace(/\btimes\b/g, "reps");
  t = t.replace(/\brep\b/g, "reps");
  // Strip leading filler.
  t = t.replace(/^(uh|um|okay|ok|so|like)\s+/g, "");

  const lbsToKg = (lbs: number) => Math.round(lbs * 0.453592 * 2) / 2;

  // Pattern A: "<weight> kg <reps> reps?"
  // Pattern A-lbs: "<weight> lbs <reps> reps?"
  let m = t.match(/(\d+(?:\.\d+)?)\s*kg\s+(\d+)\s*(?:reps?)?/);
  if (m) return { kg: parseFloat(m[1]), reps: parseInt(m[2], 10) };
  m = t.match(/(\d+(?:\.\d+)?)\s*lbs\s+(\d+)\s*(?:reps?)?/);
  if (m) return { kg: lbsToKg(parseFloat(m[1])), reps: parseInt(m[2], 10) };

  // Pattern B: "<reps> reps at <weight>"
  m = t.match(/(\d+)\s*reps?\s+(?:at|@)\s+(\d+(?:\.\d+)?)\s*(kg|lbs)?/);
  if (m) {
    const weight = parseFloat(m[2]);
    const isLbs = m[3] === "lbs";
    return { kg: isLbs ? lbsToKg(weight) : weight, reps: parseInt(m[1], 10) };
  }

  // Pattern C: "bodyweight <reps> reps?"
  m = t.match(/bodyweight\s+(\d+)\s*(?:reps?)?/);
  if (m) return { kg: null, reps: parseInt(m[1], 10) };

  // Pattern D: bare "<weight> <reps>" — two numbers separated by whitespace.
  m = t.match(/^(\d+(?:\.\d+)?)\s+(\d+)$/);
  if (m) return { kg: parseFloat(m[1]), reps: parseInt(m[2], 10) };

  return null;
}
