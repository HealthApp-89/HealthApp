// components/chat/ChatBubbleGate.tsx
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ChatBubble } from "./ChatBubble";

/**
 * Server component: only renders the bubble when the user is authenticated.
 * Avoids mounting unauthenticated components on /login or /privacy that would
 * otherwise fire chat API requests.
 */
export async function ChatBubbleGate() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return <ChatBubble />;
}
