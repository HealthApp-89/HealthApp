// components/chat/MealSuggestionsCard.tsx
//
// Renders the result of Nora's `propose_meal_suggestions` tool: 2-3 macro-
// scored meal options for the requested slot, each with a one-tap [Log]
// button that submits `[approve:<token>]` (the chat-stream short-circuit
// consumes the token and routes through executeCommitMealLog without an
// extra round-trip through propose_meal_log). [Tweak] focuses the chat
// composer with a slot-aware placeholder (no MealLoggerSheet helper exists
// in the chat surface yet — Task 15 v1 degrades to composer focus instead).
//
// Error states:
// - exclusions_exhausted → single panel asking the athlete to loosen
//   exclusions or accept a substitution.
// - no_history          → asks the athlete to log a few meals first so the
//   90-day eating-identity has signal.
"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import type { MealSuggestion, SuggestEngineError } from "@/lib/data/types";
import type { MealSlot } from "@/lib/food/types";

const SLOT_LABEL: Record<MealSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

export type MealSuggestionsCardContext = {
  slot_target: { kcal: number; protein_g: number };
  remaining_macros_for_day: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  monotone_signal: { protein_top: string; share: number } | null;
};

type Props = {
  suggestions: MealSuggestion[];
  /** length must equal suggestions.length; tokens[i] is the meal_log approval token for option i. */
  tokens: string[];
  context: MealSuggestionsCardContext;
  slot: MealSlot;
  /** When set, render the empty/error state instead of the options list. */
  error?: SuggestEngineError;
  /** Submits a user-text message to the chat (e.g. "[approve:<token>]" or "different ideas, please"). */
  onSubmitText: (text: string) => void;
  /** Tweak handler — v1 falls back to composer focus via ChatMessage's
   *  onFocusComposer plumbing. Card calls this with a per-slot hint. */
  onTweak: () => void;
  /** When true, hide the Log/different-ideas buttons (already approved).
   *  v1: this prop is currently never passed by the ChatMessage dispatcher.
   *  Logged-state indicator is session-only; after a page reload, buttons
   *  re-render as active. The 30-min token TTL limits the duplicate-log
   *  window. See spec §17 "v1 deviations" for the v2 plan. */
  committedTokens?: Set<string>;
};

const btnPrimary: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  border: "none",
  borderRadius: "9999px",
  background: COLOR.accent,
  color: "#fff",
  fontWeight: 700,
  fontSize: 12,
  cursor: "pointer",
};

const btnSecondary: React.CSSProperties = {
  padding: "8px 12px",
  border: `1px solid ${COLOR.divider}`,
  borderRadius: "9999px",
  background: COLOR.surface,
  color: COLOR.textStrong,
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
};

const btnGhost: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  border: `1px dashed ${COLOR.divider}`,
  borderRadius: 10,
  background: "transparent",
  color: COLOR.textMid,
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
  marginTop: 8,
};

export function MealSuggestionsCard({
  suggestions,
  tokens,
  context,
  slot,
  error,
  onSubmitText,
  onTweak,
  committedTokens,
}: Props) {
  // Track which option is being approved so we can show "Logging…" on the
  // tapped card without disabling siblings. Once tokens are persisted across
  // refresh via committedTokens we'll mark the row green.
  const [pendingToken, setPendingToken] = useState<string | null>(null);

  if (error === "no_history") {
    return (
      <CoachCard tone="default">
        <CoachCard.Eyebrow>Suggestions for {SLOT_LABEL[slot]}</CoachCard.Eyebrow>
        <CoachCard.Body>
          <div style={{ fontSize: 13, color: COLOR.textStrong, lineHeight: 1.45 }}>
            I don&rsquo;t have enough history to suggest something you&rsquo;ll like yet. Log a few more meals and ask again — I&rsquo;ll learn from what you eat.
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  if (error === "exclusions_exhausted") {
    return (
      <CoachCard tone="alert">
        <CoachCard.Eyebrow>Suggestions for {SLOT_LABEL[slot]}</CoachCard.Eyebrow>
        <CoachCard.Body>
          <div style={{ fontSize: 13, color: COLOR.textStrong, lineHeight: 1.45 }}>
            Every option that would fit your slot conflicts with your dietary exclusions. Loosen an exclusion, or tell me what you&rsquo;d swap in.
          </div>
        </CoachCard.Body>
      </CoachCard>
    );
  }

  return (
    <CoachCard tone="accent">
      <CoachCard.Eyebrow>Suggestions for {SLOT_LABEL[slot]}</CoachCard.Eyebrow>
      <CoachCard.Body>
        <div
          style={{
            fontSize: 11,
            color: COLOR.textMuted,
            marginBottom: 8,
            lineHeight: 1.4,
          }}
        >
          Slot target: {fmtNum(context.slot_target.kcal)} kcal · {fmtNum(context.slot_target.protein_g)}P
          <span style={{ color: COLOR.textFaint }}>
            {" · "}left today {fmtNum(context.remaining_macros_for_day.kcal)} kcal /{" "}
            {fmtNum(context.remaining_macros_for_day.protein_g)}P
          </span>
        </div>

        {context.monotone_signal && (
          <div
            style={{
              fontSize: 11,
              color: COLOR.textMuted,
              marginBottom: 8,
              fontStyle: "italic",
            }}
          >
            Your protein has leaned on {context.monotone_signal.protein_top}{" "}
            ({fmtNum(context.monotone_signal.share * 100)}% of recent slots) — these mix it up.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {suggestions.map((s, idx) => {
            const token = tokens[idx];
            const isPending = pendingToken === token;
            const isLogged = committedTokens?.has(token) ?? false;
            return (
              <div
                key={`${s.rank}-${idx}`}
                style={{
                  border: `1px solid ${isLogged ? COLOR.success : COLOR.divider}`,
                  borderRadius: 12,
                  padding: 10,
                  background: COLOR.surfaceAlt,
                }}
              >
                {/* Title row: item names (joined) + macros bar */}
                <div
                  style={{
                    fontSize: 13,
                    color: COLOR.textStrong,
                    fontWeight: 600,
                    lineHeight: 1.35,
                    marginBottom: 4,
                  }}
                >
                  {s.items.map((it) => it.name).join(" + ")}
                </div>

                <div
                  style={{
                    fontSize: 11,
                    color: COLOR.textMuted,
                    marginBottom: 6,
                  }}
                >
                  {fmtNum(s.total_macros.kcal)} kcal · {fmtNum(s.total_macros.protein_g)}P /{" "}
                  {fmtNum(s.total_macros.carbs_g)}C / {fmtNum(s.total_macros.fat_g)}F
                </div>

                {/* Per-item quantities */}
                <div
                  style={{
                    fontSize: 11,
                    color: COLOR.textFaint,
                    marginBottom: 6,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  {s.items.map((it, i) => (
                    <span key={`${it.name}-${i}`}>
                      {it.name} {fmtNum(it.qty_g)}g
                      {i < s.items.length - 1 ? " ·" : ""}
                    </span>
                  ))}
                </div>

                {s.rationale && (
                  <div
                    style={{
                      fontSize: 11,
                      color: COLOR.textMuted,
                      marginBottom: 8,
                      lineHeight: 1.4,
                    }}
                  >
                    {s.rationale}
                  </div>
                )}

                {isLogged ? (
                  <div
                    style={{
                      color: COLOR.success,
                      fontWeight: 700,
                      fontSize: 12,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <Check size={14} strokeWidth={3} />
                    Logged to {SLOT_LABEL[slot]}
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      disabled={pendingToken !== null}
                      onClick={() => {
                        if (pendingToken !== null) return;
                        if (!token) return;
                        setPendingToken(token);
                        onSubmitText(`[approve:${token}]`);
                      }}
                      style={{
                        ...btnPrimary,
                        opacity: pendingToken !== null && !isPending ? 0.5 : 1,
                        cursor:
                          pendingToken !== null
                            ? isPending
                              ? "default"
                              : "not-allowed"
                            : "pointer",
                      }}
                    >
                      {isPending ? "Logging…" : "Log"}
                    </button>
                    <button
                      type="button"
                      onClick={onTweak}
                      style={btnSecondary}
                      disabled={pendingToken !== null}
                    >
                      Tweak
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {pendingToken === null && (
          <button
            type="button"
            onClick={() => onSubmitText("different ideas, please")}
            style={btnGhost}
          >
            Show different ideas
          </button>
        )}
      </CoachCard.Body>
    </CoachCard>
  );
}
