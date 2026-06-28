// components/activity/ActivityLayoutProposalCard.tsx
//
// Surfaces the activity-aware layout proposal (moved training days + unresolvable
// conflict flags) and lets the athlete approve or dismiss it.
//
// Data flow:
//   GET /api/training-weeks/[week_start]/apply-activity-layout
//     → { ok, proposal: { proposedPlan, lightenDays, flags, hasMoves, hasFlags } }
//   POST /api/training-weeks/[week_start]/apply-activity-layout
//     body: { proposed_plan: SessionPlan }
//     → applies moves, recomputes prescriptions
//
// Rendered only when hasMoves || hasFlags. Shows a null guard so a week with no
// conflicts never mounts visible DOM.

"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, AlertTriangle, CheckCircle, X, Shuffle } from "lucide-react";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { queryKeys } from "@/lib/query/keys";
import { readSessionForDay, SHORT_TO_FULL } from "@/lib/coach/session-plan-reader";
import type { ActivityConflictFlag } from "@/lib/coach/activity/sequence-week";
import type { SessionPlan, Weekday } from "@/lib/data/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ProposalShape {
  proposedPlan: SessionPlan;
  lightenDays: Record<string, string[]>;
  flags: ActivityConflictFlag[];
  hasMoves: boolean;
  hasFlags: boolean;
}

interface GetResponse {
  ok: boolean;
  proposal?: ProposalShape;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Compute changed days between current session_plan and proposedPlan. */
function diffPlans(
  current: SessionPlan | null | undefined,
  proposed: SessionPlan,
): Array<{ from: Weekday; before: string; after: string }> {
  if (!current) return [];
  const changes: Array<{ from: Weekday; before: string; after: string }> = [];
  for (const wd of WEEKDAYS) {
    const before = readSessionForDay(current as Record<string, string>, wd) ?? "REST";
    const after = readSessionForDay(proposed as Record<string, string>, wd) ?? "REST";
    if (before !== after) {
      changes.push({ from: wd, before, after });
    }
  }
  return changes;
}

/** Build a plain-English rationale from the flags for a given weekday change. */
function buildRationale(flags: ActivityConflictFlag[], wd: Weekday): string {
  // Find flags whose session was on this day
  const relevant = flags.filter((f) => f.sessionDay === wd);
  if (relevant.length > 0) {
    const activities = relevant
      .map((f) => f.activity.type)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(" + ");
    return `to clear room around your ${activities} session`;
  }
  // Generic fallback — check lightenDays hint by finding any flag that mentions activity day
  return "to avoid overlap with planned activities";
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  userId: string;
  weekStart: string;
  /** The current committed session_plan (from the training-week row already
   *  fetched by the parent). Passed in to diff against the proposal without an
   *  extra fetch. */
  currentSessionPlan: SessionPlan | null | undefined;
}

export function ActivityLayoutProposalCard({
  userId,
  weekStart,
  currentSessionPlan,
}: Props) {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  // Fetch the proposal — key under training-weeks so invalidation is consistent
  const proposalKey = [...queryKeys.trainingWeeks.one(userId, weekStart), "activity-proposal"] as const;

  const { data, isLoading, isError } = useQuery<GetResponse>({
    queryKey: proposalKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/training-weeks/${weekStart}/apply-activity-layout`,
        { method: "GET" },
      );
      return res.json() as Promise<GetResponse>;
    },
    staleTime: 5 * 60_000,   // 5 min — proposal stable within a session
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // ── Graceful early exits ───────────────────────────────────────────────────

  // Loading, error, dismissed, or already approved — render nothing.
  if (isLoading || isError || dismissed || approved) return null;
  if (!data?.ok || !data.proposal) return null;

  const { proposal } = data;
  if (!proposal.hasMoves && !proposal.hasFlags) return null;

  // ── Compute moves diff ────────────────────────────────────────────────────

  const moves = proposal.hasMoves
    ? diffPlans(currentSessionPlan, proposal.proposedPlan)
    : [];

  // ── Approve handler ───────────────────────────────────────────────────────

  async function handleApprove() {
    setApproving(true);
    setApproveError(null);
    try {
      const res = await fetch(
        `/api/training-weeks/${weekStart}/apply-activity-layout`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ proposed_plan: proposal.proposedPlan }),
        },
      );
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) {
        setApproveError(json.error ?? "apply_failed");
        return;
      }
      // Invalidate the training-week and proposal caches so the schedule
      // re-renders with the moved layout.
      await qc.invalidateQueries({
        queryKey: queryKeys.trainingWeeks.one(userId, weekStart),
      });
      setApproved(true);
    } catch (e) {
      setApproveError((e as Error).message ?? "network_error");
    } finally {
      setApproving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      role="region"
      aria-label="Activity layout proposal"
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.cardSmall,
        boxShadow: SHADOW.card,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Shuffle size={14} color={COLOR.accent} aria-hidden />
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: COLOR.textMid,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            Layout proposal
          </span>
          <span
            style={{
              fontSize: 10,
              color: COLOR.textFaint,
              background: COLOR.surfaceAlt,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: RADIUS.chip,
              padding: "1px 6px",
            }}
          >
            activity-aware
          </span>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss proposal"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 4,
            color: COLOR.textFaint,
            display: "flex",
            alignItems: "center",
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* ── Moves list ── */}
      {moves.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {moves.map((m) => {
            const rationale = buildRationale(proposal.flags, m.from);
            return (
              <div
                key={m.from}
                style={{
                  background: COLOR.surfaceAlt,
                  borderRadius: RADIUS.chip,
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
              >
                {/* Day + session change */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: COLOR.textStrong,
                    }}
                  >
                    {SHORT_TO_FULL[m.from]}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: COLOR.textMuted,
                      background: COLOR.surface,
                      border: `1px solid ${COLOR.divider}`,
                      borderRadius: RADIUS.chip,
                      padding: "1px 7px",
                    }}
                  >
                    {m.before}
                  </span>
                  <ArrowRight size={12} color={COLOR.textFaint} aria-hidden />
                  <span
                    style={{
                      fontSize: 12,
                      color: COLOR.accent,
                      background: COLOR.accentSoft,
                      border: `1px solid ${COLOR.accent}22`,
                      borderRadius: RADIUS.chip,
                      fontWeight: 600,
                      padding: "1px 7px",
                    }}
                  >
                    {m.after}
                  </span>
                </div>
                {/* Rationale */}
                <span
                  style={{ fontSize: 11, color: COLOR.textMuted }}
                >
                  {rationale}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Flags (unresolvable conflicts) ── */}
      {proposal.hasFlags && proposal.flags.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span
            style={{
              fontSize: 10,
              color: COLOR.textMuted,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            Unresolved conflicts
          </span>
          {proposal.flags.map((flag, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 7,
                background: `${COLOR.warning}14`,
                border: `1px solid ${COLOR.warning}40`,
                borderRadius: RADIUS.chip,
                padding: "7px 10px",
              }}
            >
              <AlertTriangle
                size={13}
                color={COLOR.warning}
                style={{ marginTop: 1, flexShrink: 0 }}
                aria-hidden
              />
              <span style={{ fontSize: 12, color: COLOR.textMid, lineHeight: 1.4 }}>
                {flag.reason}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Actions ── */}
      {proposal.hasMoves && (
        <div style={{ display: "flex", gap: 7, paddingTop: 2 }}>
          <button
            type="button"
            onClick={handleApprove}
            disabled={approving}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "7px 14px",
              borderRadius: RADIUS.chip,
              border: "none",
              background: COLOR.accent,
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: approving ? "not-allowed" : "pointer",
              opacity: approving ? 0.7 : 1,
            }}
          >
            <CheckCircle size={13} aria-hidden />
            {approving ? "Applying…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={approving}
            style={{
              padding: "7px 12px",
              borderRadius: RADIUS.chip,
              border: `1px solid ${COLOR.divider}`,
              background: COLOR.surface,
              color: COLOR.textMid,
              fontSize: 12,
              cursor: approving ? "not-allowed" : "pointer",
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Error feedback ── */}
      {approveError && (
        <p style={{ fontSize: 11, color: COLOR.danger, margin: 0 }}>
          {approveError}
        </p>
      )}
    </div>
  );
}
