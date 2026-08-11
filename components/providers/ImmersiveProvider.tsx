// components/providers/ImmersiveProvider.tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * "A full-screen surface owns the screen right now — everything behind it should
 * stand down."
 *
 * The workout logger covers the viewport (`fixed inset-0 bg-black z-40`) but it
 * is rendered as an ordinary child of whatever page opened it, so the page under
 * it stays mounted, keeps its effects running, and keeps competing for the one
 * main thread the set timer needs. On `/strength` that meant the logger sheet
 * sharing a thread with Carter's `ChatPanel` and its full message array — see
 * lib/chat/load-older.ts for what that cost when the panel misbehaved, and
 * memory `reference_logger_shares_thread_with_chat` for the measurements.
 *
 * Covering something is not the same as unmounting it. This context makes the
 * relationship explicit so background surfaces can genuinely go away while the
 * athlete is mid-set.
 *
 * A COUNTER, not a boolean: two immersive surfaces can legitimately overlap for
 * a frame (a logger closing while an edit-mode logger opens), and with a boolean
 * the first unmount would clear the flag while the second surface is still up.
 */
const ImmersiveContext = createContext<{
  count: number;
  acquire: () => void;
  release: () => void;
}>({ count: 0, acquire: () => {}, release: () => {} });

export function ImmersiveProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const acquire = useCallback(() => setCount((c) => c + 1), []);
  const release = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);
  const value = useMemo(() => ({ count, acquire, release }), [count, acquire, release]);
  return <ImmersiveContext.Provider value={value}>{children}</ImmersiveContext.Provider>;
}

/**
 * Declare THIS component a full-screen surface for as long as it is mounted.
 *
 * Call it unconditionally at the top of the surface's body — it is a hook, and
 * this repo has no render-test harness, so a hook that runs on only some renders
 * (React error #310) reaches production. See memory
 * `reference_no_render_test_harness`.
 */
export function useImmersiveSurface() {
  const { acquire, release } = useContext(ImmersiveContext);
  useEffect(() => {
    acquire();
    return release;
  }, [acquire, release]);
}

/**
 * True while any full-screen surface is up.
 *
 * Callers must use it to skip RENDERING the heavy child, not to early-return
 * from inside it: the point is to unmount the subtree — its queries, effects,
 * intervals and retained state — not merely to hide it. An early return inside
 * the child would also change that child's hook count between renders.
 */
export function useIsImmersive(): boolean {
  return useContext(ImmersiveContext).count > 0;
}
