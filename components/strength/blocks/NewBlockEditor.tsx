// components/strength/blocks/NewBlockEditor.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { queryKeys } from "@/lib/query/keys";
import type { BlockRepoRow } from "@/lib/query/fetchers/blocksRepo";
import type { PrimaryLift } from "@/lib/data/types";
import type { TargetRecommendation } from "@/lib/coach/prescription/calibrate-target";

type Props = {
  userId: string;
  prefillFocus?: PrimaryLift | null;
  prefillTarget?: number | null;
  repoRows: BlockRepoRow[];
  /** Today in user tz (YYYY-MM-DD) — must come from useUserToday. */
  todayIso: string;
};

const LIFT_LABELS: Record<PrimaryLift, string> = {
  squat: "Squat",
  bench: "Bench",
  deadlift: "Deadlift",
  ohp: "OHP",
};

const ALL_LIFTS: PrimaryLift[] = ["squat", "bench", "deadlift", "ohp"];
const GRID_STEP = 2.5;

function nextMonday(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const toMonday = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + toMonday);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function defaultFocus(repoRows: BlockRepoRow[], prefill: PrimaryLift | null | undefined): PrimaryLift {
  if (prefill && ALL_LIFTS.includes(prefill)) return prefill;
  // Use recommended_next_focus from the most recent outcome
  for (const { outcome } of repoRows) {
    if (outcome?.recommended_next_focus) return outcome.recommended_next_focus;
  }
  // Fall through to rotation order after last closed block's lift
  const lastLift = repoRows.find((r) => r.block.status !== "active")?.block.primary_lift;
  if (lastLift) {
    const idx = ALL_LIFTS.indexOf(lastLift);
    return ALL_LIFTS[(idx + 1) % ALL_LIFTS.length];
  }
  return "squat";
}

export function NewBlockEditor({ userId, prefillFocus, prefillTarget, repoRows, todayIso }: Props) {
  const qc = useQueryClient();
  const [focus, setFocus] = useState<PrimaryLift>(() => defaultFocus(repoRows, prefillFocus));
  const [target, setTarget] = useState<number | null>(prefillTarget ?? null);
  const [overrideReason, setOverrideReason] = useState("");
  const [rec, setRec] = useState<TargetRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startDate = nextMonday(todayIso);
  const endDate = addDays(startDate, 34);

  const fetchRec = useCallback(async (lift: PrimaryLift) => {
    setRecLoading(true);
    setRec(null);
    try {
      const res = await fetch(`/api/blocks/recommendation?lift=${lift}`);
      if (res.ok) {
        const data = await res.json();
        setRec(data);
        // Only pre-fill when not already prefilled from URL
        if (prefillTarget == null) {
          setTarget(data.recommended_target ?? null);
        }
      }
    } catch {
      // silently fail — hint won't show
    } finally {
      setRecLoading(false);
    }
  }, [prefillTarget]);

  useEffect(() => { void fetchRec(focus); }, [focus, fetchRec]);

  const sanityBounds = rec?.sanity_bounds ?? null;
  const outsideBounds =
    sanityBounds != null && target != null
      ? target < sanityBounds[0] || target > sanityBounds[1]
      : false;

  const submit = async () => {
    if (!target) { setErrorMsg("Set a target."); return; }
    if (outsideBounds && overrideReason.trim().length < 4) {
      setErrorMsg("Provide an override reason (4+ chars) since target is outside the recommended band.");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const body: Record<string, unknown> = {
        primary_lift: focus,
        target_value: target,
        target_metric: "e1rm",
        goal_text: `${LIFT_LABELS[focus]} focus block — target ${fmtNum(target)} kg e1RM`,
        start_date: startDate,
        end_date: endDate,
      };
      if (outsideBounds && overrideReason.trim().length >= 4) {
        body.override_reason = overrideReason.trim();
      }
      const res = await fetch("/api/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? data.hint ?? "Failed to create block.");
        return;
      }
      await qc.invalidateQueries({ queryKey: queryKeys.blockSummary.all(userId) });
      await qc.invalidateQueries({ queryKey: queryKeys.blocksRepo.all(userId) });
    } catch {
      setErrorMsg("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const adjustTarget = (delta: number) => {
    setTarget((prev) => {
      const base = prev ?? (rec?.recommended_target ?? 80);
      return Math.round((base + delta) / GRID_STEP) * GRID_STEP;
    });
  };

  // Get recommended_next_focus from the most recent outcome for display
  const recommendedNextFocus = (() => {
    for (const { outcome } of repoRows) {
      if (outcome?.recommended_next_focus) return outcome.recommended_next_focus;
    }
    return null;
  })();

  return (
    <div
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.card,
        border: `1px solid ${COLOR.divider}`,
        padding: "14px",
        marginBottom: 10,
        boxShadow: SHADOW.card,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: COLOR.textMuted,
          }}
        >
          New block — engine prefilled
        </span>
        <span style={{ fontSize: 10, color: COLOR.textMuted }}>
          rotation: DL → BE →{" "}
          <strong style={{ color: COLOR.accent }}>
            {(focus ?? "SQ").toUpperCase().slice(0, 2)}
          </strong>{" "}
          → OHP
        </span>
      </div>

      {/* Focus lift */}
      <div style={{ marginTop: 10 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: COLOR.textMuted,
            marginBottom: 4,
          }}
        >
          Focus lift
        </div>
        <select
          value={focus}
          onChange={(e) => setFocus(e.target.value as PrimaryLift)}
          style={{
            width: "100%",
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            padding: "9px 12px",
            fontSize: 13,
            fontWeight: 600,
            color: COLOR.textStrong,
            appearance: "none",
            cursor: "pointer",
          }}
        >
          {ALL_LIFTS.map((l) => (
            <option key={l} value={l}>
              {LIFT_LABELS[l]}
            </option>
          ))}
        </select>
        {recommendedNextFocus && (
          <div style={{ fontSize: 10.5, color: COLOR.textMuted, marginTop: 3 }}>
            {LIFT_LABELS[recommendedNextFocus]} recommended next in rotation.
          </div>
        )}
        {!recommendedNextFocus && (
          <div style={{ fontSize: 10.5, color: COLOR.textMuted, marginTop: 3 }}>
            No prior outcome — choose freely.
          </div>
        )}
      </div>

      {/* Target */}
      <div style={{ marginTop: 10 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: COLOR.textMuted,
            marginBottom: 4,
          }}
        >
          Target — e1RM
        </div>
        <div
          style={{
            background: COLOR.surfaceAlt,
            border: `1px solid ${outsideBounds ? COLOR.warning : COLOR.divider}`,
            borderRadius: RADIUS.input,
            padding: "9px 12px",
            fontSize: 13,
            fontWeight: 600,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: COLOR.textStrong }}>
            {target != null ? `${fmtNum(target)} kg` : recLoading ? "Loading…" : "—"}
          </span>
          <span style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => adjustTarget(-GRID_STEP)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 18,
                color: COLOR.textMid,
                lineHeight: 1,
                padding: "0 2px",
              }}
            >
              −
            </button>
            <button
              onClick={() => adjustTarget(GRID_STEP)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 18,
                color: COLOR.textMid,
                lineHeight: 1,
                padding: "0 2px",
              }}
            >
              +
            </button>
          </span>
        </div>
        {rec && !recLoading && (
          <div style={{ fontSize: 10.5, color: COLOR.textMuted, marginTop: 3 }}>
            {rec.used === "trend" && rec.slope_kg_per_wk != null
              ? `Trend-based: current ${fmtNum(rec.current_e1rm ?? 0)} + ${fmtNum(rec.slope_kg_per_wk)} kg/wk observed`
              : rec.used === "math"
              ? `Math-based estimate: current ${fmtNum(rec.current_e1rm ?? 0)} kg`
              : "No history — set manually"}
            {sanityBounds && (
              <>
                {" · sanity band "}
                <strong>
                  {fmtNum(sanityBounds[0])}–{fmtNum(sanityBounds[1])}
                </strong>
              </>
            )}
          </div>
        )}
        {outsideBounds && (
          <div style={{ fontSize: 10.5, color: COLOR.warningDeep, marginTop: 4 }}>
            Outside recommended band. Provide an override reason below.
          </div>
        )}
      </div>

      {/* Override reason (only when outside bounds) */}
      {outsideBounds && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: COLOR.textMuted,
              marginBottom: 4,
            }}
          >
            Override reason
          </div>
          <textarea
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="Explain why this target is appropriate…"
            rows={2}
            style={{
              width: "100%",
              background: COLOR.surfaceAlt,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: RADIUS.input,
              padding: "9px 12px",
              fontSize: 13,
              color: COLOR.textStrong,
              resize: "none",
              fontFamily: "inherit",
            }}
          />
        </div>
      )}

      {/* Period (read-only) */}
      <div style={{ marginTop: 10 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: COLOR.textMuted,
            marginBottom: 4,
          }}
        >
          Period
        </div>
        <div
          style={{
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            padding: "9px 12px",
            fontSize: 13,
            fontWeight: 600,
            color: COLOR.textStrong,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {fmtDateShort(startDate)} → {fmtDateShort(endDate)}
          </span>
          <span style={{ color: COLOR.textMuted, fontSize: 12 }}>5 weeks</span>
        </div>
      </div>

      {/* Error */}
      {errorMsg && (
        <div
          style={{
            fontSize: 12,
            color: COLOR.dangerDeep,
            background: COLOR.dangerSoft,
            borderRadius: RADIUS.chip,
            padding: "6px 10px",
            marginTop: 10,
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
        <button
          onClick={submit}
          disabled={submitting || !target}
          style={{
            flex: 1,
            textAlign: "center",
            padding: "9px 12px",
            borderRadius: RADIUS.full,
            background: submitting || !target ? COLOR.textFaint : COLOR.accent,
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            border: "none",
            cursor: submitting || !target ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Creating…" : "Create block"}
        </button>
        <Link
          href="/strength?tab=coach&mode=setup_block"
          style={{
            flex: 1,
            textAlign: "center",
            padding: "9px 12px",
            borderRadius: RADIUS.full,
            background: COLOR.surfaceAlt,
            color: COLOR.textMid,
            fontSize: 12,
            fontWeight: 700,
            border: `1px solid ${COLOR.divider}`,
            textDecoration: "none",
            display: "block",
          }}
        >
          Ask Carter first
        </Link>
      </div>
    </div>
  );
}
