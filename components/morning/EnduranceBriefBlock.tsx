"use client";

import { COLOR, RADIUS } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { MorningBriefEndurance } from "@/lib/data/types";

const SESSION_LABEL: Record<MorningBriefEndurance["session_type"], string> = {
  z2_ride: "Z2 ride",
  z2_run: "Z2 run",
  tempo: "Tempo",
  intervals: "Intervals",
  long: "Long session",
  brick: "Brick session",
};

const SPORT_LABEL: Record<MorningBriefEndurance["sport"], string> = {
  cycling: "cycling",
  running: "running",
  swimming: "swimming",
  other: "endurance",
};

export function EnduranceBriefBlock({ data }: { data: MorningBriefEndurance }) {
  const sessionLabel = SESSION_LABEL[data.session_type] ?? data.session_type;
  const sportLabel = SPORT_LABEL[data.sport] ?? data.sport;
  return (
    <div
      style={{
        background: COLOR.surfaceAlt,
        borderRadius: RADIUS.cardSmall,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      aria-label={`Endurance today: ${fmtNum(data.duration_min)} min ${sportLabel}, ${sessionLabel}`}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span aria-hidden style={{ fontSize: 14 }}>{"❤️"}</span>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>
          {fmtNum(data.duration_min)} min {sportLabel} — {sessionLabel}
        </div>
      </div>
      <div style={{ fontSize: 13, color: COLOR.textMid, lineHeight: 1.45 }}>
        {data.description}
      </div>
      {data.hr_target_range && (
        <div style={{ fontSize: 12, color: COLOR.textMid }}>
          Target HR:{" "}
          <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontWeight: 600 }}>
            {fmtNum(data.hr_target_range[0])}–{fmtNum(data.hr_target_range[1])}
          </span>
          {data.hr_cap !== undefined ? (
            <>
              {" "}
              (cap{" "}
              <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontWeight: 600 }}>
                {fmtNum(data.hr_cap)}
              </span>
              )
            </>
          ) : null}
        </div>
      )}
      {!data.hr_target_range && data.hr_cap !== undefined && (
        <div style={{ fontSize: 12, color: COLOR.textMid }}>
          HR cap:{" "}
          <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontWeight: 600 }}>
            {fmtNum(data.hr_cap)}
          </span>
        </div>
      )}
      <div style={{ fontSize: 12, color: COLOR.textMuted, fontStyle: "italic" }}>
        {data.intent}
      </div>
    </div>
  );
}
