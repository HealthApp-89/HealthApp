import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { LogForm } from "@/components/log/LogForm";
import { WeekStrip } from "@/components/layout/WeekStrip";
import { MetricCard } from "@/components/charts/MetricCard";
import type { DailyLog } from "@/lib/data/types";
import { todayInUserTz, formatHeaderDate } from "@/lib/time";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function resolveDate(raw: string | string[] | undefined): string {
  const today = todayInUserTz();
  if (typeof raw !== "string" || !ISO_DATE.test(raw)) return today;
  // Disallow future dates — Garmin can't tell us what hasn't happened yet.
  return raw > today ? today : raw;
}

export default async function LogPage(props: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const sp = await props.searchParams;
  const date = resolveDate(sp.date);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: tokens }, { data: log }, { data: checkin }] = await Promise.all([
    supabase.from("profiles").select("name").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select("*")
      .eq("user_id", user.id)
      .eq("date", date)
      .maybeSingle(),
    supabase
      .from("checkins")
      .select("readiness, energy_label, mood, soreness, feel_notes")
      .eq("user_id", user.id)
      .eq("date", date)
      .maybeSingle(),
  ]);

  // Suppress unused-var lint for profile/tokens (kept for future use)
  void profile;
  void tokens;

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
            {formatHeaderDate()}
          </div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginTop: "2px",
              color: COLOR.textStrong,
            }}
          >
            Log
          </h1>
        </div>
      </div>

      <WeekStrip selected={date} today={todayInUserTz()} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "10px",
          padding: "0 8px 14px",
        }}
      >
        <MetricCard
          color={METRIC_COLOR.steps}
          icon="👣"
          label="Steps"
          value={log?.steps ?? null}
          compact
        />
        <MetricCard
          color={METRIC_COLOR.calories}
          icon="🍴"
          label="Calories"
          value={log?.calories ?? null}
          unit="kcal"
          compact
        />
      </div>

      <div style={{ padding: "0 8px" }}>
        <LogForm
          date={date}
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
    </div>
  );
}
