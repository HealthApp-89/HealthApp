import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubPillNav } from "@/components/layout/SubPillNav";
import { StrengthCoachClient } from "@/components/strength/StrengthCoachClient";
import { StrengthByDateClient } from "@/components/strength/StrengthByDateClient";
import { StrengthByMuscleClient } from "@/components/strength/StrengthByMuscleClient";
import { StrengthLogClient } from "@/components/strength/StrengthLogClient";
import { COLOR } from "@/lib/ui/theme";

const SUB_TABS = [
  { key: "coach", label: "Coach" },
  { key: "date", label: "By date" },
  { key: "by_muscle", label: "By muscle" },
  { key: "log", label: "Log" },
];

type Tab = "coach" | "date" | "by_muscle" | "log";

function parseTab(value: string | undefined): Tab {
  if (value === "date" || value === "by_muscle" || value === "log") return value;
  return "coach";
}

export default async function StrengthPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { tab: tabParam } = await searchParams;
  const tab = parseTab(tabParam);

  return (
    <div style={{ minHeight: "100dvh", paddingBottom: 100 }}>
      <header style={{ padding: "16px 16px 4px 16px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Strength</h1>
        <p style={{ fontSize: 12, color: COLOR.textMuted, margin: "2px 0 0 0" }}>
          Coach Carter
        </p>
      </header>
      <SubPillNav pills={SUB_TABS} paramName="tab" defaultKey="coach" />
      {tab === "coach" && <StrengthCoachClient userId={user.id} />}
      {tab === "date" && <StrengthByDateClient userId={user.id} />}
      {tab === "by_muscle" && <StrengthByMuscleClient userId={user.id} />}
      {tab === "log" && <StrengthLogClient userId={user.id} />}
    </div>
  );
}
