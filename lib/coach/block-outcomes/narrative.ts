// Carter-voiced outcome paragraph, written ONCE at block close (chat commit,
// API commit, nightly sweep all call generateOutcomeNarrative). Third
// narrator fabrication-checker in the codebase (Peter dashboard + weekly
// review are the others) — deliberately self-contained here; if you change
// the checker policy, audit the other two (known drift gotcha).

import { callClaude } from "@/lib/anthropic/client";
import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";
import { CARTER_VOICE_RULES } from "@/lib/coach/planning-prompts";
import { fmtNum } from "@/lib/ui/score";
import type { BlockOutcome } from "@/lib/data/types";

export type OutcomePayload = Omit<BlockOutcome, "id" | "athlete_acknowledged_at" | "created_at" | "updated_at">;
type BlockWindow = { start_date: string; end_date: string };

/** Collect every numeric token the narrative is ALLOWED to use. */
function allowedNumbers(p: OutcomePayload): Set<string> {
  const nums: Array<number | null | undefined> = [
    p.target_value_kg, p.end_working_kg, p.target_hit_at_week,
    p.lessons.observed_step_kg_per_wk, p.lessons.projected_kg_at_end,
    p.lessons.gap_kg, p.lessons.gap_pct,
    p.recommended_target_value_kg,
    ...p.lessons.secondary_lifts.map((s) => s.end_kg),
  ];
  const out = new Set<string>();
  for (const n of nums) {
    if (n == null) continue;
    out.add(fmtNum(n));
    out.add(String(n));
    out.add(n.toFixed(1));
  }
  return out;
}

/** Every number token in the text must be in the allow-list. Weeks 1-5,
 *  block length (34/35), percentages already covered via gap_pct, and
 *  date fragments (4-digit years, day-of-month <= 31 immediately after a
 *  month word) are exempt. */
export function narrativeNumbersValid(text: string, payload: OutcomePayload): boolean {
  const allowed = allowedNumbers(payload);
  const MONTH_RE = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*$/i;
  const tokenRe = /\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const tok = m[0];
    const val = Number(tok);
    if (allowed.has(tok)) continue;
    if (Number.isInteger(val) && val >= 1 && val <= 5) continue;      // week numbers / small counts
    if (val === 34 || val === 35) continue;                            // block length in days
    if (Number.isInteger(val) && val >= 2020 && val <= 2100) continue; // years
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (Number.isInteger(val) && val <= 31 && MONTH_RE.test(before)) continue; // "Jul 12"
    return false;
  }
  return true;
}

export function deterministicNarrative(p: OutcomePayload, w: BlockWindow): string {
  const lift = p.primary_lift;
  const tgt = p.target_value_kg != null ? `${fmtNum(p.target_value_kg)} kg` : "no target";
  const end = p.end_working_kg != null ? `${fmtNum(p.end_working_kg)} kg` : "n/a";
  const hit = p.target_hit_at_week != null ? ` (week ${p.target_hit_at_week})` : "";
  const step = p.lessons.observed_step_kg_per_wk != null
    ? ` Observed step: +${fmtNum(p.lessons.observed_step_kg_per_wk)} kg/wk.` : "";
  const pick = p.recommended_target_value_kg != null && p.recommended_next_focus === p.primary_lift
    ? ` When ${lift} circles back, pick up around ${fmtNum(p.recommended_target_value_kg)} kg.`
    : ` When ${lift} circles back, pick up from the ${end} base and set the target off the live trend.`;
  return `${w.start_date} → ${w.end_date}: ${lift} block closed ${p.block_phase_at_end.replace(/_/g, " ")}. Target ${tgt}, reached ${end}${hit}.${step} ${p.lessons.calibration_note}${pick}`;
}

const MAX_ATTEMPTS = 2;

export async function generateOutcomeNarrative(opts: {
  payload: OutcomePayload;
  blockWindow: BlockWindow;
}): Promise<{ narrative: string; source: "ai" | "fallback" }> {
  const { payload, blockWindow } = opts;
  const prompt = [
    CARTER_VOICE_RULES,
    "",
    "Write the closing paragraph for a finished 5-week training block. <=120 words, plain prose, no headers, no emoji. Cover: (1) how the block went vs target, (2) what the calibration taught us, (3) an explicit pick-up point for when this lift becomes the focus again.",
    "STRICT: use ONLY numbers present in the JSON below. Do not invent values.",
    "",
    JSON.stringify({ ...payload, blockWindow }, null, 1),
  ].join("\n");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callClaude(
        [{ role: "user", content: prompt }],
        { model: SHORT_FORM_MODEL, maxTokens: 400 },
      );
      if (text && narrativeNumbersValid(text, payload)) return { narrative: text, source: "ai" };
    } catch {
      // transient API error, continue to next attempt
    }
  }
  return { narrative: deterministicNarrative(payload, blockWindow), source: "fallback" };
}
