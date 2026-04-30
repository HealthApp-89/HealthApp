import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { LogForm } from "@/components/log/LogForm";
import type { DailyLog } from "@/lib/data/types";

export const dynamic = "force-dynamic";

export default async function LogPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const today = new Date().toISOString().slice(0, 10);

  const [{ data: profile }, { data: tokens }, { data: log }, { data: checkin }] = await Promise.all([
    supabase.from("profiles").select("name").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select("*")
      .eq("user_id", user.id)
      .eq("date", today)
      .maybeSingle(),
    supabase
      .from("checkins")
      .select("readiness, energy_label, mood, soreness, feel_notes")
      .eq("user_id", user.id)
      .eq("date", today)
      .maybeSingle(),
  ]);

  return (
    <main>
      <Header
        email={user.email ?? null}
        name={profile?.name ?? null}
        score={null}
        whoopSyncedAt={tokens?.updated_at ?? null}
      />
      <div className="px-4 pt-3.5 max-w-3xl mx-auto">
        <LogForm
          date={today}
          initialLog={(log ?? null) as Partial<DailyLog> | null}
          initialCheckin={
            checkin
              ? {
                  readiness: checkin.readiness,
                  energy_label: checkin.energy_label,
                  mood: checkin.mood,
                  soreness: checkin.soreness,
                  feel_notes: checkin.feel_notes,
                }
              : null
          }
        />
      </div>
    </main>
  );
}
