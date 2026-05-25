import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SessionDebriefView } from "@/components/coach/SessionDebriefView";
import { EditSessionButton } from "@/components/logger/EditSessionButton";
import { COLOR } from "@/lib/ui/theme";
import type { WorkoutDebriefPayload } from "@/lib/data/types";

export const dynamic = "force-dynamic";

export default async function SessionDebriefPage({
  params,
}: {
  params: Promise<{ workout_id: string }>;
}) {
  const { workout_id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: row, error } = await supabase
    .from("chat_messages")
    .select("ui")
    .eq("user_id", user.id)
    .eq("kind", "workout_debrief")
    .eq("ui->>workout_id", workout_id)
    .maybeSingle();

  const { data: workoutRow } = await supabase
    .from("workouts")
    .select("source")
    .eq("id", workout_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const eligible = workoutRow?.source === "logger";

  if (error) {
    return (
      <div style={{ padding: 24, color: COLOR.danger }}>
        Failed to load debrief: {error.message}
      </div>
    );
  }
  if (!row) {
    // Race condition: page opened before the async generator landed the chat
    // row. v1: static message; the user can refresh.
    return (
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: COLOR.textStrong }}>Carter is still reviewing this session…</div>
        <div style={{ fontSize: 12, color: COLOR.textMuted }}>
          Refresh in a few seconds. If nothing appears, the debrief job may have failed —
          re-trigger from the workout history.
        </div>
      </div>
    );
  }

  const payload = row.ui as WorkoutDebriefPayload;
  return (
    <div>
      <div style={{ padding: "12px 16px 0 16px", display: "flex", justifyContent: "flex-end" }}>
        <EditSessionButton workoutId={workout_id} eligible={eligible} />
      </div>
      <SessionDebriefView payload={payload} />
    </div>
  );
}
