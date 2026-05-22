"use client";

import Link from "next/link";
import { ArrowRight, Dumbbell } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import type { WorkoutDebriefPayload } from "@/lib/data/types";

const SHORT_DAY: Record<number, string> = {
  0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat",
};

function firstParagraph(md: string): string {
  const trimmed = md.trim();
  const split = trimmed.split(/\n\s*\n/);
  const first = split[0] ?? "";
  return first.length > 280 ? first.slice(0, 277) + "…" : first;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return SHORT_DAY[d.getUTCDay()] ?? iso;
}

export function WorkoutDebriefCard({ payload }: { payload: WorkoutDebriefPayload }) {
  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Dumbbell size={11} aria-hidden="true" />
          {payload.session_type} debrief · {shortDate(payload.date)}
        </span>
      </CoachCard.Eyebrow>
      <CoachCard.Body>
        <pre
          style={{
            margin: 0,
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.5,
            color: COLOR.textStrong,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {payload.tldr}
        </pre>
        {payload.narrative_md && (
          <p
            style={{
              marginTop: 10,
              fontSize: 13,
              lineHeight: 1.5,
              color: COLOR.textMuted,
            }}
          >
            {firstParagraph(payload.narrative_md)}
          </p>
        )}
      </CoachCard.Body>
      <CoachCard.Actions>
        <Link
          href={`/coach/sessions/${payload.workout_id}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            color: COLOR.accent,
            fontWeight: 700,
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          Read full debrief
          <ArrowRight size={12} aria-hidden="true" />
        </Link>
      </CoachCard.Actions>
    </CoachCard>
  );
}
