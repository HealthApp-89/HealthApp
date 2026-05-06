// components/layout/FabGate.tsx
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Fab } from "./Fab";

/**
 * Server component — gates the floating action button behind auth so
 * unauthenticated routes (/login, /privacy) don't render a "+" button
 * to nowhere. Replaces the per-bubble ChatBubbleGate that was here for
 * the same reason; coach is now reachable as a sheet item inside Fab.
 */
export async function FabGate() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return <Fab />;
}
