// components/chat/ComposerSuggestionChips.tsx
"use client";

import { useEffect, useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { TOAST_DISMISS_MS, CHIP_SUBMIT_DEBOUNCE_MS } from "@/lib/ui/constants";
import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
import { AdjustDeficitSheet } from "@/components/coach/AdjustDeficitSheet";
import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { weekdayInUserTz, LONG_TO_SHORT_WEEKDAY } from "@/lib/time";
import { currentWeekMonday } from "@/lib/coach/week";

/**
 * Four static suggestion chips rendered above the chat composer in default
 * mode. Two prefill+submit the composer ("How am I tracking?" / "What's
 * today's plan?"); two open existing sheets directly (Swap today's session /
 * Adjust deficit). Disabled chips show a transient tooltip explaining the
 * unmet precondition (same tap-to-explain pattern as ToolsView).
 *
 * Prefill-and-submit chips guard against double-tap with a local `busy`
 * state — mirrors the Slice 2 ToolsView fix-up so the same review finding
 * doesn't recur here.
 */
export function ComposerSuggestionChips({
  userId,
  todayDate,
  onPrefillAndSubmit,
}: {
  userId: string;
  todayDate: string;
  /** Called with text to prefill into the composer and immediately submit. */
  onPrefillAndSubmit: (text: string) => void;
}) {
  const currentMonday = currentWeekMonday(new Date(`${todayDate}T12:00:00Z`));
  const { data: trainingWeek } = useTrainingWeek(userId, currentMonday);
  const { data: weeklyReview } = useWeeklyReview(userId, currentMonday);

  const hasTrainingWeek = trainingWeek != null;
  const hasDraftReview = weeklyReview != null && weeklyReview.status === "draft";

  const todayLong = weekdayInUserTz();
  const todayShort = LONG_TO_SHORT_WEEKDAY[todayLong] ?? "Mon";

  const [swapOpen, setSwapOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [tooltip, setTooltip] = useState<string | null>(null);
  // Guards the prefill+submit chips against double-tap while the previous
  // submit is still propagating into ChatPanel's send() pipeline.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tooltip) return;
    const t = setTimeout(() => setTooltip(null), TOAST_DISMISS_MS);
    return () => clearTimeout(t);
  }, [tooltip]);

  // Wrap onPrefillAndSubmit in a busy-guarded helper. The send pipeline is
  // synchronous from this component's POV (fire-and-forget into ChatPanel's
  // send() callback), so we flip busy on click and clear it shortly after to
  // re-enable the chip once the user-message has been dispatched.
  function fireSubmit(text: string) {
    if (busy) return;
    setBusy(true);
    try {
      onPrefillAndSubmit(text);
    } finally {
      // Brief debounce — long enough to defeat an accidental double-tap,
      // short enough not to feel sluggish. ChatPanel's own
      // inFlightAssistantId guard takes over for the duration of the actual
      // assistant turn.
      setTimeout(() => setBusy(false), CHIP_SUBMIT_DEBOUNCE_MS);
    }
  }

  const chips: Array<{
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }> = [
    {
      label: "How am I tracking?",
      disabled: busy,
      onClick: () => fireSubmit("How am I tracking this week?"),
    },
    {
      label: "What's today's plan?",
      disabled: busy,
      onClick: () => fireSubmit("What does today look like?"),
    },
    {
      label: "Swap today's session",
      disabled: !hasTrainingWeek,
      onClick: () =>
        hasTrainingWeek
          ? setSwapOpen(true)
          : setTooltip("Commit a week first."),
    },
    {
      label: "Adjust deficit",
      disabled: !hasDraftReview,
      onClick: () =>
        hasDraftReview
          ? setAdjustOpen(true)
          : setTooltip("Open a draft weekly review first."),
    },
    {
      // "What can you help with?" — closes the discoverability gap that
      // used to live in /coach?view=tools. Asking the coach in chat is the
      // more natural surface: it pulls from the actual tool list + current
      // mode capability + active block/plan state.
      label: "What can you help with?",
      disabled: busy,
      onClick: () =>
        fireSubmit(
          "Briefly, what can you do for me right now? List the kinds of questions I can ask and the actions you can take (proposing weekly plans, swapping training days, etc.).",
        ),
    },
  ];

  return (
    <div
      style={{
        position: "relative",
        padding: "6px 12px 4px",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        borderTop: `1px solid ${COLOR.divider}`,
      }}
    >
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          disabled={c.disabled}
          onClick={c.onClick}
          style={{
            background: COLOR.surfaceAlt,
            color: c.disabled ? COLOR.textFaint : COLOR.textStrong,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 9999,
            padding: "4px 10px",
            fontSize: 12,
            cursor: c.disabled ? "not-allowed" : "pointer",
            opacity: c.disabled ? 0.6 : 1,
            fontFamily: "inherit",
          }}
        >
          {c.label}
        </button>
      ))}
      {tooltip && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 12,
            background: COLOR.surface,
            color: COLOR.textMuted,
            fontSize: 11,
            padding: "4px 8px",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 6,
            zIndex: 30,
          }}
        >
          {tooltip}
        </div>
      )}
      {swapOpen && hasTrainingWeek && trainingWeek && (
        <DaySwapSheet
          userId={userId}
          weekStart={currentMonday}
          sourceDay={todayShort}
          plan={trainingWeek.session_plan}
          onClose={() => setSwapOpen(false)}
        />
      )}
      {adjustOpen && hasDraftReview && weeklyReview && (
        <AdjustDeficitSheet
          reviewId={weeklyReview.id}
          userId={userId}
          weekStart={currentMonday}
          onClose={() => setAdjustOpen(false)}
        />
      )}
    </div>
  );
}
