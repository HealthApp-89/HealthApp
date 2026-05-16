"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import { TOAST_DISMISS_MS } from "@/lib/ui/constants";
import { ToolRow } from "@/components/coach/tools/ToolRow";
import { GlossarySheet } from "@/components/coach/GlossarySheet";
import { DaySwapSheet } from "@/components/strength/DaySwapSheet";
import { AdjustDeficitSheet } from "@/components/coach/AdjustDeficitSheet";
import { useWeeklyReview } from "@/lib/query/hooks/useWeeklyReview";
import { useTrainingWeek } from "@/lib/query/hooks/useTrainingWeek";
import { useBlockProgress, isActiveBlock } from "@/lib/query/hooks/useBlockProgress";
import { weekdayInUserTz, LONG_TO_SHORT_WEEKDAY } from "@/lib/time";
import { currentWeekMonday } from "@/lib/coach/week";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Tools tab — categorized list of all 8-10 user-facing coach actions.
 *
 * Four sections (TODAY / THIS WEEK / THIS BLOCK / REFERENCE) wire up the
 * existing sheets (DaySwapSheet / AdjustDeficitSheet / GlossarySheet) and
 * endpoints (retry-brief, regenerate weekly review). Mark-mobility-done is
 * routed through a synthetic chat message so the chat-stream dispatcher
 * handles the mark_mobility_done tool exactly as a typed message would.
 *
 * Tap-to-explain: disabled rows still receive onClick (ToolRow uses
 * aria-disabled, not the HTML disabled attribute), so the parent surfaces a
 * short inline toast naming the precondition that wasn't met.
 */
export function ToolsView({
  userId,
  todayDate,
}: {
  userId: string;
  todayDate: string;
}) {
  const router = useRouter();
  const currentMonday = currentWeekMonday(new Date(`${todayDate}T12:00:00Z`));
  const { data: trainingWeek } = useTrainingWeek(userId, currentMonday);
  const { data: weeklyReview } = useWeeklyReview(userId, currentMonday);
  const { data: blockProgress } = useBlockProgress(userId);

  const hasTrainingWeek = trainingWeek != null;
  const hasDraftReview = weeklyReview != null && weeklyReview.status === "draft";
  const hasActiveBlock = isActiveBlock(blockProgress);

  const todayLong = weekdayInUserTz();
  const todayShort = LONG_TO_SHORT_WEEKDAY[todayLong] ?? "Mon";

  const [swapOpen, setSwapOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "brief" | "mobility" | "regen-review">(null);
  const [intakeState, setIntakeState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sb = createSupabaseBrowserClient();
    void sb.from("checkins")
      .select("intake_state")
      .eq("user_id", userId)
      .eq("date", todayDate)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setIntakeState((data?.intake_state as string | undefined) ?? null);
      });
    return () => { cancelled = true; };
  }, [userId, todayDate]);

  const canRegenerateBrief = intakeState === "brief_failed";

  // Auto-dismiss the inline toast after 3s so it never sticks.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toast]);

  function explain(reason: string) {
    setToast(reason);
  }

  async function regenerateMorningBrief() {
    if (busy) return;
    setBusy("brief");
    try {
      const res = await fetch("/api/chat/morning/retry-brief", { method: "POST" });
      if (!res.ok) {
        let message = `Failed to regenerate brief (${res.status}).`;
        try {
          const body = await res.json();
          if (body?.reason === "not_in_retry_state") {
            message = "Brief hasn't failed — nothing to retry.";
          } else if (typeof body?.reason === "string") {
            message = `Failed: ${body.reason}.`;
          }
        } catch {
          /* not JSON */
        }
        throw new Error(message);
      }
      router.push("/coach");
    } catch (e) {
      explain(e instanceof Error ? e.message : "Failed to regenerate brief.");
    } finally {
      setBusy(null);
    }
  }

  async function markMobilityDone() {
    // No direct REST endpoint — fire a synthetic chat message that the
    // chat-stream tool dispatcher routes to mark_mobility_done. The route
    // body shape is { content, image_ids?, mode?, doc? }; role+kind are
    // implicit (user-role + coach-kind for default mode).
    if (busy) return;
    setBusy("mobility");
    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Mark mobility done for today.",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      router.push("/coach");
    } catch (e) {
      explain(e instanceof Error ? e.message : "Failed to mark mobility done.");
    } finally {
      setBusy(null);
    }
  }

  async function regenerateWeeklyReview() {
    if (!weeklyReview || busy) return;
    setBusy("regen-review");
    try {
      const res = await fetch(
        `/api/coach/weekly-review/${weeklyReview.id}/regenerate`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await res.text());
      router.push(`/coach/weeks/${currentMonday}`);
    } catch (e) {
      explain(e instanceof Error ? e.message : "Failed to regenerate review.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: "0 12px", display: "flex", flexDirection: "column", gap: 10 }}>
      <Card>
        <SectionLabel>TODAY</SectionLabel>
        <ToolRow
          title="Swap today's session"
          subtitle="Pick a different day"
          disabled={!hasTrainingWeek}
          onClick={() =>
            hasTrainingWeek
              ? setSwapOpen(true)
              : explain("No training plan committed for this week.")
          }
        />
        <ToolRow
          title="Regenerate morning brief"
          subtitle={
            busy === "brief" ? "Regenerating…"
            : canRegenerateBrief ? "Re-run today's brief"
            : "Brief is fine — nothing to retry"
          }
          disabled={busy !== null || !canRegenerateBrief}
          onClick={() => canRegenerateBrief
            ? regenerateMorningBrief()
            : explain("Brief hasn't failed — nothing to retry.")}
        />
        <ToolRow
          title="Mark mobility done"
          subtitle={busy === "mobility" ? "Marking…" : "Log mobility for today"}
          disabled={busy !== null}
          onClick={markMobilityDone}
        />
      </Card>

      <Card>
        <SectionLabel>THIS WEEK</SectionLabel>
        <ToolRow
          title="Adjust deficit"
          subtitle="±100 / ±200 kcal"
          disabled={!hasDraftReview}
          onClick={() =>
            hasDraftReview
              ? setAdjustOpen(true)
              : explain("Open a draft weekly review first.")
          }
        />
        <ToolRow
          title="Regenerate weekly review"
          subtitle={busy === "regen-review" ? "Regenerating…" : "Create a new version"}
          disabled={!weeklyReview || busy !== null}
          onClick={() =>
            weeklyReview
              ? regenerateWeeklyReview()
              : explain("No weekly review for this week.")
          }
        />
        <ToolRow
          title="Plan upcoming week"
          subtitle="Open planning chat"
          onClick={() => router.push("/coach?mode=plan_week")}
        />
      </Card>

      <Card>
        <SectionLabel>THIS BLOCK</SectionLabel>
        <ToolRow
          title="Set up new block"
          subtitle={hasActiveBlock ? "Block already active" : "Start a new 5-week meso"}
          disabled={hasActiveBlock}
          onClick={() =>
            hasActiveBlock
              ? explain("A block is already active.")
              : router.push("/coach?mode=setup_block")
          }
        />
        <ToolRow
          title="View block progress"
          subtitle="See e1RM trends + adherence"
          disabled={!hasActiveBlock}
          onClick={() =>
            hasActiveBlock
              ? router.push("/coach?view=today")
              : explain("Set up a block to enable this view.")
          }
        />
      </Card>

      <Card>
        <SectionLabel>REFERENCE</SectionLabel>
        <ToolRow
          title="View trends"
          subtitle="Strength / Composition / Cross-metric"
          onClick={() => router.push("/coach/trends")}
        />
        <ToolRow
          title="Glossary"
          subtitle="MEV / MAV / RIR / and more"
          onClick={() => setGlossaryOpen(true)}
        />
      </Card>

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
      {glossaryOpen && <GlossarySheet onClose={() => setGlossaryOpen(false)} />}

      {/* Inline toast for disabled-row tap-to-explain. TermSheet isn't reused
          because "_disabled" isn't a glossary term — this is a transient
          one-liner that auto-dismisses after 3s (or on tap). */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          onClick={() => setToast(null)}
          style={{
            position: "fixed",
            bottom: 80,
            left: 12,
            right: 12,
            padding: 12,
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 8,
            fontSize: 12,
            color: COLOR.textMuted,
            zIndex: 50,
            boxShadow: "0 4px 12px rgba(20,30,80,0.08)",
            cursor: "pointer",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
