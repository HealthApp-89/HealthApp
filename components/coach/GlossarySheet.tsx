"use client";

import { BottomSheet } from "@/components/ui/BottomSheet";
import { COLOR } from "@/lib/ui/theme";
import {
  CORE_TERMS,
  RATIONALE_LABELS,
  type CoreTermKey,
  type GlossaryEntry,
} from "@/lib/coach/glossary";

type CoreCategory = "Periodization" | "Training" | "Recovery";

/** Categorization of CoreTermKey values into the headings shown in the
 *  Glossary sheet. Keying by CoreTermKey makes the grouping decision
 *  explicit and reviewable — if a future CoreTermKey is added without
 *  being placed in a category, the gap is visible at-a-glance during
 *  code review of this map rather than silently absent from the UI. */
const CORE_CATEGORIES: Record<CoreCategory, CoreTermKey[]> = {
  Periodization: ["mev", "mav", "mrv", "deload"],
  Training: ["rir", "e1rm"],
  Recovery: ["sleep_efficiency"],
};

type Section = { heading: string; entries: GlossaryEntry[] };

function buildSections(): Section[] {
  const coreSections: Section[] = (
    Object.entries(CORE_CATEGORIES) as Array<[CoreCategory, CoreTermKey[]]>
  ).map(([heading, keys]) => ({
    heading,
    entries: keys.map((k) => CORE_TERMS[k]),
  }));
  return [
    ...coreSections,
    { heading: "Coach decisions", entries: Object.values(RATIONALE_LABELS) },
  ];
}

export function GlossarySheet({ onClose }: { onClose: () => void }) {
  const sections = buildSections();
  return (
    <BottomSheet open={true} onClose={onClose} title="Glossary">
      <div style={{ paddingTop: 8 }}>
        {sections.map((section) => (
          <div key={section.heading} style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: 10,
                color: COLOR.textFaint,
                fontWeight: 700,
                letterSpacing: "0.5px",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              {section.heading}
            </div>
            {section.entries.map((entry) => (
              <div
                key={entry.label}
                style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  borderTop: `1px solid ${COLOR.divider}`,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: COLOR.textStrong,
                    fontWeight: 600,
                  }}
                >
                  {entry.label}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: COLOR.textMuted,
                    marginTop: 2,
                  }}
                >
                  {entry.short}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: COLOR.textMuted,
                    marginTop: 4,
                    lineHeight: 1.5,
                  }}
                >
                  {entry.plain}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </BottomSheet>
  );
}
