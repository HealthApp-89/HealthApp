// components/layout/TopNavGate.tsx
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TopNav } from "./TopNav";

/**
 * Server component — fetches the authenticated user once (alongside the
 * matching FabGate) and threads `userId` into TopNav so the chat panel
 * can use TanStack Query hooks (useCheckin, useDailyLogs) for the
 * morning intake flow. Unauthenticated routes (/login, /privacy) still
 * render TopNav with an empty userId string — the morning hooks are
 * gated by `mode === "morning_intake"` and never fire in coach mode.
 */
export async function TopNavGate() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return <TopNav userId={user?.id ?? ""} />;
}
