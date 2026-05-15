"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";
import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
import { AdjustDeficitSheet } from "@/components/coach/AdjustDeficitSheet";
import type {
  SessionPlan,
  WeeklyReviewRow,
  Weekday,
} from "@/lib/data/types";

/**
 * §8 of the weekly review document. Five chips:
 *   - Commit plan ✓ — HMAC-gated. Issuer mints token, commit endpoint upserts
 *     training_weeks for next_week_start. Flips review status='committed'.
 *   - Swap a day — opens DaySwapSheet against the committed training_weeks row
 *     for next_week_start. Disabled until the review is committed (no row to
 *     swap on otherwise).
 *   - Adjust deficit — opens AdjustDeficitSheet. Draft-only.
 *   - Regenerate — creates version=N+1 draft, supersedes the prior draft.
 *   - Discuss in chat — deep-links into /coach with weekly_review context.
 */
export function WeeklyReviewActions({
  reviewRow,
}: {
  reviewRow: WeeklyReviewRow;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDaySwap, setShowDaySwap] = useState<Weekday | null>(null);
  const [showAdjust, setShowAdjust] = useState(false);

  const committed = reviewRow.status === "committed";
  const superseded = reviewRow.status === "superseded";
  const draft = reviewRow.status === "draft";

  async function commit() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const tokenRes = await fetch(
        `/api/coach/approval-token?review_id=${reviewRow.id}`,
        { credentials: "same-origin" },
      );
      if (!tokenRes.ok) {
        throw new Error(await tokenRes.text());
      }
      const tokenJson = (await tokenRes.json()) as { token?: string };
      if (!tokenJson.token) throw new Error("issuer returned no token");

      const r = await fetch(
        `/api/coach/weekly-review/${reviewRow.id}/commit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approval_token: tokenJson.token }),
          credentials: "same-origin",
        },
      );
      if (!r.ok) throw new Error(await r.text());

      await queryClient.invalidateQueries({
        queryKey: queryKeys.weeklyReviews.one(
          reviewRow.user_id,
          reviewRow.week_start,
        ),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.trainingWeeks.one(
          reviewRow.user_id,
          reviewRow.next_week_start,
        ),
      });
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "commit failed");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/coach/weekly-review/${reviewRow.id}/regenerate`,
        { method: "POST", credentials: "same-origin" },
      );
      if (!r.ok) throw new Error(await r.text());
      await queryClient.invalidateQueries({
        queryKey: queryKeys.weeklyReviews.one(
          reviewRow.user_id,
          reviewRow.week_start,
        ),
      });
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "regen failed");
    } finally {
      setBusy(false);
    }
  }

  function discuss() {
    const ctx = `weekly_review:${reviewRow.week_start}`;
    router.push(`/coach?mode=default&ctx=${encodeURIComponent(ctx)}`);
  }

  // Adjust deficit only meaningful on a draft (committed prescriptions are
  // immutable from this surface; regenerate to create a new draft to tweak).
  const adjustEnabled = draft;
  // Swap a day requires a training_weeks row for next_week_start — i.e. the
  // user has already committed. Otherwise the swap endpoint 404s.
  const swapEnabled = committed;

  return (
    <Card>
      <SectionLabel>ACTIONS</SectionLabel>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          marginTop: 8,
        }}
      >
        <ChipButton
          primary
          disabled={busy || !draft}
          onClick={commit}
        >
          {committed
            ? "Committed ✓"
            : superseded
              ? "Superseded"
              : busy
                ? "Committing…"
                : "Commit plan ✓"}
        </ChipButton>
        <ChipButton
          disabled={busy || !swapEnabled}
          onClick={() => setShowDaySwap("Mon")}
        >
          Swap a day
        </ChipButton>
        <ChipButton
          disabled={busy || !adjustEnabled}
          onClick={() => setShowAdjust(true)}
        >
          Adjust deficit
        </ChipButton>
        <ChipButton disabled={busy} onClick={regenerate}>
          Regenerate
        </ChipButton>
        <ChipButton disabled={busy} onClick={discuss}>
          Discuss in chat
        </ChipButton>
      </div>
      {error && (
        <div
          style={{ fontSize: 10, color: COLOR.warning, marginTop: 8 }}
        >
          {error}
        </div>
      )}
      {showDaySwap && (
        <DaySwapSheet
          userId={reviewRow.user_id}
          weekStart={reviewRow.next_week_start}
          sourceDay={showDaySwap}
          plan={
            reviewRow.payload.prescription.session_plan as SessionPlan
          }
          onClose={() => setShowDaySwap(null)}
        />
      )}
      {showAdjust && (
        <AdjustDeficitSheet
          reviewId={reviewRow.id}
          userId={reviewRow.user_id}
          weekStart={reviewRow.week_start}
          onClose={() => setShowAdjust(false)}
        />
      )}
    </Card>
  );
}

function ChipButton({
  primary,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: primary ? COLOR.accent : COLOR.surfaceAlt,
        color: primary ? "#fff" : COLOR.textStrong,
        border: primary ? "none" : `1px solid ${COLOR.divider}`,
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: 11,
        fontWeight: primary ? 700 : 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}
