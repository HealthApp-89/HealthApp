import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { Card, SectionLabel } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

export default async function TrendsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: tokens }] = await Promise.all([
    supabase.from("profiles").select("name").eq("user_id", user.id).maybeSingle(),
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
      <div className="px-4 pt-3.5 max-w-3xl mx-auto">
        <Card>
          <SectionLabel>📈 TRENDS</SectionLabel>
          <p className="text-sm text-white/50 leading-relaxed">
            Body / Sleep / Training / Strength / Week-vs-Week panels coming in Stage 3.
          </p>
        </Card>
      </div>
    </main>
  );
}
