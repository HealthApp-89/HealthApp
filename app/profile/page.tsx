import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { BaselinesPanel } from "@/components/profile/BaselinesPanel";
import { ConnectionsPanel } from "@/components/profile/ConnectionsPanel";
import { IngestPanel } from "@/components/profile/IngestPanel";
import type { DailyLog } from "@/lib/data/types";

export const dynamic = "force-dynamic";

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
      .select("name, age, height_cm, goal")
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
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={null}
        whoopSyncedAt={whoopTokens?.updated_at ?? null}
      />
      <div className="px-4 pt-3.5 max-w-3xl mx-auto flex flex-col gap-3.5">
        <Card>
          <SectionLabel>⬡ ATHLETE PROFILE</SectionLabel>
          <ProfileForm
            initial={{
              name: profile?.name ?? null,
              age: profile?.age ?? null,
              height_cm: profile?.height_cm ?? null,
              goal: profile?.goal ?? null,
            }}
          />
          <div className="mt-4 pt-3 border-t border-white/[0.05] text-[10px] text-white/30 flex justify-between">
            <span>Email · {user.email}</span>
            {whoopTokens?.whoop_user_id && <span>WHOOP ID · {whoopTokens.whoop_user_id}</span>}
          </div>
        </Card>

        <ConnectionsPanel
          whoopConnected={!!whoopTokens}
          whoopUpdatedAt={whoopTokens?.updated_at ?? null}
          withingsConnected={!!withingsTokens}
          withingsUpdatedAt={withingsTokens?.updated_at ?? null}
        />

        <IngestPanel
          tokenPrefix={ingestToken?.token_prefix ?? null}
          createdAt={ingestToken?.created_at ?? null}
          lastUsedAt={ingestToken?.last_used_at ?? null}
          lastUsedSource={ingestToken?.last_used_source ?? null}
          appUrl={appUrl}
        />

        <BaselinesPanel logs={logs} />

        <form action="/api/auth/signout" method="post" className="flex justify-end pt-2">
          <button className="text-[10px] text-white/30 hover:text-white" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
