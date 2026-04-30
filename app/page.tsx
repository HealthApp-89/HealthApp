import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: tokens }, { data: latest }] = await Promise.all([
    supabase.from("whoop_tokens").select("updated_at, whoop_user_id").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("daily_logs")
      .select("date, hrv, resting_hr, recovery, sleep_score, sleep_hours, strain")
      .eq("user_id", user.id)
      .order("date", { ascending: false })
      .limit(7),
  ]);

  const whoopConnected = !!tokens;

  return (
    <main className="min-h-screen p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <header className="flex items-center justify-between mb-8">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-white/30">APEX HEALTH OS</div>
            <div className="text-sm text-white/50 mt-1 font-mono">{user.email}</div>
          </div>
          <form action="/api/auth/signout" method="post">
            <button className="text-xs text-white/50 hover:text-white" type="submit">Sign out</button>
          </form>
        </header>

        <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-6 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">WHOOP</h2>
            <span className={`text-[10px] uppercase tracking-[0.1em] px-2 py-1 rounded-full ${whoopConnected ? "bg-emerald-300/15 text-emerald-300" : "bg-white/10 text-white/50"}`}>
              {whoopConnected ? "Connected" : "Not connected"}
            </span>
          </div>
          {whoopConnected ? (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-white/50">
                Tokens stored {tokens && new Date(tokens.updated_at).toLocaleString()}
              </span>
              <form action="/api/whoop/sync" method="get" className="inline">
                <button className="text-xs px-3 py-1.5 rounded-lg bg-emerald-300/20 border border-emerald-300/40 text-emerald-300">
                  Sync now
                </button>
              </form>
            </div>
          ) : (
            <Link
              href="/api/whoop/auth"
              className="inline-block text-sm px-4 py-2 rounded-xl bg-emerald-300/20 border border-emerald-300/40 text-emerald-300"
            >
              Connect WHOOP
            </Link>
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-6">
          <h2 className="font-semibold mb-4">Recent days</h2>
          {latest && latest.length > 0 ? (
            <div className="font-mono text-sm">
              <div className="grid grid-cols-6 gap-2 text-[10px] uppercase tracking-wider text-white/40 mb-2">
                <span>Date</span><span>HRV</span><span>RHR</span><span>Recov</span><span>Sleep</span><span>Strain</span>
              </div>
              {latest.map((l) => (
                <div key={l.date} className="grid grid-cols-6 gap-2 py-1.5 border-t border-white/5">
                  <span className="text-white/70">{l.date}</span>
                  <span>{l.hrv ?? "—"}</span>
                  <span>{l.resting_hr ?? "—"}</span>
                  <span>{l.recovery ?? "—"}</span>
                  <span>{l.sleep_score ?? "—"}</span>
                  <span>{l.strain ?? "—"}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/40">
              No data yet. Connect WHOOP and click <em>Sync now</em>, or wait for the daily cron.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
