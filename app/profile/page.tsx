import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: tokens }] = await Promise.all([
    supabase.from("profiles").select("name, age, height_cm, goal").eq("user_id", user.id).maybeSingle(),
    supabase.from("whoop_tokens").select("updated_at").eq("user_id", user.id).maybeSingle(),
  ]);

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
          <SectionLabel>⬡ PROFILE</SectionLabel>
          <div className="flex flex-col gap-2 font-mono text-sm">
            <Row label="Email" value={user.email} />
            <Row label="Name" value={profile?.name} />
            <Row label="Age" value={profile?.age?.toString()} />
            <Row label="Height" value={profile?.height_cm ? `${profile.height_cm} cm` : null} />
            <Row label="Goal" value={profile?.goal} />
          </div>
        </Card>
        <p className="text-xs text-white/30">Editor coming in Stage 5.</p>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-t border-white/5 first:border-t-0">
      <span className="text-[10px] uppercase tracking-[0.08em] text-white/40 self-center">{label}</span>
      <span className="text-white/70 truncate">{value ?? "—"}</span>
    </div>
  );
}
