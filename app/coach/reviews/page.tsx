import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CoachCard } from "@/components/coach/CoachCard";
import { COLOR } from "@/lib/ui/theme";
import type { WeeklyReviewPayload } from "@/lib/data/types";

export const revalidate = 60;

function formatWeekStart(weekStart: string): string {
  return new Date(`${weekStart}T12:00:00Z`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function CoachReviewsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: reviews, error } = await supabase
    .from("weekly_reviews")
    .select("week_start, status, version, payload")
    .eq("user_id", user.id)
    .order("week_start", { ascending: false })
    .order("version", { ascending: false });

  if (error) throw error;

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 14px" }}>
        Weekly reviews
      </h1>
      {(reviews ?? []).length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: COLOR.textMuted,
            fontSize: 13,
          }}
        >
          No reviews yet. Your first weekly review will land on Sunday evening.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(reviews ?? []).map((r) => {
            const payload = r.payload as WeeklyReviewPayload | null;
            const goalText = payload?.header?.block_goal_text;
            const title = goalText && goalText.trim().length > 0
              ? goalText
              : `Week of ${formatWeekStart(r.week_start)}`;
            const weekN = payload?.header?.week_n;
            const totalWeeks = payload?.header?.total_weeks;
            const onPace = payload?.header?.on_pace;
            const paceLabel =
              onPace === true ? "On pace" : onPace === false ? "Off pace" : null;
            return (
              <Link
                key={`${r.week_start}-${r.version}`}
                href={`/coach/weeks/${r.week_start}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <CoachCard tone="accent">
                  <CoachCard.Eyebrow>
                    Week of {formatWeekStart(r.week_start)}
                    {typeof weekN === "number" && typeof totalWeeks === "number" && weekN > 0
                      ? ` · W${weekN}/${totalWeeks}`
                      : ""}
                  </CoachCard.Eyebrow>
                  <CoachCard.Title>{title}</CoachCard.Title>
                  <CoachCard.Body>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span style={{ fontSize: 12, color: COLOR.textMuted }}>
                        {r.status} · v{r.version}
                        {paceLabel ? ` · ${paceLabel}` : ""}
                      </span>
                      <ChevronRight size={18} color={COLOR.textMuted} aria-hidden="true" />
                    </div>
                  </CoachCard.Body>
                </CoachCard>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
