import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { BaselinesPanel } from "@/components/profile/BaselinesPanel";
import { BackfillButton } from "@/components/profile/BackfillButton";
import type { DailyLog } from "@/lib/data/types";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: tokens }, { data: logsRaw }] = await Promise.all([
    supabase
      .from("profiles")
      .select("name, age, height_cm, goal")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at, whoop_user_id").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select("date, hrv, resting_hr, recovery, sleep_score")
      .eq("user_id", user.id)
      .order("date", { ascending: true }),
  ]);

  const logs = (logsRaw ?? []) as DailyLog[];

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={null}
        whoopSyncedAt={tokens?.updated_at ?? null}
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
            {tokens?.whoop_user_id && <span>WHOOP ID · {tokens.whoop_user_id}</span>}
          </div>
        </Card>

        <BaselinesPanel logs={logs} />

        <Card>
          <SectionLabel>🔄 WHOOP HISTORY</SectionLabel>
          <p className="text-xs text-white/40 leading-relaxed mb-3">
            Pulls every recovery / cycle / sleep record back to 2 years ago and upserts into your
            daily logs. Manual fields (notes, weight, steps, calories) are preserved.
          </p>
          <BackfillButton />
        </Card>

        <form action="/api/auth/signout" method="post" className="flex justify-end pt-2">
          <button className="text-[10px] text-white/30 hover:text-white" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
