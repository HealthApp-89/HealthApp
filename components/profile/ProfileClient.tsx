"use client";

import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { StatusRow } from "@/components/ui/StatusRow";
import { BottomSheet } from "@/components/ui/BottomSheet";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { BaselinesPanel } from "@/components/profile/BaselinesPanel";
import { ConnectionsPanel } from "@/components/profile/ConnectionsPanel";
import { IngestPanel } from "@/components/profile/IngestPanel";
import { COLOR } from "@/lib/ui/theme";
import type { DailyLog } from "@/lib/data/types";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { useWhoopTokens } from "@/lib/query/hooks/useWhoopTokens";
import { useWithingsTokens } from "@/lib/query/hooks/useWithingsTokens";
import { useIngestToken } from "@/lib/query/hooks/useIngestToken";
import { useDailyLogs } from "@/lib/query/hooks/useDailyLogs";
import { AthleteProfilePanel } from "@/components/profile/AthleteProfilePanel";
import { LabPromptCard } from "@/components/profile/LabPromptCard";
import { NutritionTargetsSection } from "@/components/profile/NutritionTargetsSection";
import { GoalSection } from "@/components/profile/GoalSection";
import { useAthleteProfile } from "@/lib/query/hooks/useAthleteProfile";

export function ProfileClient({
  userId,
  userEmail,
  baselineFrom,
  baselineTo,
  today,
  appUrl,
}: {
  userId: string;
  userEmail: string | null;
  /** Inclusive lower bound for the baseline-window query — we ship 'all-time'
   *  so callers pass the earliest plausible date. */
  baselineFrom: string;
  baselineTo: string;
  /** Today's date (YYYY-MM-DD) in the user's tz; passed from the server page
   *  so NutritionTargetsSection keys its useTodayTargets hook deterministically. */
  today: string;
  appUrl: string;
}) {
  const { data: profile } = useProfile(userId);
  const { data: whoopTokens = null } = useWhoopTokens(userId);
  const { data: withingsTokens = null } = useWithingsTokens(userId);
  const { data: ingestToken = null } = useIngestToken(userId);
  const { data: logs = [] } = useDailyLogs(userId, baselineFrom, baselineTo);
  const { data: activeProfile } = useAthleteProfile(userId);
  const showLabCard = activeProfile?.plan_payload?.nutrition?.glp1 != null;

  // The User card at the top doubles as the edit affordance — tap opens a
  // BottomSheet containing ProfileForm. Replaces the previous inline
  // "Profile details" section.
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "4px 12px 14px",
        }}
      >
        <div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>
            Account &amp; integrations
          </div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginTop: "2px",
            }}
          >
            Profile
          </h1>
        </div>
        <span style={{ fontSize: "18px", color: COLOR.textMuted }}>⚙</span>
      </div>

      <div style={{ padding: "0 8px 14px" }}>
        <Card
          style={{
            display: "flex",
            gap: "14px",
            alignItems: "center",
            cursor: "pointer",
          }}
          onClick={() => setEditOpen(true)}
          role="button"
          tabIndex={0}
          aria-label="Edit profile"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setEditOpen(true);
            }
          }}
        >
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "50%",
              background: `linear-gradient(135deg, ${COLOR.accent}, ${COLOR.accentDeep})`,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "22px",
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {(profile?.name ?? userEmail ?? "A")[0].toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "16px", fontWeight: 700 }}>{profile?.name ?? "—"}</div>
            <div style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "2px" }}>
              {userEmail}
            </div>
          </div>
          <span
            style={{
              fontSize: "11px",
              color: COLOR.accent,
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            Edit →
          </span>
        </Card>
      </div>

      <BottomSheet
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit profile"
      >
        <ProfileForm
          initial={{
            name: profile?.name ?? null,
            age: profile?.age ?? null,
            height_cm: profile?.height_cm ?? null,
            goal: profile?.goal ?? null,
            system_prompt: profile?.system_prompt ?? null,
          }}
          onSave={() => setEditOpen(false)}
        />
      </BottomSheet>

      <SectionLabel>Coaching plan</SectionLabel>
      <div style={{ padding: "0 8px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <AthleteProfilePanel userId={userId} />
        <GoalSection />
        <NutritionTargetsSection userId={userId} date={today} />
        {showLabCard && <LabPromptCard userId={userId} />}
      </div>

      <SectionLabel>Connected sources</SectionLabel>
      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: "6px" }}>
        <ConnectionsPanel
          whoopConnected={!!whoopTokens}
          whoopUpdatedAt={whoopTokens?.updated_at ?? null}
          withingsConnected={!!withingsTokens}
          withingsUpdatedAt={withingsTokens?.updated_at ?? null}
        />
      </div>

      <SectionLabel>Baselines</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <BaselinesPanel logs={logs as DailyLog[]} />
      </div>

      <SectionLabel>Ingest tokens</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <IngestPanel
          userId={userId}
          tokenPrefix={ingestToken?.token_prefix ?? null}
          createdAt={ingestToken?.created_at ?? null}
          lastUsedAt={ingestToken?.last_used_at ?? null}
          lastUsedSource={ingestToken?.last_used_source ?? null}
          appUrl={appUrl}
        />
      </div>

      <SectionLabel>Coaches</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <Card variant="compact" style={{ padding: 0 }}>
          <StatusRow label="View coach prompts" href="/profile/coach-prompts" />
        </Card>
      </div>

      <SectionLabel>Account</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <Card variant="compact" style={{ padding: 0 }}>
          <StatusRow label="Privacy &amp; data" href="/privacy" />
          <form action="/api/auth/signout" method="post">
            <StatusRow label="Sign out" danger />
          </form>
        </Card>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: "11px",
        color: COLOR.textMuted,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "10px 16px 6px",
      }}
    >
      {children}
    </div>
  );
}
