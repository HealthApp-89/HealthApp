"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { COLOR } from "@/lib/ui/theme";
import type { SessionStructure } from "@/lib/coach/session-structure";

type Props = {
  structure: SessionStructure;
  /** Week-start (Sunday, YYYY-MM-DD) needed by the reorder endpoint. */
  weekStart: string;
  /** Full weekday name ("Monday"...) — the override key. */
  weekday: string;
};

/** Yellow banner shown when session-structure ordering rules fire. Renders
 *  the warnings inline, exposes an Apply-reorder button when
 *  suggested_order is non-null, and POSTs the override on click. */
export function SessionStructureBanner({ structure, weekStart, weekday }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (structure.warnings.length === 0) return null;

  const visible = structure.warnings.slice(0, 3);
  const overflow = structure.warnings.length - visible.length;

  async function applyReorder() {
    if (!structure.suggested_order) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/training-weeks/${weekStart}/exercise-overrides`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            weekday,
            exercises: structure.suggested_order.map(stripAnnotations),
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply reorder");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="note"
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: COLOR.warningSoft,
        border: `1px solid ${COLOR.warning}`,
        borderRadius: 8,
        fontSize: 13,
        color: COLOR.warningDeep,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div>
        <strong>
          {structure.warnings.length} ordering issue{structure.warnings.length === 1 ? "" : "s"}
        </strong>
        <ul style={{ margin: "6px 0 0 18px", padding: 0, listStyle: "disc" }}>
          {visible.map((w, i) => (
            <li key={i} style={{ marginBottom: 2 }}>
              {w.message}
            </li>
          ))}
          {overflow > 0 && (
            <li style={{ fontStyle: "italic", opacity: 0.85 }}>
              +{overflow} more
            </li>
          )}
        </ul>
      </div>
      {structure.suggested_order && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={applyReorder}
            disabled={submitting}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              background: COLOR.warning,
              color: "#fff",
              border: "none",
              cursor: submitting ? "wait" : "pointer",
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? "Applying…" : "Apply reorder"}
          </button>
          {error && (
            <span style={{ fontSize: 12, color: COLOR.danger }}>{error}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Strip the annotation fields before sending to the endpoint — server
 *  re-validates and persists only PlannedExercise fields. */
function stripAnnotations(e: SessionStructure["exercises"][number]) {
  const { fatigue_tier: _t, rest_seconds: _r, rpe_target: _rpe, cue: _c, ...rest } = e;
  return rest;
}
