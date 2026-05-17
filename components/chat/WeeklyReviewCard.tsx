"use client";
import Link from "next/link";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import type { WeeklyReviewCardUI } from "@/lib/data/types";

export function WeeklyReviewCard({ ui }: { ui: WeeklyReviewCardUI }) {
  return (
    <div style={{ padding: "6px 12px" }}>
      <CoachCard tone="accent">
        <CoachCard.Eyebrow>
          Weekly Review · {ui.block_phase_now.toUpperCase()} →{" "}
          {ui.block_phase_next.toUpperCase()}
        </CoachCard.Eyebrow>
        <CoachCard.Title>{ui.one_line_summary}</CoachCard.Title>
        <CoachCard.Body>
          {ui.per_lift_preview.length > 0 && (
            <div
              style={{
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
        </CoachCard.Body>
        <CoachCard.Actions>
          <Link
            href={ui.link_path}
            style={{
              display: "inline-block",
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
        </CoachCard.Actions>
      </CoachCard>
    </div>
  );
}
