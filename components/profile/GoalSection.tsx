"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";

type GoalKind = "lift_e1rm" | "bodyweight_kg" | "bodyfat_pct";

type Goal = {
  goal_kind: GoalKind | null;
  goal_metric: string | null;
  goal_target: number | null;
  goal_target_date: string | null;
};

const KIND_LABEL: Record<GoalKind, string> = {
  lift_e1rm: "Lift e1RM",
  bodyweight_kg: "Bodyweight",
  bodyfat_pct: "Body fat %",
};

const LIFT_OPTIONS = ["bench", "deadlift", "squat", "ohp"] as const;

/**
 * Compact form for the 4 structured goal fields used by the Peter Dashboard's
 * Goal-distance theme (migration 0035). Mounted under /profile → Coaching plan.
 * Updates the latest acknowledged athlete_profile_documents row in place
 * (these columns post-date the immutability rule).
 */
export function GoalSection() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [goal, setGoal] = useState<Goal>({
    goal_kind: null,
    goal_metric: null,
    goal_target: null,
    goal_target_date: null,
  });

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/profile/goal")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.goal) setGoal(j.goal);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const res = await fetch("/api/profile/goal", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goal),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? "save_failed");
        return;
      }
      setSaved(true);
      // Re-run server components on /coach + /profile so the Goal card picks
      // up the new structured fields. Avoid qc.invalidateQueries — that
      // refetches via fetchPeterDashboardBrowser which throws by design.
      router.refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 12, color: COLOR.textMuted, fontSize: 13 }}>
        Loading goal…
      </div>
    );
  }

  return (
    <div
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        boxShadow: SHADOW.card,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ fontSize: 11, color: COLOR.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Goal (for Peter Dashboard projection)
      </div>

      <Row label="Kind">
        <select
          value={goal.goal_kind ?? ""}
          onChange={(e) => setGoal({ ...goal, goal_kind: (e.target.value || null) as GoalKind | null, goal_metric: null })}
          style={selectStyle}
        >
          <option value="">— None —</option>
          {(Object.keys(KIND_LABEL) as GoalKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </Row>

      {goal.goal_kind === "lift_e1rm" && (
        <Row label="Lift">
          <select
            value={goal.goal_metric ?? ""}
            onChange={(e) => setGoal({ ...goal, goal_metric: e.target.value || null })}
            style={selectStyle}
          >
            <option value="">— Choose —</option>
            {LIFT_OPTIONS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </Row>
      )}

      <Row label={`Target ${unitFor(goal.goal_kind)}`}>
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          value={goal.goal_target ?? ""}
          onChange={(e) => {
            const n = e.target.value === "" ? null : Number(e.target.value);
            setGoal({ ...goal, goal_target: n });
          }}
          style={inputStyle}
        />
      </Row>

      <Row label="Target date">
        <input
          type="date"
          value={goal.goal_target_date ?? ""}
          onChange={(e) => setGoal({ ...goal, goal_target_date: e.target.value || null })}
          style={inputStyle}
        />
      </Row>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
        {err && <span style={{ fontSize: 11, color: COLOR.danger }}>{err}</span>}
        {saved && <span style={{ fontSize: 11, color: COLOR.success }}>Saved</span>}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            padding: "6px 12px",
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            borderRadius: RADIUS.pill,
            fontSize: 12,
            fontWeight: 600,
            cursor: saving ? "wait" : "pointer",
          }}
        >
          {saving ? "Saving…" : "Save goal"}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 13, color: COLOR.textStrong }}>
      <span style={{ flex: "0 0 130px", color: COLOR.textMid }}>{label}</span>
      <span style={{ flex: "1 1 auto", display: "flex", justifyContent: "flex-end" }}>{children}</span>
    </label>
  );
}

function unitFor(kind: GoalKind | null): string {
  if (kind === "lift_e1rm") return "(kg)";
  if (kind === "bodyweight_kg") return "(kg)";
  if (kind === "bodyfat_pct") return "(%)";
  return "";
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  background: COLOR.surfaceAlt,
  border: `1px solid ${COLOR.divider}`,
  borderRadius: RADIUS.input,
  fontSize: 13,
  color: COLOR.textStrong,
  minWidth: 0,
  width: 140,
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};
