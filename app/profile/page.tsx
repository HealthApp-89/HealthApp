import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { StatusRow } from "@/components/ui/StatusRow";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { BaselinesPanel } from "@/components/profile/BaselinesPanel";
import { ConnectionsPanel } from "@/components/profile/ConnectionsPanel";
import { IngestPanel } from "@/components/profile/IngestPanel";
import { COLOR } from "@/lib/ui/theme";
import type { DailyLog } from "@/lib/data/types";

export const revalidate = 60;

export default async function ProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [
    { data: profile },
    { data: whoopTokens },
    { data: withingsTokens },
    { data: ingestToken },
    { data: logsRaw },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, age, height_cm, goal, system_prompt")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("whoop_tokens")
      .select("updated_at, whoop_user_id")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("withings_tokens")
      .select("updated_at, withings_user_id")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("ingest_tokens")
      .select("token_prefix, created_at, last_used_at, last_used_source")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("daily_logs")
      .select("date, hrv, resting_hr, recovery, sleep_score")
      .eq("user_id", user.id)
      .order("date", { ascending: true }),
  ]);

  const logs = (logsRaw ?? []) as DailyLog[];
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 12px 14px" }}>
        <div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Account &amp; integrations</div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.02em", marginTop: "2px" }}>Profile</h1>
        </div>
        <span style={{ fontSize: "18px", color: COLOR.textMuted }}>⚙</span>
      </div>

      {/* User card */}
      <div style={{ padding: "0 8px 14px" }}>
        <Card style={{ display: "flex", gap: "14px", alignItems: "center" }}>
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
            {(profile?.name ?? user.email ?? "A")[0].toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "16px", fontWeight: 700 }}>{profile?.name ?? "—"}</div>
            <div style={{ fontSize: "12px", color: COLOR.textMuted, marginTop: "2px" }}>{user.email}</div>
          </div>
          <span style={{ fontSize: "18px", color: COLOR.textFaint }}>›</span>
        </Card>
      </div>

      {/* Profile form (edit name) */}
      <SectionLabel>Profile details</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <ProfileForm
          initial={{
            name: profile?.name ?? null,
            age: profile?.age ?? null,
            height_cm: profile?.height_cm ?? null,
            goal: profile?.goal ?? null,
            system_prompt: profile?.system_prompt ?? null,
          }}
        />
      </div>

      {/* Connected sources */}
      <SectionLabel>Connected sources</SectionLabel>
      <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: "6px" }}>
        <ConnectionsPanel
          whoopConnected={!!whoopTokens}
          whoopUpdatedAt={whoopTokens?.updated_at ?? null}
          withingsConnected={!!withingsTokens}
          withingsUpdatedAt={withingsTokens?.updated_at ?? null}
        />
      </div>

      {/* Baselines */}
      <SectionLabel>Baselines</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <BaselinesPanel logs={logs} />
      </div>

      {/* Ingest tokens */}
      <SectionLabel>Ingest tokens</SectionLabel>
      <div style={{ padding: "0 8px 14px" }}>
        <IngestPanel
          tokenPrefix={ingestToken?.token_prefix ?? null}
          createdAt={ingestToken?.created_at ?? null}
          lastUsedAt={ingestToken?.last_used_at ?? null}
          lastUsedSource={ingestToken?.last_used_source ?? null}
          appUrl={appUrl}
        />
      </div>

      {/* Account */}
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
    <div style={{ fontSize: "11px", color: COLOR.textMuted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "10px 16px 6px" }}>
      {children}
    </div>
  );
}
