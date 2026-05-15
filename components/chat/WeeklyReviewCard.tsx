"use client";
import Link from "next/link";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import type { WeeklyReviewCardUI } from "@/lib/data/types";

export function WeeklyReviewCard({ ui }: { ui: WeeklyReviewCardUI }) {
  return (
    <div style={{ padding: "6px 12px" }}>
      <Card>
        <SectionLabel>
          WEEKLY REVIEW · {ui.block_phase_now.toUpperCase()} →{" "}
          {ui.block_phase_next.toUpperCase()}
        </SectionLabel>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6, color: COLOR.textStrong }}>
          {ui.one_line_summary}
        </div>
        {ui.per_lift_preview.length > 0 && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              fontFamily: "var(--font-dm-mono), monospace",
              color: COLOR.textMuted,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {ui.per_lift_preview.map((p) => (
              <div key={p.lift}>
                ▸ {p.lift}: {p.from} → {p.to}
              </div>
            ))}
          </div>
        )}
        <Link
          href={ui.link_path}
          style={{
            display: "inline-block",
            marginTop: 10,
            padding: "8px 12px",
            background: COLOR.accent,
            color: "#fff",
            borderRadius: 9999,
            fontWeight: 700,
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          Open full review →
        </Link>
      </Card>
    </div>
  );
}
