// components/morning/MorningCheckinCard.tsx
//
// One-tap morning check-in card (spec 2026-07-10). Renders in ChatPanel's
// bottom slot while the morning_form assistant turn is the latest message.
// Collapsed: "Same as usual" (writes server-computed personal defaults) or
// "Adjust" (expands an inline form prefilled with those defaults).

"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { SORENESS_AREAS } from "@/lib/morning/script";
import type { BatchValues } from "@/lib/morning/batch";
import type { FatigueLevel, SorenessSeverity } from "@/lib/data/types";

type Defaults = { readiness: number; fatigue: FatigueLevel };

export type MorningIntakeBody =
  | { kind: "all_good" }
  | { kind: "batch"; values: BatchValues; notes?: string };

export function MorningCheckinCard({
  defaults,
  onSubmit,
}: {
  defaults: Defaults;
  onSubmit: (body: MorningIntakeBody) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [readiness, setReadiness] = useState<number>(defaults.readiness);
  const [fatigue, setFatigue] = useState<FatigueLevel>(defaults.fatigue);
  const [areas, setAreas] = useState<Set<string>>(new Set());
  const [severity, setSeverity] = useState<SorenessSeverity>("mild");
  const [bloating, setBloating] = useState(false);
  const [sick, setSick] = useState(false);
  const [notes, setNotes] = useState("");

  const submit = async (body: MorningIntakeBody) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
    // On success the thread refetch replaces the last message; this card
    // unmounts. Only reset busy on error so the buttons can't double-fire.
  };

  const submitBatch = () => {
    const values: BatchValues = {
      readiness,
      fatigue,
      soreness_areas: Array.from(areas) as BatchValues["soreness_areas"],
      soreness_severity: areas.size > 0 ? severity : null,
      bloating,
      sick,
    };
    const trimmed = notes.trim();
    void submit(trimmed ? { kind: "batch", values, notes: trimmed } : { kind: "batch", values });
  };

  const fatigueLabel = { none: "no", some: "some", heavy: "heavy" }[defaults.fatigue];

  if (!expanded) {
    return (
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit({ kind: "all_good" })}
          style={{ ...btnStyle(true), opacity: busy ? 0.6 : 1 }}
        >
          ✓ Same as usual
          <span style={{ display: "block", fontSize: "11px", fontWeight: 400, opacity: 0.8 }}>
            feel {defaults.readiness} · {fatigueLabel} fatigue · no soreness
          </span>
        </button>
        <button type="button" disabled={busy} onClick={() => setExpanded(true)} style={btnStyle(false)}>
          Adjust →
        </button>
        {error && <ErrorLine text={error} />}
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <FieldRow label="Feel">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <Chip key={n} on={readiness === n} onTap={() => setReadiness(n)} label={String(n)} compact />
        ))}
      </FieldRow>
      <FieldRow label="Fatigue">
        {(["none", "some", "heavy"] as const).map((f) => (
          <Chip key={f} on={fatigue === f} onTap={() => setFatigue(f)} label={f} />
        ))}
      </FieldRow>
      <FieldRow label="Sore">
        {SORENESS_AREAS.map((a) => (
          <Chip
            key={a}
            on={areas.has(a)}
            onTap={() =>
              setAreas((s) => {
                const next = new Set(s);
                if (next.has(a)) next.delete(a);
                else next.add(a);
                return next;
              })
            }
            label={a}
          />
        ))}
      </FieldRow>
      {areas.size > 0 && (
        <FieldRow label="Severity">
          {(["mild", "sharp"] as const).map((s) => (
            <Chip key={s} on={severity === s} onTap={() => setSeverity(s)} label={s} />
          ))}
        </FieldRow>
      )}
      <FieldRow label="Bloated">
        <Chip on={!bloating} onTap={() => setBloating(false)} label="no" />
        <Chip on={bloating} onTap={() => setBloating(true)} label="yes" />
      </FieldRow>
      <FieldRow label="Sick">
        <Chip on={!sick} onTap={() => setSick(false)} label="no" />
        <Chip on={sick} onTap={() => setSick(true)} label="yes" />
      </FieldRow>
      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={2000}
        placeholder="Anything else? (optional)"
        style={{
          padding: "8px 12px",
          borderRadius: "10px",
          border: `1px solid ${COLOR.divider}`,
          background: COLOR.surfaceAlt,
          color: COLOR.textStrong,
          fontSize: "13px",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", gap: "6px" }}>
        <button type="button" disabled={busy} onClick={() => setExpanded(false)} style={btnStyle(false)}>
          ← Back
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={submitBatch}
          style={{ ...btnStyle(true), flex: 1, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Saving…" : "Submit"}
        </button>
      </div>
      {error && <ErrorLine text={error} />}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      <span
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: COLOR.textMuted,
          width: "58px",
          flexShrink: 0,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  on, onTap, label, compact,
}: {
  on: boolean; onTap: () => void; label: string; compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      style={{
        padding: compact ? "6px 9px" : "6px 12px",
        borderRadius: "999px",
        background: on ? COLOR.accent : COLOR.surfaceAlt,
        color: on ? "#fff" : COLOR.textStrong,
        border: "none",
        fontSize: "12px",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: "12px",
    background: primary ? COLOR.accent : COLOR.surfaceAlt,
    color: primary ? "#fff" : COLOR.textStrong,
    border: "none",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
  };
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div style={{ fontSize: "11px", color: "#f87171" }}>
      Couldn&apos;t save — {text}. Tap again to retry.
    </div>
  );
}
