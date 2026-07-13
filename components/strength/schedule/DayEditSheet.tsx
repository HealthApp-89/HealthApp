"use client";

// DayEditSheet — manual set/weight/reps editing for one schedule day.
//
// Per-exercise steppers (sets ±1, kg ± increment grid, reps ±1) + ▲▼ reorder,
// with an EDITED chip whenever a row diverges from the ENGINE baseline (the
// plan resolved WITHOUT the manual-edit layer). Save opens a scope dialog:
//
//   - "This week only"  → PATCH /api/training-weeks/[week_start]/manual-edits
//                         with the full diff of touched rows (order when
//                         changed + per-exercise deltas for changed fields
//                         only). An all-reset diff sends `edits: null` which
//                         clears the day's manual layer server-side.
//   - "Whole block"     → PATCH /api/blocks/[id]/structure-overrides with
//                         {order?, sets?} — kg/reps are deliberately stripped
//                         (weights & reps stay coach-managed across weeks).
//                         Disabled when there is no active block, or when the
//                         diff carries no order/sets change.
//
// Portaled to document.body (mounted guard) — the sheet must escape any
// ancestor stacking context (BottomNav is body-level z-40; LoggerSheet lesson).

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";
import { queryKeys } from "@/lib/query/keys";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

type Row = {
  name: string;
  sets: number;
  kg: number | null;
  reps: number | null;
  /** Weight stepper grid for this exercise (increment.step ?? 2.5). */
  step: number;
};

type BaselineRow = { sets: number; kg: number | null; reps: number | null };

type Props = {
  userId: string;
  weekStart: string;
  /** Full weekday name ("Monday"…"Sunday") — manual_session_edits key form. */
  weekdayLong: string;
  sessionType: string;
  /** Engine-resolved plan WITHOUT the manual-edit layer (comparison target). */
  baseline: PlannedExercise[];
  /** Engine-resolved plan WITH manual edits applied (what the athlete sees). */
  current: PlannedExercise[];
  /** Active training block id — null disables the "Whole block" scope. */
  activeBlockId: string | null;
  onClose: () => void;
};

function toRow(ex: PlannedExercise): Row {
  return {
    name: ex.name,
    sets: ex.sets ?? 3,
    kg: ex.baseKg ?? null,
    reps: ex.baseReps ?? null,
    step: ex.increment?.step ?? 2.5,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Snap float noise from repeated ± steps back onto the 0.25 kg grid. */
function snapQuarter(v: number): number {
  return Math.round(v * 4) / 4;
}

/** Keep the first occurrence per name among NON-WARMUP entries. Warmup ramp
 *  entries duplicate their working entry's name (engine-owned) — the edit
 *  layer never touches them, so they must not become rows / diff keys. */
function editableEntries(exercises: PlannedExercise[]): PlannedExercise[] {
  const seen = new Set<string>();
  const out: PlannedExercise[] = [];
  for (const e of exercises) {
    if (e.warmup || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}

export function DayEditSheet({
  userId,
  weekStart,
  weekdayLong,
  sessionType,
  baseline,
  current,
  activeBlockId,
  onClose,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => editableEntries(current).map(toRow));
  const [step, setStep] = useState<"edit" | "scope">("edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => setMounted(true), []);

  const warmupCount = useMemo(() => current.filter((e) => e.warmup).length, [current]);

  const baselineMap = useMemo(() => {
    const m = new Map<string, BaselineRow>();
    for (const ex of editableEntries(baseline)) {
      m.set(ex.name, { sets: ex.sets ?? 3, kg: ex.baseKg ?? null, reps: ex.baseReps ?? null });
    }
    return m;
  }, [baseline]);
  const baselineOrder = useMemo(() => editableEntries(baseline).map((e) => e.name), [baseline]);

  // ── diff vs engine baseline ────────────────────────────────────────────
  const diff = useMemo(() => {
    const order = rows.map((r) => r.name);
    const orderChanged =
      order.length === baselineOrder.length &&
      order.some((n, i) => n !== baselineOrder[i]);

    const exercises: Record<string, { sets?: number; kg?: number; reps?: number }> = {};
    for (const r of rows) {
      const b = baselineMap.get(r.name);
      if (!b) continue;
      const d: { sets?: number; kg?: number; reps?: number } = {};
      if (r.sets !== b.sets) d.sets = r.sets;
      if (r.kg != null && r.kg !== b.kg) d.kg = r.kg;
      if (r.reps != null && r.reps !== b.reps) d.reps = r.reps;
      if (Object.keys(d).length > 0) exercises[r.name] = d;
    }

    const setsMap: Record<string, number> = {};
    for (const [name, d] of Object.entries(exercises)) {
      if (d.sets !== undefined) setsMap[name] = d.sets;
    }

    return {
      orderChanged,
      order,
      exercises,
      hasFieldEdits: Object.keys(exercises).length > 0,
      setsMap,
      hasBlockScopedChange: orderChanged || Object.keys(setsMap).length > 0,
    };
  }, [rows, baselineMap, baselineOrder]);

  const dirty = diff.orderChanged || diff.hasFieldEdits;

  function rowEdited(r: Row): boolean {
    const b = baselineMap.get(r.name);
    if (!b) return false;
    return r.sets !== b.sets || (r.kg != null && r.kg !== b.kg) || (r.reps != null && r.reps !== b.reps);
  }

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function move(i: number, dir: -1 | 1) {
    setRows((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function resetRow(i: number) {
    setRows((prev) =>
      prev.map((r, idx) => {
        if (idx !== i) return r;
        const b = baselineMap.get(r.name);
        if (!b) return r;
        return { ...r, sets: b.sets, kg: b.kg, reps: b.reps };
      }),
    );
  }

  // ── save handlers ──────────────────────────────────────────────────────
  async function saveThisWeek() {
    setSaving(true);
    setError(null);
    try {
      const edits =
        diff.orderChanged || diff.hasFieldEdits
          ? {
              ...(diff.orderChanged ? { order: diff.order } : {}),
              ...(diff.hasFieldEdits ? { exercises: diff.exercises } : {}),
            }
          : null; // fully back on plan → clear the day's manual layer
      const res = await fetch(
        `/api/training-weeks/${weekStart}/manual-edits`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weekday: weekdayLong, edits }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(typeof json.error === "string" ? json.error : `Save failed (${res.status})`);
        return;
      }
      await invalidateAndClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed — check your connection.");
    } finally {
      setSaving(false);
    }
  }

  async function saveWholeBlock() {
    if (!activeBlockId || !diff.hasBlockScopedChange) return;
    setSaving(true);
    setError(null);
    try {
      const override = {
        ...(diff.orderChanged ? { order: diff.order } : {}),
        ...(Object.keys(diff.setsMap).length > 0 ? { sets: diff.setsMap } : {}),
      };
      const res = await fetch(`/api/blocks/${activeBlockId}/structure-overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_type: sessionType, override }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(typeof json.error === "string" ? json.error : `Save failed (${res.status})`);
        return;
      }
      await invalidateAndClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed — check your connection.");
    } finally {
      setSaving(false);
    }
  }

  async function invalidateAndClose() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.trainingWeeks.all(userId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.blockSummary.all(userId) }),
    ]);
    onClose();
  }

  if (!mounted) return null;

  const blockDisabledHint = !activeBlockId
    ? "No active block — start one on the Blocks tab to save structure block-wide."
    : !diff.hasBlockScopedChange
      ? "Only order & set-count changes apply block-wide — weight/rep edits are week-scoped."
      : null;

  return createPortal(
    <BottomSheet open onClose={onClose} title={`Edit ${weekdayLong} — ${sessionType}`}>
      {step === "edit" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {rows.map((r, i) => {
            const b = baselineMap.get(r.name);
            const edited = rowEdited(r);
            return (
              <div
                key={r.name}
                style={{
                  padding: "10px 0 8px",
                  borderTop: i === 0 ? "none" : `1px solid ${COLOR.divider}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {/* Reorder */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <ArrowBtn label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>▲</ArrowBtn>
                    <ArrowBtn label={`Move ${r.name} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>▼</ArrowBtn>
                  </div>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 13,
                      fontWeight: 600,
                      color: COLOR.textStrong,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.name.split("(")[0].trim()}
                    {edited && (
                      <span
                        style={{
                          marginLeft: 6,
                          padding: "2px 7px",
                          borderRadius: 9999,
                          background: COLOR.warningSoft,
                          color: COLOR.warningDeep,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: "0.04em",
                          verticalAlign: "middle",
                        }}
                      >
                        EDITED
                      </span>
                    )}
                  </span>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, paddingLeft: 28 }}>
                  <Stepper
                    label={`${fmtNum(r.sets)} sets`}
                    onDec={() => update(i, { sets: clamp(r.sets - 1, 1, 10) })}
                    onInc={() => update(i, { sets: clamp(r.sets + 1, 1, 10) })}
                    decDisabled={r.sets <= 1}
                    incDisabled={r.sets >= 10}
                    ariaName={`${r.name} sets`}
                  />
                  {r.kg != null ? (
                    <Stepper
                      label={`${fmtNum(r.kg)} kg`}
                      onDec={() => update(i, { kg: snapQuarter(clamp(r.kg! - r.step, 0, 500)) })}
                      onInc={() => update(i, { kg: snapQuarter(clamp(r.kg! + r.step, 0, 500)) })}
                      decDisabled={r.kg <= 0}
                      incDisabled={r.kg >= 500}
                      ariaName={`${r.name} weight`}
                    />
                  ) : (
                    <span style={{ fontSize: 11, color: COLOR.textFaint, alignSelf: "center" }}>BW</span>
                  )}
                  {r.reps != null && (
                    <Stepper
                      label={`${fmtNum(r.reps)} reps`}
                      onDec={() => update(i, { reps: clamp(r.reps! - 1, 1, 30) })}
                      onInc={() => update(i, { reps: clamp(r.reps! + 1, 1, 30) })}
                      decDisabled={r.reps <= 1}
                      incDisabled={r.reps >= 30}
                      ariaName={`${r.name} reps`}
                    />
                  )}
                </div>

                {edited && b && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: 6,
                      paddingLeft: 28,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        color: COLOR.textMuted,
                        fontFamily: "var(--font-dm-mono), monospace",
                      }}
                    >
                      engine: {fmtNum(b.sets)}×{b.reps != null ? fmtNum(b.reps) : "—"}
                      {b.kg != null ? ` @ ${fmtNum(b.kg)}` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => resetRow(i)}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        fontSize: 10,
                        color: COLOR.textMuted,
                        textDecoration: "underline",
                        cursor: "pointer",
                      }}
                    >
                      reset to plan
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {warmupCount > 0 && (
            <p style={{ fontSize: 11, color: COLOR.textFaint, margin: "8px 0 0" }}>
              + {warmupCount} warmup ramp {warmupCount === 1 ? "set" : "sets"} (engine-managed, not editable here).
            </p>
          )}

          <p style={{ fontSize: 11, color: COLOR.textFaint, margin: "8px 0 0" }}>
            Weight steps follow each exercise&apos;s grid (barbell 2.5 · DB pair 4).
          </p>

          {error && <ErrorNote error={error} />}

          <button
            type="button"
            onClick={() => { setError(null); setStep("scope"); }}
            disabled={saving}
            style={{
              marginTop: 12,
              padding: "12px 14px",
              borderRadius: 10,
              border: "none",
              background: COLOR.textStrong,
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            Save changes
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 12, color: COLOR.textMid, margin: 0 }}>
            Where should this change apply?
          </p>

          <button
            type="button"
            onClick={saveThisWeek}
            disabled={saving}
            style={{
              padding: "12px 14px",
              borderRadius: 12,
              border: `1px solid ${COLOR.divider}`,
              background: COLOR.surfaceAlt,
              textAlign: "left",
              cursor: "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: COLOR.textStrong }}>
              This week only
            </span>
            <span style={{ display: "block", fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
              {dirty
                ? "Holds your edits for this week; the engine keeps repatching untouched exercises."
                : "Everything matches the plan — saving clears this day's manual edits."}
            </span>
          </button>

          <button
            type="button"
            onClick={saveWholeBlock}
            disabled={saving || !activeBlockId || !diff.hasBlockScopedChange}
            style={{
              padding: "12px 14px",
              borderRadius: 12,
              border: `1px solid ${COLOR.divider}`,
              background: COLOR.surfaceAlt,
              textAlign: "left",
              cursor: !activeBlockId || !diff.hasBlockScopedChange ? "default" : "pointer",
              opacity: saving || !activeBlockId || !diff.hasBlockScopedChange ? 0.5 : 1,
            }}
          >
            <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: COLOR.textStrong }}>
              Whole block
            </span>
            <span style={{ display: "block", fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
              {blockDisabledHint ??
                `Order & set counts persist for every ${sessionType} session this block. Weights & reps stay coach-managed across weeks.`}
            </span>
          </button>

          {error && <ErrorNote error={error} />}

          <button
            type="button"
            onClick={() => setStep("edit")}
            disabled={saving}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: "none",
              background: "transparent",
              color: COLOR.textMuted,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ← Back to editing
          </button>
        </div>
      )}
    </BottomSheet>,
    document.body,
  );
}

function ErrorNote({ error }: { error: string }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 8,
        background: COLOR.dangerSoft,
        border: `1px solid ${COLOR.danger}`,
        color: COLOR.dangerDeep,
        fontSize: 12,
      }}
    >
      {error}
    </div>
  );
}

function ArrowBtn({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 22,
        height: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${COLOR.divider}`,
        borderRadius: 5,
        background: COLOR.surfaceAlt,
        color: disabled ? COLOR.textFaint : COLOR.textMid,
        fontSize: 8,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function Stepper({
  label,
  onDec,
  onInc,
  decDisabled,
  incDisabled,
  ariaName,
}: {
  label: string;
  onDec: () => void;
  onInc: () => void;
  decDisabled: boolean;
  incDisabled: boolean;
  ariaName: string;
}) {
  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    border: "none",
    background: "transparent",
    color: disabled ? COLOR.textFaint : COLOR.accent,
    fontSize: 13,
    fontWeight: 800,
    cursor: disabled ? "default" : "pointer",
    lineHeight: 1.2,
  });
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: `1px solid ${COLOR.divider}`,
        borderRadius: 9999,
        overflow: "hidden",
      }}
    >
      <button type="button" aria-label={`Decrease ${ariaName}`} onClick={onDec} disabled={decDisabled} style={btnStyle(decDisabled)}>
        −
      </button>
      <b
        data-tnum
        style={{
          fontSize: 11.5,
          padding: "4px 6px",
          minWidth: 52,
          textAlign: "center",
          background: COLOR.surfaceAlt,
          color: COLOR.textStrong,
          fontFamily: "var(--font-dm-mono), monospace",
        }}
      >
        {label}
      </b>
      <button type="button" aria-label={`Increase ${ariaName}`} onClick={onInc} disabled={incDisabled} style={btnStyle(incDisabled)}>
        +
      </button>
    </span>
  );
}
