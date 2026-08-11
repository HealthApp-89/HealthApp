// lib/chat/load-older.ts
//
// The two decisions behind "load the next page of older chat messages".
//
// They live here, pure, rather than inside ChatPanel.tsx because this repo's
// vitest config is node-environment and scans `lib/**/__tests__` only — logic
// inside a .tsx is untestable by construction, and this particular logic
// shipped a runaway loop that no test could have caught where it was.
//
// THE BUG THIS EXISTS TO PREVENT (measured 2026-08-11, prod build, real data):
// ChatThread's top-sentinel IntersectionObserver paged from
// `messages[0].created_at` — but `messages` is the RENDER-SCOPED list (the
// coach lane shows today+yesterday, with everything older collapsed behind the
// "Show N earlier messages" pill). The fetched page therefore landed entirely
// outside the rendered window: the rendered list never changed, so the cursor
// never advanced, the server kept returning the same 50 rows, `hasMoreOlder`
// stayed true, the sentinel stayed on screen, and the observer re-armed each
// time `isLoadingOlder` flipped back to false.
//
// Result, with the athlete touching nothing: ~1.2 requests/second at 113.8 KB
// each. Over 200 seconds that is 26 MB pulled and an in-memory array grown from
// 694 to 11,744 messages (+50/round, all duplicates); the worst
// animation-frame gap climbed monotonically 0 → 237 ms as every render
// re-filtered the ever-longer array. On the athlete's phone that surfaced as
// the workout logger getting steadily slower through a session, the set timer
// freezing and then jumping, and STOP needing several taps to register — the
// logger was innocent; it was sharing a main thread with this.
//
// So the invariant is: PAGE FROM THE LIST THAT RECEIVES THE PAGE. A cursor read
// off a filtered view of that list cannot advance, and a loop whose termination
// condition it controls cannot terminate.

/** The minimum shape both helpers need. Structural so ChatMessage satisfies it
 *  without this module importing the chat types. */
type Identified = { id: string; created_at: string };

export type OlderPagePlan =
  | { run: true; before: string }
  | { run: false; reason: "scope_collapsed" | "no_more" | "empty" };

/**
 * Should the top sentinel fetch another page, and from which cursor?
 *
 * `oldestLoadedIso` MUST come from the full loaded thread, never from a
 * rendered/filtered view of it — see the module header.
 *
 * `scopeHidesMessages` is true while a render scope is holding messages back
 * (the coach lane's today+yesterday window, with the "Show N earlier" pill up).
 * Auto-paging is switched off then, deliberately: prepending cannot change what
 * is on screen, so reaching the top of the scrolled area is not the athlete
 * asking for more history — the pill is. Tapping it lifts the scope, at which
 * point rendered and loaded coincide and paging is meaningful again.
 */
export function planOlderPage(args: {
  oldestLoadedIso: string | null;
  hasMoreOlder: boolean;
  scopeHidesMessages: boolean;
}): OlderPagePlan {
  if (args.scopeHidesMessages) return { run: false, reason: "scope_collapsed" };
  if (!args.hasMoreOlder) return { run: false, reason: "no_more" };
  if (!args.oldestLoadedIso) return { run: false, reason: "empty" };
  return { run: true, before: args.oldestLoadedIso };
}

/**
 * Prepend a fetched page, keeping ids already held.
 *
 * The dedupe is the floor under the whole mechanism: whatever else goes wrong
 * with a cursor, a page that is entirely messages we already have must add
 * nothing, so the array cannot grow without bound. `added` lets the caller stop
 * asking — a page that contributes nothing new means there is nothing to page
 * to, whatever the server said about `hasMore`.
 *
 * Returns the SAME array when nothing was added, so downstream useMemo /
 * React.memo boundaries see an unchanged reference and the thread does not
 * re-render for a page that changed nothing.
 */
export function mergeOlder<T extends Identified>(
  existing: T[],
  older: T[],
): { messages: T[]; added: number } {
  if (older.length === 0) return { messages: existing, added: 0 };
  const held = new Set(existing.map((m) => m.id));
  const fresh = older.filter((m) => !held.has(m.id));
  if (fresh.length === 0) return { messages: existing, added: 0 };
  return { messages: [...fresh, ...existing], added: fresh.length };
}
