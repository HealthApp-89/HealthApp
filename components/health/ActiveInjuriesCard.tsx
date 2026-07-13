"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import type { Injury } from "@/lib/data/types";

type Props = { userId: string };

const SEVERITIES = ["mild", "moderate", "severe"] as const;
const LIFTS = ["squat", "bench", "deadlift", "ohp"] as const;
const SESSION_TYPES = ["Legs", "Chest", "Back", "Arms", "Mobility"] as const;

const SEVERITY_COLOR: Record<string, string> = {
  mild: COLOR.success,
  moderate: COLOR.warning,
  severe: COLOR.danger,
};
const SEVERITY_BG: Record<string, string> = {
  mild: COLOR.successSoft,
  moderate: COLOR.warningSoft,
  severe: COLOR.dangerSoft,
};

async function fetchInjuries(): Promise<Injury[]> {
  const res = await fetch("/api/injuries");
  if (!res.ok) throw new Error("Failed to fetch injuries");
  const json = (await res.json()) as { ok: boolean; injuries: Injury[] };
  return json.injuries ?? [];
}

export function ActiveInjuriesCard({ userId }: Props) {
  const queryClient = useQueryClient();
  const { data: injuries, isLoading, isError } = useQuery({
    queryKey: queryKeys.injuries.all(userId),
    queryFn: fetchInjuries,
  });

  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Form state
  const [area, setArea] = useState("");
  const [side, setSide] = useState<"" | "left" | "right">("");
  const [cause, setCause] = useState("");
  const [severity, setSeverity] = useState<"mild" | "moderate" | "severe">("moderate");
  const [onsetDate, setOnsetDate] = useState("");
  const [sessionTypes, setSessionTypes] = useState<string[]>([]);
  const [lifts, setLifts] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const activeInjuries = (injuries ?? []).filter((i) => i.status === "active");

  async function handleResolve(id: string) {
    setResolving(id);
    setResolveError(null);
    try {
      const res = await fetch(`/api/injuries/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      });
      if (res.ok) {
        setResolveError(null);
        await queryClient.invalidateQueries({ queryKey: queryKeys.injuries.all(userId) });
      } else {
        setResolveError("Couldn't resolve — try again.");
      }
    } catch (err) {
      setResolveError("Couldn't resolve — try again.");
    } finally {
      setResolving(null);
    }
  }

  function toggleSet(
    set: string[],
    setFn: (v: string[]) => void,
    value: string,
  ) {
    setFn(set.includes(value) ? set.filter((v) => v !== value) : [...set, value]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setResolveError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/injuries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          area: area.trim(),
          side: side || null,
          cause: cause.trim() || null,
          severity,
          onset_date: onsetDate || undefined,
          affected_session_types: sessionTypes,
          affected_lifts: lifts,
          notes: notes.trim() || null,
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setFormError(json.error ?? "Save failed");
        return;
      }
      // Reset form
      setArea("");
      setSide("");
      setCause("");
      setSeverity("moderate");
      setOnsetDate("");
      setSessionTypes([]);
      setLifts([]);
      setNotes("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.injuries.all(userId) });
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      style={{
        margin: "0 0 4px",
        padding: "12px 16px",
        background: COLOR.surface,
        borderRadius: RADIUS.card,
        boxShadow: SHADOW.card,
      }}
    >
      <h2
        style={{
          fontSize: 13,
          color: COLOR.textMid,
          margin: "0 0 8px",
          fontWeight: 600,
        }}
      >
        Active injuries
      </h2>

      {resolveError && (
        <div style={{ fontSize: 12, color: COLOR.danger, marginBottom: 8 }}>
          {resolveError}
        </div>
      )}

      {isLoading ? (
        <div style={{ fontSize: 12, color: COLOR.textMuted }}>Loading…</div>
      ) : isError ? (
        <div style={{ fontSize: 12, color: COLOR.danger, marginBottom: 8 }}>
          Couldn't load injuries — try refreshing.
        </div>
      ) : activeInjuries.length === 0 ? (
        <div
          style={{ fontSize: 12, color: COLOR.textMuted, fontStyle: "italic", marginBottom: 8 }}
        >
          No active injuries recorded.
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0 0 8px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {activeInjuries.map((inj) => (
            <li
              key={inj.id}
              style={{
                background: COLOR.surfaceAlt,
                borderRadius: RADIUS.cardSmall,
                padding: "8px 10px",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: COLOR.textStrong }}>
                    {inj.area}
                    {inj.side ? ` (${inj.side})` : ""}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 7px",
                      borderRadius: RADIUS.full,
                      background: SEVERITY_BG[inj.severity] ?? COLOR.surfaceAlt,
                      color: SEVERITY_COLOR[inj.severity] ?? COLOR.textMid,
                      textTransform: "capitalize",
                    }}
                  >
                    {inj.severity}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
                  since {inj.onset_date}
                  {inj.affected_lifts.length > 0 && ` · lifts: ${inj.affected_lifts.join(", ")}`}
                  {inj.affected_session_types.length > 0 && ` · sessions: ${inj.affected_session_types.join(", ")}`}
                </div>
                {inj.notes && (
                  <div style={{ fontSize: 11, color: COLOR.textMid, marginTop: 3 }}>
                    {inj.notes}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={resolving === inj.id}
                onClick={() => handleResolve(inj.id)}
                style={{
                  flexShrink: 0,
                  padding: "5px 10px",
                  border: `1px solid ${COLOR.success}`,
                  borderRadius: RADIUS.chip,
                  background: "transparent",
                  color: COLOR.success,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: resolving === inj.id ? "not-allowed" : "pointer",
                  opacity: resolving === inj.id ? 0.5 : 1,
                }}
              >
                {resolving === inj.id ? "…" : "Resolve"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Collapsible report form */}
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            padding: "6px 12px",
            border: `1px solid ${COLOR.accent}`,
            borderRadius: RADIUS.chip,
            background: "transparent",
            color: COLOR.accent,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Report injury
        </button>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 4,
            padding: "10px",
            background: COLOR.surfaceAlt,
            borderRadius: RADIUS.cardSmall,
          }}
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>
            {/* Area */}
            <div style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: 3 }}>
              <label style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600 }}>Area *</label>
              <input
                required
                maxLength={40}
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="e.g. Left knee"
                style={inputStyle}
              />
            </div>
            {/* Side */}
            <div style={{ flex: "0 0 90px", display: "flex", flexDirection: "column", gap: 3 }}>
              <label style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600 }}>Side</label>
              <select value={side} onChange={(e) => setSide(e.target.value as "" | "left" | "right")} style={inputStyle}>
                <option value="">—</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </div>
            {/* Severity */}
            <div style={{ flex: "0 0 100px", display: "flex", flexDirection: "column", gap: 3 }}>
              <label style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600 }}>Severity</label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as "mild" | "moderate" | "severe")}
                style={inputStyle}
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s} style={{ textTransform: "capitalize" }}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            {/* Onset date */}
            <div style={{ flex: "0 0 130px", display: "flex", flexDirection: "column", gap: 3 }}>
              <label style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600 }}>Onset date</label>
              <input
                type="date"
                value={onsetDate}
                onChange={(e) => setOnsetDate(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>

          {/* Cause */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600 }}>Cause</label>
            <input
              maxLength={200}
              value={cause}
              onChange={(e) => setCause(e.target.value)}
              placeholder="e.g. Overuse, acute strain…"
              style={inputStyle}
            />
          </div>

          {/* Session types */}
          <div>
            <div style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600, marginBottom: 4 }}>
              Affected sessions
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {SESSION_TYPES.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => toggleSet(sessionTypes, setSessionTypes, st)}
                  style={chipStyle(sessionTypes.includes(st))}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          {/* Lifts */}
          <div>
            <div style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600, marginBottom: 4 }}>
              Affected lifts
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {LIFTS.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => toggleSet(lifts, setLifts, l)}
                  style={chipStyle(lifts.includes(l))}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={{ fontSize: 11, color: COLOR.textMid, fontWeight: 600 }}>Notes</label>
            <textarea
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional context…"
              rows={2}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
          </div>

          {formError && (
            <div style={{ fontSize: 11, color: COLOR.danger }}>{formError}</div>
          )}

          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="submit"
              disabled={submitting || !area.trim()}
              style={{
                padding: "7px 14px",
                border: "none",
                borderRadius: RADIUS.chip,
                background: submitting || !area.trim() ? COLOR.surfaceAlt : COLOR.accent,
                color: submitting || !area.trim() ? COLOR.textMuted : "white",
                fontSize: 12,
                fontWeight: 600,
                cursor: submitting || !area.trim() ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Saving…" : "Save injury"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setFormError(null);
              }}
              style={{
                padding: "7px 14px",
                border: `1px solid ${COLOR.divider}`,
                borderRadius: RADIUS.chip,
                background: "transparent",
                color: COLOR.textMid,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: `1px solid ${COLOR.divider}`,
  borderRadius: RADIUS.chip,
  fontSize: 12,
  color: COLOR.textStrong,
  background: COLOR.surface,
  width: "100%",
  boxSizing: "border-box",
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: RADIUS.full,
    border: `1px solid ${active ? COLOR.accent : COLOR.divider}`,
    background: active ? COLOR.accentSoft : COLOR.surface,
    color: active ? COLOR.accentDeep : COLOR.textMid,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  };
}
