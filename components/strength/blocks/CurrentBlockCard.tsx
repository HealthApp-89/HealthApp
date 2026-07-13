// components/strength/blocks/CurrentBlockCard.tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { queryKeys } from "@/lib/query/keys";
import type { BlockSummaryPayload } from "@/lib/coach/blocks/summary";
import type { BlockPhase } from "@/lib/coach/prescription/types";

type PhaseTag = { label: string; bg: string; fg: string };

const PHASE_TAGS: Record<BlockPhase, PhaseTag> = {
  pre_target:    { label: "PRE-TARGET",    bg: COLOR.accentSoft,  fg: COLOR.accentDeep },
  consolidation: { label: "CONSOLIDATION", bg: COLOR.successSoft, fg: COLOR.success },
  off_pace:      { label: "OFF PACE",      bg: COLOR.dangerSoft,  fg: COLOR.dangerDeep },
  deload_week:   { label: "DELOAD",        bg: COLOR.warningSoft, fg: COLOR.warningDeep },
};

type Props = {
  payload: BlockSummaryPayload;
  userId: string;
};

type ClosePreview = {
  target: number | null;
  reached: number | null;
  phase: string | null;
};

export function CurrentBlockCard({ payload, userId }: Props) {
  const { block, weekNum, totalWeeks, phase, pace, chart, thisWeek, secondaries } = payload;
  const qc = useQueryClient();
  const phaseTag = PHASE_TAGS[phase];
  const isE1rm = block.target_metric === "e1rm";
  const valueLabel = isE1rm ? "e1RM" : "working weight";

  // Close dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setMounted(true); }, []);

  const openDialog = useCallback(() => {
    setDialogOpen(true);
    setPreview(null);
    setReason("");
    setErrorMsg(null);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setPreview(null);
    setReason("");
    setErrorMsg(null);
  }, []);

  const fetchPreview = useCallback(async () => {
    if (reason.trim().length < 4) {
      setErrorMsg("Reason must be at least 4 characters.");
      return;
    }
    setPreviewLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/blocks/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), preview: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? "Preview failed.");
        return;
      }
      // Preview shape from /api/blocks/close: { preview: { target_value,
      // would_be_outcome: { end_working_kg, block_phase_at_end, ... } } }
      setPreview({
        target: data.preview?.target_value ?? null,
        reached: data.preview?.would_be_outcome?.end_working_kg ?? null,
        phase: data.preview?.would_be_outcome?.block_phase_at_end ?? null,
      });
    } catch {
      setErrorMsg("Network error. Please try again.");
    } finally {
      setPreviewLoading(false);
    }
  }, [reason]);

  const confirmClose = useCallback(async () => {
    if (reason.trim().length < 4) return;
    setConfirmLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/blocks/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), confirm: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? "Close failed.");
        return;
      }
      closeDialog();
      await qc.invalidateQueries({ queryKey: queryKeys.blockSummary.all(userId) });
      await qc.invalidateQueries({ queryKey: queryKeys.blocksRepo.all(userId) });
    } catch {
      setErrorMsg("Network error. Please try again.");
    } finally {
      setConfirmLoading(false);
    }
  }, [reason, closeDialog, qc, userId]);

  // Format block dates for display
  const fmtDate = (iso: string) => {
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };

  // Chart data — actual points; when a future projected-hit week exists (only
  // possible on non-null-target blocks per computeBlockPace), append a dashed
  // projection point at the target and anchor the dashed segment on the last
  // actual point so the two lines connect.
  const chartData: Array<{ week: string; actual: number | null; projected: number | null }> =
    chart.map((p) => ({ week: `W${p.week}`, actual: p.e1rm, projected: null }));
  if (
    pace.projectedHitWeek != null &&
    block.target_value != null &&
    chartData.length > 0 &&
    pace.projectedHitWeek > (chart[chart.length - 1]?.week ?? 0)
  ) {
    chartData[chartData.length - 1].projected = chart[chart.length - 1].e1rm;
    chartData.push({
      week: `W${pace.projectedHitWeek}`,
      actual: null,
      projected: block.target_value,
    });
  }

  const dialogContent = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(15,20,48,0.5)",
        display: "flex",
        alignItems: "flex-end",
        padding: "0 0 env(safe-area-inset-bottom, 0) 0",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) closeDialog(); }}
    >
      <div
        style={{
          width: "100%",
          background: COLOR.surface,
          borderRadius: `${RADIUS.card} ${RADIUS.card} 0 0`,
          padding: "20px 16px 28px",
          boxShadow: SHADOW.floating,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: COLOR.textMuted,
            marginBottom: 12,
          }}
        >
          Close block early
        </div>
        <div style={{ fontSize: 13, color: COLOR.textMid, marginBottom: 12, lineHeight: 1.5 }}>
          This will end the current block and generate an outcome card. You can start a new block right after.
        </div>

        <div style={{ marginBottom: 12 }}>
          <label
            style={{
              display: "block",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: COLOR.textMuted,
              marginBottom: 4,
            }}
          >
            Reason (required)
          </label>
          <textarea
            ref={textRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Hit target early, moving to next focus"
            rows={3}
            style={{
              width: "100%",
              background: COLOR.surfaceAlt,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: RADIUS.input,
              padding: "10px 12px",
              fontSize: 13,
              color: COLOR.textStrong,
              resize: "none",
              fontFamily: "inherit",
            }}
          />
          <div style={{ fontSize: 10, color: COLOR.textMuted, marginTop: 2 }}>
            Minimum 4 characters
          </div>
        </div>

        {preview && (
          <div
            style={{
              background: COLOR.surfaceAlt,
              borderRadius: RADIUS.cardSmall,
              padding: "10px 12px",
              marginBottom: 12,
              fontSize: 12,
              color: COLOR.textMid,
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 700, color: COLOR.textStrong, marginBottom: 4 }}>
              Preview outcome
            </div>
            <div>
              Target:{" "}
              <strong style={{ color: COLOR.textStrong }}>
                {preview.target != null ? `${fmtNum(preview.target)} kg` : "—"}
              </strong>
              {" · "}
              Reached:{" "}
              <strong style={{ color: COLOR.textStrong }}>
                {preview.reached != null ? `${fmtNum(preview.reached)} kg` : "—"}
              </strong>
            </div>
            {preview.phase && (
              <div style={{ marginTop: 2, textTransform: "capitalize", color: COLOR.textMid }}>
                Outcome: {preview.phase.replace(/_/g, " ")}
              </div>
            )}
          </div>
        )}

        {errorMsg && (
          <div
            style={{
              fontSize: 12,
              color: COLOR.dangerDeep,
              background: COLOR.dangerSoft,
              borderRadius: RADIUS.chip,
              padding: "6px 10px",
              marginBottom: 10,
            }}
          >
            {errorMsg}
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={closeDialog}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: RADIUS.full,
              background: COLOR.surfaceAlt,
              color: COLOR.textMid,
              fontSize: 13,
              fontWeight: 700,
              border: `1px solid ${COLOR.divider}`,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          {!preview ? (
            <button
              onClick={fetchPreview}
              disabled={previewLoading || reason.trim().length < 4}
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: RADIUS.full,
                background: COLOR.accent,
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                border: "none",
                cursor: previewLoading || reason.trim().length < 4 ? "not-allowed" : "pointer",
                opacity: previewLoading || reason.trim().length < 4 ? 0.6 : 1,
              }}
            >
              {previewLoading ? "Loading…" : "Preview outcome"}
            </button>
          ) : (
            <button
              onClick={confirmClose}
              disabled={confirmLoading}
              style={{
                flex: 1,
                padding: "10px 14px",
                borderRadius: RADIUS.full,
                background: COLOR.danger,
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                border: "none",
                cursor: confirmLoading ? "not-allowed" : "pointer",
                opacity: confirmLoading ? 0.6 : 1,
              }}
            >
              {confirmLoading ? "Closing…" : "Confirm close"}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div
        style={{
          background: COLOR.surface,
          borderRadius: RADIUS.card,
          border: `1px solid ${COLOR.divider}`,
          borderLeft: `3px solid ${COLOR.accent}`,
          padding: "14px",
          marginBottom: 10,
          boxShadow: SHADOW.card,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: COLOR.textMuted,
            }}
          >
            Current block · Week {weekNum} of {totalWeeks}
          </span>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: "0.05em",
              padding: "3px 9px",
              borderRadius: RADIUS.full,
              background: phaseTag.bg,
              color: phaseTag.fg,
            }}
          >
            {phaseTag.label}
          </span>
        </div>

        {/* Lift + target + date range */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginTop: 7,
          }}
        >
          <span style={{ fontSize: 17, fontWeight: 700, color: COLOR.textStrong }}>
            {(block.primary_lift ?? "—").toUpperCase()}
            {pace.currentBest != null && (
              <span style={{ fontWeight: 600 }}>
                {" · "}{fmtNum(pace.currentBest)} kg {valueLabel}
              </span>
            )}
          </span>
          <span style={{ fontSize: 11, color: COLOR.textMuted }}>
            {fmtDate(block.start_date)} → {fmtDate(block.end_date)}
          </span>
        </div>

        <div style={{ borderTop: `1px solid ${COLOR.divider}`, margin: "11px 0" }} />

        {/* 4-KPI row */}
        <div style={{ display: "flex", gap: 4 }}>
          {[
            {
              v: pace.currentBest != null ? `${fmtNum(pace.currentBest)}` : "—",
              l: `current ${valueLabel}`,
            },
            {
              v:
                pace.slopePerWeek != null
                  ? `+${fmtNum(pace.slopePerWeek)}/wk`
                  : "—",
              l: "observed step",
            },
            {
              v: pace.projectedHitWeek != null ? `Wk ${pace.projectedHitWeek}` : "—",
              l: "projected hit",
            },
            {
              v: pace.kgToGo != null ? `${fmtNum(pace.kgToGo)}` : "—",
              l: "kg to go",
            },
          ].map((kpi) => (
            <div
              key={kpi.l}
              style={{ flex: 1, textAlign: "center" }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: COLOR.textStrong }}>
                {kpi.v}
              </div>
              <div
                style={{
                  fontSize: 9,
                  color: COLOR.textMuted,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginTop: 2,
                }}
              >
                {kpi.l}
              </div>
            </div>
          ))}
        </div>

        {/* Trend chart */}
        {chartData.length > 0 && (
          <div style={{ marginTop: 10, height: 110 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -28 }}>
                <XAxis
                  dataKey="week"
                  tick={{ fill: COLOR.textMuted, fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: COLOR.textMuted, fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  domain={["auto", "auto"]}
                />
                {block.target_value != null && (
                  <ReferenceLine
                    y={block.target_value}
                    stroke={COLOR.accent}
                    strokeDasharray="5 4"
                    strokeWidth={1.4}
                    strokeOpacity={0.55}
                    label={{
                      value: `target ${fmtNum(block.target_value)}`,
                      position: "right",
                      fill: COLOR.accent,
                      fontSize: 9,
                      fontWeight: 700,
                    }}
                  />
                )}
                <Tooltip
                  cursor={{ stroke: COLOR.divider, strokeWidth: 1 }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const val = payload[0]?.value;
                    return (
                      <div
                        style={{
                          background: COLOR.surface,
                          borderRadius: 10,
                          boxShadow: SHADOW.card,
                          padding: "6px 10px",
                          fontSize: 12,
                        }}
                      >
                        <strong style={{ color: COLOR.accent }}>{label}</strong>{" "}
                        <span style={{ color: COLOR.textStrong }}>
                          {val != null ? `${fmtNum(Number(val))} kg` : "—"}
                        </span>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke={COLOR.accent}
                  strokeWidth={2.2}
                  dot={{ r: 3.4, fill: COLOR.accent, stroke: "none" }}
                  activeDot={{ r: 4, fill: COLOR.accent }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="projected"
                  stroke="#b9c0ff"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={{ r: 3, fill: COLOR.surface, stroke: "#b9c0ff", strokeWidth: 1.6 }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div style={{ borderTop: `1px solid ${COLOR.divider}`, margin: "11px 0" }} />

        {/* This week strip */}
        <div
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: COLOR.textMuted,
          }}
        >
          This week
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 6,
            fontSize: 12.5,
          }}
        >
          <span>
            {thisWeek.rir != null && (
              <strong style={{ color: COLOR.textStrong }}>RIR {thisWeek.rir}</strong>
            )}
            {thisWeek.rir != null && " · "}
            {Object.keys(thisWeek.intensity).length > 0 && (
              <span style={{ color: COLOR.textMid }}>
                intensity{" "}
                {Object.values(thisWeek.intensity)
                  .slice(0, 1)
                  .map((v) => `${fmtNum(v)}×`)
                  .join("")}
              </span>
            )}
          </span>
          <span style={{ color: COLOR.textMuted, fontSize: 11 }}>
            sessions{" "}
            <strong style={{ color: COLOR.textStrong }}>
              {thisWeek.sessionsDone}/{thisWeek.sessionsPlanned}
            </strong>
          </span>
        </div>
        {thisWeek.nextSession && (
          <Link
            href="/strength?tab=schedule"
            style={{ textDecoration: "none" }}
          >
            <div
              style={{
                marginTop: 5,
                fontSize: 12,
                color: COLOR.textMuted,
              }}
            >
              Next:{" "}
              <strong style={{ color: COLOR.textStrong }}>
                {thisWeek.nextSession.weekday} · {thisWeek.nextSession.type}
                {thisWeek.nextSession.exercises[0] && (
                  <>
                    {" "}
                    {fmtNum(thisWeek.nextSession.exercises[0].kg ?? 0)} kg —{" "}
                    {thisWeek.nextSession.exercises[0].sets}×
                    {thisWeek.nextSession.exercises[0].reps}
                  </>
                )}
              </strong>
              {" (+2 warmup)"}
            </div>
          </Link>
        )}

        <div style={{ borderTop: `1px solid ${COLOR.divider}`, margin: "11px 0" }} />

        {/* Secondary lifts */}
        <div
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: COLOR.textMuted,
            marginBottom: 8,
          }}
        >
          Secondary lifts — maintenance
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {secondaries.map(({ lift, kg }) => (
            <div
              key={lift}
              style={{
                flex: 1,
                background: COLOR.surfaceAlt,
                borderRadius: RADIUS.cardSmall,
                padding: "7px 4px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 700, color: COLOR.textStrong }}>
                {kg != null ? `${fmtNum(kg)}` : "—"}
              </div>
              <div
                style={{
                  fontSize: 9,
                  color: COLOR.textMuted,
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                {lift}
              </div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
          <button
            onClick={openDialog}
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
              cursor: "pointer",
            }}
          >
            Close block early
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
            Discuss with Carter
          </Link>
        </div>
      </div>

      {mounted && dialogOpen && createPortal(dialogContent, document.body)}
    </>
  );
}
