"use client";

import { BottomSheet } from "@/components/ui/BottomSheet";
import { COLOR } from "@/lib/ui/theme";
import {
  CORE_TERMS,
  RATIONALE_LABELS,
  type GlossaryEntry,
} from "@/lib/coach/glossary";

type Section = { heading: string; entries: GlossaryEntry[] };

function buildSections(): Section[] {
  return [
    {
      heading: "Periodization",
      entries: [
        CORE_TERMS.mev,
        CORE_TERMS.mav,
        CORE_TERMS.mrv,
        CORE_TERMS.deload,
      ],
    },
    {
      heading: "Training",
      entries: [CORE_TERMS.rir, CORE_TERMS.e1rm],
    },
    {
      heading: "Recovery",
      entries: [CORE_TERMS.sleep_efficiency],
    },
    {
      heading: "Coach decisions",
      entries: Object.values(RATIONALE_LABELS),
    },
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
