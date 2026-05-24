"use client";

import { useActiveNudges } from "@/lib/query/hooks/useActiveNudges";
import {
  CALLOUT_AMBER_BG,
  CALLOUT_AMBER_BORDER,
  CALLOUT_AMBER_FG,
  CALLOUT_GREEN_BG,
  CALLOUT_GREEN_BORDER,
  CALLOUT_GREEN_FG,
} from "@/lib/coach/nutrition-intelligence/thresholds";

type Variant = "warn" | "ok";

export function InlineNudgeCallout({
  userId,
  triggerKey,
  variant = "warn",
  title,
  body,
}: {
  userId: string;
  /** Exact trigger_key or trigger_key prefix (e.g. "monotone_protein"). */
  triggerKey: string;
  variant?: Variant;
  title: string;
  body: string;
}) {
  const { data: nudges } = useActiveNudges(userId);
  if (!nudges) return null;

  const active = nudges.some((n) =>
    n.trigger_key === triggerKey || n.trigger_key.startsWith(`${triggerKey}:`),
  );
  if (!active) return null;

  const palette = variant === "ok"
    ? { bg: CALLOUT_GREEN_BG, border: CALLOUT_GREEN_BORDER, fg: CALLOUT_GREEN_FG }
    : { bg: CALLOUT_AMBER_BG, border: CALLOUT_AMBER_BORDER, fg: CALLOUT_AMBER_FG };

  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        padding: "8px 10px",
        marginTop: 6,
        fontSize: 10,
        color: palette.fg,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 10 }}>{title}</div>
      <div style={{ marginTop: 2 }}>{body}</div>
    </div>
  );
}
