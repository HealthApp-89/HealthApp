# Phase 2: Performance & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app feel fast and clear — cut chat first-token latency, smooth the workout logger on mobile, stream the weekly-review page progressively, fix the coach off-by-one data bug, and resolve UI ambiguities (readiness bands, session states, coach badges, WHOOP-term hints).

**Architecture:** This phase modifies EXISTING production code, not greenfield modules. Every performance task begins with a measurement/investigation step (profile before optimizing — never guess) and ends with a verification that the win is real. UI tasks are component-level edits verified visually + with the dev server. Where a regression gate is feasible (e.g. asserting parallel rather than serial fetch structure), add one; otherwise verification is profiling + manual exercise of the affected page, stated honestly.

**Tech Stack:** Next.js 15 App Router (Server Components + Suspense streaming), React 19, TanStack Query (client cache), Tailwind v4, Anthropic SDK streaming over SSE, vitest (added in Phase 1).

**Effort:** ~42 hours across 7 tasks.

## Global Constraints

- Number display: max 2 decimals, trailing zeros trimmed — always `fmtNum()` from [lib/ui/score.ts](../../../lib/ui/score.ts), never raw `.toFixed()`/`String(n)`.
- Timezone: never `new Date().toISOString().slice(0,10)` or `d.getHours()`; use `getUserTimezone`/`nowInUserTz`/`todayInUserTz` from [lib/time](../../../lib/time). `node scripts/audit-timezone-usage.mjs` is a gate.
- Client reads use the TanStack hybrid SSR-hydrate pattern; mutations stay on route handlers. Query keys come from [lib/query/keys.ts](../../../lib/query/keys.ts), never inlined.
- Verify with `npm run typecheck` (strict) and exercise affected pages on the dev server. No working linter — do not rely on `npm run lint`.
- Do NOT regress Phase 1: `npx vitest lib/coach/intelligence/` must stay green (142 tests) after any chat/snapshot change.
- The `/metrics?sub=log` tab is load-bearing — never remove it.
- Additive/behavior-preserving: these are perf + clarity changes. No feature removal, no coach-logic changes.

---

## File Structure

**Performance (existing files, modified):**
- `app/api/chat/messages/route.ts` — chat POST cold-path; parallelize the serial pre-stream tail (Tasks 1-2).
- `lib/coach/snapshot.ts` — `buildAthleteIntelligence` is called inside `buildSnapshot`; assess whether to parallelize it alongside the route's other reads (Task 2).
- `components/logger/**` — workout logger render perf: memo boundaries (Task 3).
- `app/coach/weeks/[week_start]/page.tsx` + its section components — granular Suspense (Task 4).

**Bug fix:**
- Coach data-freshness off-by-one — snapshot window / ephemeral header alignment (Task 5).

**UI clarity (existing components, modified):**
- `components/chat/**` — approval-chip mobile wrap + coach speaker badges (Tasks 6, 7).
- `components/morning/**` + readiness band rendering — band labels (Task 7).
- `components/strength/**` — session-state icons (Task 7).
- A small shared glossary-hint primitive — WHOOP-term tooltips (Task 7).

---

## Task 1: Profile the Chat Cold-Path (investigation, no behavior change)

**Goal:** Measure where time actually goes between POST `/api/chat/messages` and first SSE token, so Task 2 optimizes the real bottleneck instead of a guessed one.

**Files:**
- Modify: `app/api/chat/messages/route.ts` (add temporary timing instrumentation, then convert to a permanent lightweight log)
- Create: `docs/superpowers/notes/2026-06-26-chat-coldpath-profile.md` (findings)

**Interfaces:**
- Produces: a findings doc listing each pre-stream phase and its measured ms, naming the top 2-3 serial costs Task 2 will parallelize.

- [ ] **Step 1: Instrument the cold path with timing marks**

In the POST handler, capture `const t0 = performance.now()` at the start of the streaming branch (just before the `Promise.all` at ~line 560). Add `performance.now()` marks after: (a) the initial `Promise.all` (snapshot + profile + window + triggers + targets), (b) `buildSystemPrompt`, (c) `buildEphemeralHeader`, (d) the per-speaker context block (Peter dashboard / Carter context / Nora prof), (e) immediately before the `for await (const ev of runChatStream(...))` loop opens. Log each delta with `console.info("[chat-cold] phase=<name> ms=<delta>")`.

- [ ] **Step 2: Exercise the path on the dev server**

Run `npm run dev`. In the browser at `/coach`, send 3 messages each as Peter, Carter, and Nora (use the coach picker / @mentions). Capture the `[chat-cold]` logs from the dev-server terminal for all 9 turns.

- [ ] **Step 3: Write the findings doc**

Record per-phase ms (min/median/max across turns) per speaker in `docs/superpowers/notes/2026-06-26-chat-coldpath-profile.md`. Explicitly identify: which phases run serially that have no data dependency on each other (candidates for parallelization), and whether `buildSnapshot` (which now calls `buildAthleteIntelligence`'s 56d fetch) is a top cost. State the single biggest win.

- [ ] **Step 4: Convert instrumentation to a permanent guarded log**

Replace the temporary marks with a single summary log gated behind `if (process.env.CHAT_COLDPATH_PROFILE === "1")` so it stays available for future profiling without noise in normal runs. Keep the `t0`→first-token total behind the same guard.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/messages/route.ts docs/superpowers/notes/2026-06-26-chat-coldpath-profile.md
git commit -m "perf(chat): profile cold-path latency, gate behind CHAT_COLDPATH_PROFILE"
```

---

## Task 2: Parallelize the Chat Pre-Stream Tail

**Goal:** Collapse the serial `buildSystemPrompt → buildEphemeralHeader → per-speaker-context` tail (and any snapshot sub-fetch) into parallel work so the stream opens sooner. Target: cut first-token time meaningfully (the Task 1 doc sets the concrete number).

**Files:**
- Modify: `app/api/chat/messages/route.ts` (~lines 560-864)
- Possibly modify: `lib/coach/snapshot.ts` (if Task 1 shows `buildAthleteIntelligence` is a serial cost worth hoisting)

**Interfaces:**
- Consumes: Task 1's findings doc (which phases are independent).
- Produces: same SSE output, same first-token content — only ordering/concurrency changes.

- [ ] **Step 1: Identify independent phases from Task 1**

Read `docs/superpowers/notes/2026-06-26-chat-coldpath-profile.md`. List the pre-stream awaits and their true data dependencies. Known structure: `buildSystemPrompt` needs `profileRow.system_prompt` (already fetched in the first Promise.all) + the resolved speaker; `buildEphemeralHeader` needs tz + freshness (independent of system prompt); per-speaker context (Peter dashboard, Carter context, Nora prof) depends only on the resolved speaker + supabase — NOT on buildSystemPrompt or the ephemeral header.

- [ ] **Step 2: Restructure into a second parallel batch**

After the resolved speaker is known, run the independent pieces concurrently in one `Promise.all` instead of sequential awaits: `buildEphemeralHeader(...)`, the per-speaker context block (wrap the existing speaker-conditional logic in a single async thunk returning `{ peterContext, peterDashboardBlock, carterContext, noraProf }`), and `buildSystemPrompt(...)`. Preserve every existing `.catch()` fallback (e.g. `buildPeterContextBlock(...).catch(...)`, `getTodayTargets(...).catch(...)`) so one failure can't break the turn. Do not change what each function returns or how the values feed `runChatStream`.

- [ ] **Step 3: If Task 1 flagged the snapshot fetch — hoist it**

If `buildSnapshot` (via `buildAthleteIntelligence`) is a top serial cost: it already runs inside the first Promise.all, so it IS parallel with profile/window/triggers. Confirm it's not accidentally awaited twice. If `buildAthleteIntelligence` re-fetches data the route already has (workouts, daily_logs), note it in the findings but do NOT refactor the orchestrator's data ownership in this task — that's a deeper change; cap this task at the route-level parallelization. Record the observation for a possible follow-up.

- [ ] **Step 4: Verify output is byte-identical and faster**

With `CHAT_COLDPATH_PROFILE=1 npm run dev`, send the same 9 turns (3 each Peter/Carter/Nora). Confirm: (a) replies stream and read the same as before (spot-check content), (b) the cold-path total dropped vs Task 1's baseline, (c) no `.catch` fallback path silently swallowed (check no new warning logs). Record before/after totals in the findings doc.

- [ ] **Step 5: Guard against regression — assert structure**

Add a focused test `app/api/chat/__tests__/coldpath-structure.test.ts` (vitest) that imports the handler module is not practical (it's a route); instead, extract the second-batch assembly into a small pure helper `assembleTurnContext` if the diff is clean, and unit-test that it issues its independent pieces without inter-dependency (e.g. accepts pre-resolved inputs and returns the combined object). If extraction is too invasive, SKIP the test and document in the commit why (perf-only change verified by profiling). Do not force an artificial test.

- [ ] **Step 6: Confirm Phase 1 intelligence tests still green + typecheck**

```bash
npm run typecheck
npx vitest run lib/coach/intelligence/
```
Expected: typecheck clean, 142 intelligence tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/chat/messages/route.ts lib/coach/snapshot.ts docs/superpowers/notes/2026-06-26-chat-coldpath-profile.md
git commit -m "perf(chat): parallelize pre-stream context assembly to cut first-token latency"
```

---

## Task 3: Workout Logger Mobile Render Performance

**Goal:** Eliminate the sub-60fps jank during exercise reorder and the rest timer in the workout logger by adding memo boundaries so a single set/timer update doesn't re-render the whole session tree.

**Files:**
- Investigate then modify: `components/logger/**` (start at the top-level logger client; the rest timer + exercise rows are the hot components)

**Interfaces:**
- Produces: same logger behavior, fewer re-renders per interaction.

- [ ] **Step 1: Locate the logger component tree**

`grep -rn "RestTimer\|ExerciseRow\|useState\|setInterval\|requestAnimationFrame" components/logger/` to map the tree. Identify the component that owns the rest-timer tick (likely a `setInterval`/`rAF` driving a per-second state update) and the exercise-row list.

- [ ] **Step 2: Confirm the over-render with React DevTools Profiler (or a render counter)**

On `npm run dev`, open the logger (`/strength` → Start session, or the CTA on `/metrics?sub=strength`). Add a temporary `console.count("render:<Component>")` to the rest-timer component and an exercise row. Start the timer and reorder an exercise. Record which components re-render on each timer tick (the bug: the whole session/list re-renders every second).

- [ ] **Step 3: Isolate the timer's state**

Move the per-second ticking state into the smallest possible leaf component (the timer display itself) so the tick doesn't re-render parent lists. If the elapsed value is needed by siblings only at commit time (rest_seconds_actual), read it via a ref at commit rather than threading live state up.

- [ ] **Step 4: Add memo boundaries to exercise rows**

Wrap the exercise-row component in `React.memo` with a stable props contract (ensure callbacks passed in are `useCallback`-stable so memo isn't defeated). Verify the reorder interaction now only re-renders the moved rows, not every row.

- [ ] **Step 5: Verify 60fps + remove counters**

Re-run the timer + reorder on the dev server; confirm via the render counters that timer ticks no longer re-render the list and reorder only touches moved rows. Remove the temporary `console.count` calls. (Note honestly in the commit that fps is verified by render-count reduction + manual feel, not an automated benchmark.)

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add components/logger/
git commit -m "perf(logger): isolate rest-timer tick + memo exercise rows for 60fps mobile"
```

---

## Task 4: Weekly Review Page — Granular Suspense

**Goal:** Make `/coach/weeks/[week_start]` paint its first section in <1s by fetching sections in parallel and streaming each behind its own Suspense boundary instead of blocking the whole page on the slowest query.

**Files:**
- Modify: `app/coach/weeks/[week_start]/page.tsx` and the section components it renders (recap / prescription / trends / volume / targets)

**Interfaces:**
- Produces: same content, progressive paint (recap first, heavier sections stream in).

- [ ] **Step 1: Map the current fetch + render flow**

Read `app/coach/weeks/[week_start]/page.tsx`. Identify whether it awaits all data (workouts, daily_logs, weekly_reviews, training_weeks) before rendering any section, and whether sections are already split into components. Note which query is slowest (likely the trends/volume rollups).

- [ ] **Step 2: Split each section into an async Server Component**

For each of the 5 sections, create/confirm an async component that fetches only its own data and renders only itself. The page composes them. Sections with no cross-dependency must not share a single upstream await.

- [ ] **Step 3: Wrap heavier sections in Suspense with skeletons**

In the page, render the fast section(s) (recap) first, and wrap each heavier section in `<Suspense fallback={<SectionSkeleton/>}>`. Reuse the existing skeleton primitive ([components/ui/Skeleton.tsx](../../../components/ui/Skeleton.tsx)). The fast path gates first paint; heavy sections stream.

- [ ] **Step 4: Verify progressive paint**

On `npm run dev`, load `/coach/weeks/<a recent Monday week_start>`. Confirm the recap/header paints near-immediately and heavier sections fill in with skeletons first. Throttle network in DevTools to make the streaming visible. Confirm no hydration mismatch errors in console.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add app/coach/weeks/
git commit -m "perf(weekly-review): per-section Suspense + parallel fetch for sub-1s first paint"
```

---

## Task 5: Fix Coach Data-Freshness Off-By-One

**Goal:** Stop coaches citing "yesterday" data that hasn't synced or missing today's just-arrived rows — align the snapshot window / ephemeral header with actual data freshness so the coach sees what exists.

**Files:**
- Investigate: `lib/coach/snapshot.ts` (`buildEphemeralHeader`, the TODAY/YESTERDAY/freshness block) and the snapshot `since`/`until` window math in the chat route.

**Interfaces:**
- Produces: coach context where "today"/"yesterday" labels match the user's timezone day and the freshest available rows.

- [ ] **Step 1: Reproduce the off-by-one**

Read `buildEphemeralHeader` and `getSyncFreshness`/`formatFreshness` in `lib/coach/snapshot.ts`, plus how `since`/`todayIso`/`triggersSince` are computed in the chat route. Identify the specific boundary bug: is "today" computed in UTC somewhere while the user is UTC+4 (Dubai)? Is the snapshot window's upper bound excluding a row that arrived after midnight UTC but before local midnight? Check against the timezone rules in CLAUDE.md (profiles.timezone authoritative).

- [ ] **Step 2: Write a failing fixture test**

Add `lib/coach/__tests__/freshness.test.ts` constructing a scenario: user tz Asia/Dubai, a daily_logs row dated for the local "today", current UTC time still on the previous UTC date. Assert the ephemeral header labels that row as TODAY (not YESTERDAY) and includes it. Run it; confirm it fails against current logic.

- [ ] **Step 3: Fix the boundary math**

Correct the day computation to use `todayInUserTz`/`nowInUserTz` consistently for the TODAY/YESTERDAY split and the snapshot upper bound. Ensure no raw UTC `.slice(0,10)` remains (timezone audit gate).

- [ ] **Step 4: Verify**

```bash
npx vitest run lib/coach/__tests__/freshness.test.ts
node scripts/audit-timezone-usage.mjs
npx vitest run lib/coach/intelligence/
```
Expected: new test passes, audit ok, 142 intelligence tests still green.

- [ ] **Step 5: Commit**

```bash
git add lib/coach/snapshot.ts lib/coach/__tests__/freshness.test.ts
git commit -m "fix(coach): align TODAY/YESTERDAY + snapshot window to user timezone day"
```

---

## Task 6: Mobile Approval-Chip Overflow

**Goal:** Approve/Reject chips on coach proposal cards (propose_week_plan, propose_meal_log, etc.) must wrap/stack on narrow screens (≤375px) instead of overflowing the card edge.

**Files:**
- Investigate then modify: the chat approval-chip component in `components/chat/**` (search for where the `[approve:<token>]` chip / Approve+Reject buttons render).

**Interfaces:**
- Produces: same actions, responsive layout on phones.

- [ ] **Step 1: Locate the chip component**

`grep -rn "Approve\|approve:\|Reject\|approval" components/chat/` to find the button row. Confirm the current layout (likely a non-wrapping flex row with fixed-width buttons).

- [ ] **Step 2: Reproduce at 375px**

On `npm run dev`, open `/coach`, trigger a proposal (e.g. ask Carter to plan the week, or Nora to log a meal). In DevTools device mode at 375px width, confirm the chips overflow.

- [ ] **Step 3: Make the row responsive**

Change the button row to wrap (`flex-wrap`) and let buttons size to content / go full-width-stacked below a breakpoint (Tailwind `flex-col sm:flex-row` + `w-full sm:w-auto`). Keep the existing tap targets ≥44px tall for touch.

- [ ] **Step 4: Verify across widths**

Confirm at 320px, 375px, and desktop the chips are fully visible and tappable, and the approve/reject actions still fire correctly (tap Approve on a real proposal).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add components/chat/
git commit -m "fix(chat): wrap approval chips on narrow screens"
```

---

## Task 7: UI Clarity — Labels, Icons, Badges, Hints

**Goal:** Resolve the four ambiguity issues: readiness bands need labels, session states need distinct icons, coach speaker badges need to be distinctive, and WHOOP terms need hover/tap hints.

**Files:**
- Modify: readiness band rendering in `components/morning/**` (and any shared band component) + `lib/ui/colors.ts` if band labels live there
- Modify: session-state rendering in `components/strength/**`
- Modify: coach speaker badge in `components/chat/**`
- Create: a small shared `GlossaryHint` primitive in `components/ui/` + a terms map

**Interfaces:**
- Produces: clearer UI; no data or logic change.

- [ ] **Step 1: Readiness band labels**

Find where the green/yellow/red readiness band renders (morning brief + coach dashboard severity). Add a text label next to the color: `Good` / `Watch` / `Action` (or the existing band vocabulary if one exists — check `lib/ui/colors.ts` and `calcScore`). Keep color + label together; never color-only (accessibility).

- [ ] **Step 2: Session-state icons**

Find where session status (`as_planned` / `swapped` / `missed` / `rest`) renders on the strength tab. Give each a distinct icon + short text label (lucide-react is already a dependency) so the states are visually unambiguous. No state logic change — display only.

- [ ] **Step 3: Coach speaker badges**

Find the speaker chip (Peter/Carter/Nora/Remi) in the chat thread. Make each visually distinct (per-coach color + clear name), larger enough to scan when reading back. Use a single source-of-truth color map (extend `lib/coach/speakers.ts` if it holds speaker metadata, else a small map in the badge component).

- [ ] **Step 4: GlossaryHint primitive + WHOOP terms**

Create `components/ui/GlossaryHint.tsx` — a small tooltip/popover (tap on mobile, hover on desktop) wrapping a term. Create a terms map (`strain`, `recovery %`, `HRV`, `baseline status: establishing/partial/stable`, etc.) with one-line plain-English definitions. Apply it to the first occurrence of each term on the dashboard / morning brief. Keep it lightweight — no new heavy dependency.

- [ ] **Step 5: Verify all four on the dev server**

On `npm run dev`: confirm readiness bands show labels, session states are distinguishable, coach badges are distinct when scrolling chat history, and glossary hints open on tap/hover. Check mobile (375px) and desktop.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add components/ lib/ui/ lib/coach/speakers.ts
git commit -m "feat(ui): readiness band labels, session-state icons, coach badges, glossary hints"
```

---

## Specification Coverage Checklist

- [x] Chat streaming latency → Tasks 1 (profile) + 2 (parallelize)
- [x] Workout logger mobile smoothness → Task 3
- [x] Weekly review page Suspense → Task 4
- [x] Coach data freshness off-by-one → Task 5
- [x] Mobile input chip overflow → Task 6
- [x] UI clarity (band labels / session icons / coach badges / glossary) → Task 7
- [x] No Phase 1 regression (intelligence tests green) → enforced in Tasks 2 & 5
- [x] Timezone audit gate honored → Task 5

---

## Commit Summary (expected)

1. perf(chat): profile cold-path latency, gate behind CHAT_COLDPATH_PROFILE
2. perf(chat): parallelize pre-stream context assembly to cut first-token latency
3. perf(logger): isolate rest-timer tick + memo exercise rows for 60fps mobile
4. perf(weekly-review): per-section Suspense + parallel fetch for sub-1s first paint
5. fix(coach): align TODAY/YESTERDAY + snapshot window to user timezone day
6. fix(chat): wrap approval chips on narrow screens
7. feat(ui): readiness band labels, session-state icons, coach badges, glossary hints

---

## Notes for Execution

- Tasks 1→2 are sequential (2 consumes 1's findings). Tasks 3, 4, 5, 6, 7 are independent of each other and of 1-2 — they can run in any order.
- Verification for perf tasks is profiling + manual exercise, not pure unit tests — this is honest and expected for optimization of existing code. Add regression tests only where they're genuine (Task 5's timezone fixture is; a forced "render count" unit test is not).
- This phase must not touch coach logic or the Phase 1 intelligence modules. If a perf change appears to require changing `lib/coach/intelligence/**`, stop and flag it — that's out of scope.
