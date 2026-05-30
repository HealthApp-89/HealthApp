// components/profile/EnduranceSetupSection.tsx
//
// /profile section for the endurance pillar Phase 1: Strava connect/disconnect,
// threshold HR (the calibration anchor for TSS computation), and weekly
// volume target slider. Discipline + phase are display-only in Phase 1 —
// Carter can mutate them via chat tool, but the UI ships them as
// "cycling / aerobic_base (more in Phase 2)".
//
// POSTs to /api/profile/endurance-profile, which mirrors the partial-update
// semantics of /api/profile/nutrition-overrides (undefined keeps, null
// clears, value sets).

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS, SHADOW } from "@/lib/ui/theme";
import type { EnduranceProfile } from "@/lib/coach/endurance/types";

type Props = {
  initial: EnduranceProfile | null;
  stravaConnected: boolean;
};

export function EnduranceSetupSection({ initial, stravaConnected }: Props) {
  const router = useRouter();
  const [thresholdHr, setThresholdHr] = useState<number | "">(
    initial?.threshold_hr ?? "",
  );
  const [volume, setVolume] = useState<number>(
    initial?.weekly_volume_target_hours ?? 1,
  );
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = () => {
    setSaved(false);
    setErr(null);
    startTransition(async () => {
      const body: Record<string, unknown> = {
        weekly_volume_target_hours: volume,
        threshold_hr: thresholdHr === "" ? null : Number(thresholdHr),
      };
      try {
        const res = await fetch("/api/profile/endurance-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setErr(j.error ?? "save_failed");
          return;
        }
        setSaved(true);
        // Re-run server components on /profile so any reader of the active
        // athlete profile (e.g., a future EnduranceTodaySection) picks up
        // the new endurance_profile on next paint.
        router.refresh();
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  };

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
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: COLOR.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Endurance
      </div>

      {/* ── Strava connection ─────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "8px 10px",
          background: COLOR.surfaceAlt,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: RADIUS.cardSmall,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>
            Strava
          </div>
          <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
            {stravaConnected
              ? "Connected — activities sync automatically."
              : "Not connected — manual ingest only."}
          </div>
        </div>
        {stravaConnected ? (
          <form action="/api/strava/disconnect" method="post">
            <button
              type="submit"
              style={{
                padding: "6px 10px",
                background: "transparent",
                color: COLOR.danger,
                border: `1px solid ${COLOR.divider}`,
                borderRadius: RADIUS.pill,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Disconnect
            </button>
          </form>
        ) : (
          <a
            href="/api/strava/auth"
            style={{
              padding: "6px 12px",
              background: "#fc4c02", // Strava brand orange
              color: "#fff",
              borderRadius: RADIUS.pill,
              fontSize: 12,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Connect Strava
          </a>
        )}
      </div>

      {/* ── Threshold HR ──────────────────────────────────────────────── */}
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 13,
          color: COLOR.textStrong,
        }}
      >
        <span style={{ color: COLOR.textMid }}>
          Threshold HR (LTHR, bpm)
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={80}
          max={220}
          value={thresholdHr}
          onChange={(e) =>
            setThresholdHr(
              e.target.value === "" ? "" : Number(e.target.value),
            )
          }
          style={{
            padding: "6px 10px",
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            fontSize: 13,
            color: COLOR.textStrong,
            width: "100%",
          }}
        />
        <span style={{ fontSize: 11, color: COLOR.textFaint }}>
          Required for TSS computation. Calibrate via 30-min time-trial avg HR.
        </span>
      </label>

      {/* ── Discipline / phase — display-only in Phase 1 ──────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: COLOR.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Discipline
          </div>
          <div style={{ fontSize: 13, color: COLOR.textStrong, marginTop: 2 }}>
            {initial?.discipline ?? "cycling"}{" "}
            <span style={{ fontSize: 11, color: COLOR.textFaint }}>
              (triathlon in Phase 2)
            </span>
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              color: COLOR.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Phase
          </div>
          <div style={{ fontSize: 13, color: COLOR.textStrong, marginTop: 2 }}>
            {initial?.phase ?? "aerobic_base"}{" "}
            <span style={{ fontSize: 11, color: COLOR.textFaint }}>
              (build/race-prep in Phase 2)
            </span>
          </div>
        </div>
      </div>

      {/* ── Weekly volume target ──────────────────────────────────────── */}
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 13,
          color: COLOR.textStrong,
        }}
      >
        <span style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: COLOR.textMid }}>Weekly volume target</span>
          <span style={{ fontFamily: "var(--font-mono, monospace)", color: COLOR.textStrong }}>
            {volume}h
          </span>
        </span>
        <input
          type="range"
          min={0.5}
          max={15}
          step={0.5}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          style={{ width: "100%" }}
        />
        <span style={{ fontSize: 11, color: COLOR.textFaint }}>
          Phase 1 default 1h (1×60min Z2/wk). Range leaves room for triathlon scale-up.
        </span>
      </label>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          alignItems: "center",
        }}
      >
        {err && (
          <span style={{ fontSize: 11, color: COLOR.danger }}>{err}</span>
        )}
        {saved && !err && (
          <span style={{ fontSize: 11, color: COLOR.success }}>Saved</span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={pending}
          style={{
            padding: "6px 12px",
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            borderRadius: RADIUS.pill,
            fontSize: 12,
            fontWeight: 600,
            cursor: pending ? "wait" : "pointer",
            opacity: pending ? 0.5 : 1,
          }}
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
