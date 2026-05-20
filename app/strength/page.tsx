"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "log", label: "Log" },
];

export default function StrengthPage() {
  const params = useSearchParams();
  const tab = params.get("tab") === "log" ? "log" : "coach";

  return (
    <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
      <header style={{ padding: "16px 16px 4px 16px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Strength</h1>
        <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
          Coach Carter
        </p>
      </header>
      <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
      {tab === "coach" ? <CoachPlaceholder /> : <LogPlaceholder />}
    </div>
  );
}

function CoachPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Carter and today&apos;s session land here in PR 3.
      </p>
      <p style={{ fontSize: 13, color: COLOR.textMid, margin: "0 0 8px 0" }}>
        In the meantime:
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320, margin: "0 auto" }}>
        <Link
          href="/metrics?sub=strength"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          View today&apos;s session →
        </Link>
        <Link
          href="/coach"
          style={{
            display: "block",
            padding: "12px 16px",
            background: COLOR.surface,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            textDecoration: "none",
            color: COLOR.textStrong,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Chat with the coach team →
        </Link>
      </div>
    </div>
  );
}

function LogPlaceholder() {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 14, color: COLOR.textMuted, margin: "0 0 16px 0" }}>
        Workout history lands here in PR 3 (read-only). Manual entry comes later.
      </p>
      <p style={{ fontSize: 13, color: COLOR.textMid, margin: "0 0 8px 0" }}>
        For now: Strong CSV import is unchanged. See past workouts at
      </p>
      <Link
        href="/metrics?sub=strength"
        style={{
          display: "inline-block",
          padding: "12px 16px",
          background: COLOR.surface,
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 10,
          textDecoration: "none",
          color: COLOR.textStrong,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Strength tab on Metrics →
      </Link>
    </div>
  );
}
