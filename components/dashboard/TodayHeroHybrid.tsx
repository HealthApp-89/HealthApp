"use client";

import React from "react";
import Link from "next/link";
import { ArrowRight, Activity, Moon, Zap } from "lucide-react";
import { COLOR, RADIUS, SHADOW, METRIC_COLOR } from "@/lib/ui/theme";
import { fmtNum } from "@/lib/ui/score";

export type HeroMetricCell = {
  key: "hrv" | "sleep" | "strain";
  value: number | null;
  deltaLabel: string;
  deltaTone: "ok" | "alert" | "mute";
};

type Props = {
  narrative: string;
  score: number | null;
  band: "primed" | "moderate" | "easy" | "rest";
  metrics: HeroMetricCell[];
  briefHref?: string;
};

const BAND_LABEL: Record<Props["band"], string> = {
  primed:   "Primed",
  moderate: "Solid",
  easy:     "Easy day",
  rest:     "Rest day",
};

const ICON_FOR: Record<HeroMetricCell["key"], React.ComponentType<{ size?: number; color?: string }>> = {
  hrv:    Activity,
  sleep:  Moon,
  strain: Zap,
};

const COLOR_FOR: Record<HeroMetricCell["key"], string> = {
  hrv:    METRIC_COLOR.hrv,
  sleep:  METRIC_COLOR.sleep_hours,
  strain: METRIC_COLOR.strain,
};

const METRIC_NAME: Record<HeroMetricCell["key"], string> = {
  hrv:    "HRV",
  sleep:  "Sleep",
  strain: "Strain",
};

/**
 * Single hybrid hero card for `/`. Replaces ReadinessHero + BriefStateChip
 * with a unified surface: narrative sentence on top, readiness score and
 * three contributing metric cells layered beneath, "Open today's brief"
 * CTA at the bottom. Numbers via `fmtNum` per the two-decimal rule.
 */
export function TodayHeroHybrid({ narrative, score, band, metrics, briefHref }: Props) {
  return (
    <div
      style={{
        background: COLOR.surface,
        borderRadius: RADIUS.card,
        boxShadow: SHADOW.card,
        padding: "16px 18px",
      }}
    >
      {/* Band pill */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span
          style={{
            display: "inline-block",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            padding: "4px 10px",
            borderRadius: 999,
            background: COLOR.accentSoft,
            color: COLOR.accent,
          }}
        >
          {BAND_LABEL[band]}
        </span>
      </div>

      {/* Narrative */}
      <p style={{ margin: 0, fontSize: 18, lineHeight: 1.35, color: COLOR.textStrong, fontWeight: 500 }}>
        {narrative}
      </p>

      {/* Score + metric cells */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: 16,
          paddingTop: 14,
          borderTop: `1px solid ${COLOR.divider}`,
        }}
      >
        <div style={{ flexShrink: 0 }}>
          <div style={{ fontSize: 36, fontWeight: 700, lineHeight: 1, color: COLOR.accent }}>
            {score == null ? "—" : fmtNum(score)}
          </div>
          <div
            style={{
              fontSize: 10,
              color: COLOR.textMuted,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginTop: 2,
              fontWeight: 600,
            }}
          >
            / 100
          </div>
        </div>

        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          {metrics.map((m) => {
            const Icon = ICON_FOR[m.key];
            const tone =
              m.deltaTone === "alert" ? COLOR.danger :
              m.deltaTone === "ok"    ? COLOR.success :
              COLOR.textMuted;
            return (
              <div key={m.key} style={{ textAlign: "center" }}>
                <div
                  style={{
                    width: 24, height: 24, borderRadius: 999,
                    background: COLOR.surfaceAlt,
                    color: COLOR_FOR[m.key],
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    marginBottom: 2,
                  }}
                  aria-hidden="true"
                >
                  <Icon size={12} />
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: COLOR.textMuted,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    fontWeight: 600,
                  }}
                >
                  {METRIC_NAME[m.key]}
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: tone }}>
                  {m.deltaLabel}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* CTA */}
      {briefHref && (
        <Link
          href={briefHref}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 14,
            padding: "12px 14px",
            background: COLOR.accent,
            color: "white",
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          <span>Open today&apos;s brief</span>
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}
