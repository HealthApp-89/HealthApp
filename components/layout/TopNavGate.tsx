// components/layout/TopNavGate.tsx
import { TopNav } from "./TopNav";

/**
 * Server wrapper for the desktop top nav. Previously fetched the
 * authenticated user to thread `userId` into TopNav for an in-header
 * MorningTrigger / ChatPanel — those have moved to <Fab> (single owner)
 * because the desktop header is `hidden md:flex`, which made any
 * ChatPanel rendered as a descendant invisible on mobile portrait.
 *
 * Kept as a thin server boundary in case TopNav grows server-side data
 * needs again; cheap to delete if it stays trivial.
 */
export function TopNavGate() {
  return <TopNav />;
}
