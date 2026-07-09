//
// Zod schema + pure helpers for the one-shot morning check-in form submit
// (spec 2026-07-10). The route validates with BatchBodySchema, writes columns
// via columnsFromBatch, and renders the visible user reply via formatBatchReply.

import { z } from "zod";
import type { CheckinRow } from "@/lib/data/types";
import { SORENESS_AREAS } from "@/lib/morning/script";

const BatchValuesSchema = z
  .object({
    readiness: z.number().int().min(1).max(10),
    fatigue: z.enum(["none", "some", "heavy"]),
    soreness_areas: z.array(z.enum(SORENESS_AREAS)).max(SORENESS_AREAS.length),
    soreness_severity: z.enum(["mild", "sharp"]).nullable(),
    bloating: z.boolean(),
    sick: z.boolean(),
  })
  .refine(
    (v) =>
      v.soreness_areas.length === 0
        ? v.soreness_severity === null
        : v.soreness_severity !== null,
    { message: "soreness_severity is required iff soreness_areas is non-empty" },
  );

export type BatchValues = z.infer<typeof BatchValuesSchema>;

export const BatchBodySchema = z.object({
  kind: z.literal("batch"),
  values: BatchValuesSchema,
  notes: z.string().max(2000).optional(),
});

/** Maps validated form values → checkin columns. Deliberately excludes
 *  `sick`, `intake_state`, `intake_source`, and notes — the route owns the
 *  sick short-circuit and state transitions. */
export function columnsFromBatch(values: BatchValues): Partial<CheckinRow> {
  const areas = Array.from(new Set(values.soreness_areas));
  return {
    readiness: values.readiness,
    fatigue: values.fatigue,
    soreness_areas: areas,
    soreness_severity: areas.length > 0 ? values.soreness_severity : null,
    bloating: values.bloating,
  };
}

/** Deterministic user-reply line for the chat thread, e.g.
 *  "Feel 5 · heavy fatigue · sore: legs, back (sharp) · bloated — rough night" */
export function formatBatchReply(values: BatchValues, notes: string | null): string {
  const parts = [`Feel ${values.readiness}`, `${values.fatigue} fatigue`];
  const areas = Array.from(new Set(values.soreness_areas));
  if (areas.length > 0) parts.push(`sore: ${areas.join(", ")} (${values.soreness_severity})`);
  if (values.bloating) parts.push("bloated");
  if (values.sick) parts.push("feeling sick");
  const head = parts.join(" · ");
  return notes ? `${head} — ${notes}` : head;
}
