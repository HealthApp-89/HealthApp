import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { LogForm } from "@/components/log/LogForm";
import type { DailyLog } from "@/lib/data/types";
import { todayInUserTz } from "@/lib/time";

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
  let phase = "init";
  try {
    phase = "searchParams";
    const sp = await props.searchParams;
    phase = "resolveDate";
    const date = resolveDate(sp.date);

    phase = "createSupabaseServerClient";
    const supabase = await createSupabaseServerClient();
    phase = "getUser";
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    phase = "Promise.all-queries";
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

    phase = "render";
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
      </main>
    );
  } catch (e: unknown) {
    const err = e as { message?: string; digest?: string; stack?: string };
    if (err?.digest?.startsWith("NEXT_REDIRECT")) throw e;
    return (
      <pre style={{ padding: 16, fontSize: 12, whiteSpace: "pre-wrap", color: "#fff", background: "#000" }}>
        {`PHASE: ${phase}\nMESSAGE: ${err?.message ?? String(e)}\nSTACK: ${err?.stack ?? "no stack"}`}
      </pre>
    );
  }
}
