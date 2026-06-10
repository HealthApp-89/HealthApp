import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchProfileServer } from "@/lib/query/fetchers/profile";
import { fetchDailyLogsServer } from "@/lib/query/fetchers/dailyLogs";
import { fetchRecentE1RMsServer } from "@/lib/query/fetchers/recentE1RMs";
import {
  fetchActiveProfileServer,
  fetchDraftProfileServer,
  fetchProfileByIdServer,
} from "@/lib/query/fetchers/athleteProfile";
import { OnboardingWizard, type WizardPrefill } from "@/components/onboarding/OnboardingWizard";
import { todayInUserTz } from "@/lib/time";
import { getUserTimezone } from "@/lib/time/get-user-tz";

export const dynamic = "force-dynamic";

export default async function OnboardingPage(props: {
  searchParams: Promise<{ revise?: string }>;
}) {
  const { revise } = await props.searchParams;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tz = await getUserTimezone(user.id);
  const today = todayInUserTz(new Date(), tz);

  // 30-day window for nutrition / sleep avgs.
  const thirtyAgo = new Date(`${today}T00:00:00Z`);
  thirtyAgo.setUTCDate(thirtyAgo.getUTCDate() - 30);
  const fromDate = thirtyAgo.toISOString().slice(0, 10);

  const [profile, recentLogs, recentE1RMs, existingDraft, activeDoc, reviseDoc] =
    await Promise.all([
      fetchProfileServer(supabase, user.id),
      fetchDailyLogsServer(supabase, user.id, fromDate, today),
      fetchRecentE1RMsServer(supabase, user.id, today),
      fetchDraftProfileServer(supabase, user.id),
      fetchActiveProfileServer(supabase, user.id),
      revise
        ? fetchProfileByIdServer(supabase, user.id, revise)
        : Promise.resolve(null),
    ]);

  // Determine version + prior intake for pre-fill.
  // Priority: existing draft (resume) wins; else if ?revise=<id> matches a non-discarded version,
  // use that as priorIntake; else if active exists, use active as priorIntake (revision flow).
  const priorIntake =
    existingDraft?.intake_payload ??
    reviseDoc?.intake_payload ??
    activeDoc?.intake_payload ??
    null;

  // next_version = max(version) + 1; supersedes_version = active.version (if any)
  // Quick recompute (no extra round-trip; we have the data)
  let nextVersion: number;
  if (existingDraft) {
    nextVersion = existingDraft.version;
  } else {
    const { data: maxRow } = await supabase
      .from("athlete_profile_documents")
      .select("version")
      .eq("user_id", user.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    nextVersion = ((maxRow?.version as number | undefined) ?? 0) + 1;
  }

  const supersedesVersion = activeDoc?.version ?? null;

  const prefill: WizardPrefill = {
    profile: profile
      ? {
          name: profile.name ?? null,
          age: profile.age ?? null,
          height_cm: profile.height_cm ?? null,
        }
      : null,
    recentLogs,
    recentE1RMs,
    priorIntake,
    existingDraft,
    nextVersion,
    supersedesVersion,
  };

  return (
    <main style={{ minHeight: "100dvh" }}>
      <OnboardingWizard prefill={prefill} userId={user.id} />
    </main>
  );
}
