import type { ReviewMode } from "./week";

export const REVIEW_SYSTEM_PROMPT = `You are an elite health and strength coach analysing the athlete's training and recovery data. \
Speak in concrete numbers — cite kg, reps, hours, %, kcal, ms — and never give generic advice. Be honest about misses. \
Pick a recommendationsHeadline that captures the right energy for the period (1-2 words, ALL CAPS, no punctuation): \
e.g. FINISH STRONG, REST, SLOW DOWN, DOUBLE DOWN, RECALIBRATE, EASE IN, RAMP UP, HOLD STEADY, FULL SEND. \
Choose the headline that the data points to — don't default. \
Return ONLY a single valid JSON object — no markdown, no prose, no commentary.`;

export const REVIEW_RESPONSE_SHAPE = `Return JSON shaped exactly:
{
  "summary": "explanatory paragraph (3-6 sentences) grounded in the numbers",
  "patterns": [{"label":"short","detail":"one sentence — repeated behaviours, correlations, or notable trends with numbers"}],
  "recommendationsHeadline": "1-2 word ALL CAPS label",
  "recommendations": [{"category":"training|sleep|nutrition|recovery|habits","priority":"high|medium|low","text":"one specific actionable item, measurable"}]
}
2-4 patterns. 4-6 recommendations.
Recommendations must be concrete and measurable (e.g. "hit 8h sleep on at least 5 nights" not "sleep more").`;

type Frame = {
  /** Goes into the user message, describes the window. */
  windowLine: string;
  /** Goes into the user message, frames the recommendations. */
  recsFraming: string;
  /** Tone hint that nudges the LLM towards the appropriate depth/style. */
  toneHint: string;
};

export function frameFor(mode: ReviewMode, args: {
  start: string;
  end: string;
  daysRemaining: number;
  targetWeekStart: string;
}): Frame {
  const { start, end, daysRemaining, targetWeekStart } = args;
  switch (mode) {
    case "monday-recap":
      return {
        windowLine: `Window reviewed: ${start} → ${end} (the just-completed Mon-Sun week). Today is Monday — the athlete is starting a new week.`,
        recsFraming: `Recommendations target the upcoming week starting ${targetWeekStart} (Mon-Sun). Set the tone for the week ahead based on how last week landed.`,
        toneHint: `Keep the summary concise — focus on fatigue level, sleep trend, calorie/macro pattern, and overall load from last week. Translate that into an orientation for the week ahead.`,
      };
    case "in-progress":
      return {
        windowLine: `Window reviewed: ${start} → ${end} (current week in progress; ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left until Sunday).`,
        recsFraming: `Recommendations target the REMAINING ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} of this week. Pick a recommendationsHeadline that fits the data — FINISH STRONG if on track, REST if accumulated fatigue is high, SLOW DOWN if overreaching, DOUBLE DOWN if undershooting, RECALIBRATE if off plan.`,
        toneHint: `Mid-week diagnostic — what do the first ${7 - daysRemaining} day${7 - daysRemaining === 1 ? "" : "s"} tell us, and how should the athlete play the rest of the week.`,
      };
    case "sunday-full":
      return {
        windowLine: `Window reviewed: ${start} → ${end} (FULL Mon-Sun week, complete).`,
        recsFraming: `Recommendations target NEXT week starting ${targetWeekStart} (Mon-Sun).`,
        toneHint: `Thorough end-of-week review. Cover every category that has data: strength training (volume, top sets, exercise progression), steps and active calories, protein and macros, sleep duration and stages, HRV and resting HR, weight and body composition, recovery scores. Identify the headline story of the week, then translate it into next week's plan.`,
      };
  }
}
