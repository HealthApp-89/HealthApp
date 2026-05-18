# Morning intake trigger wiring — Design + Plan

**Date:** 2026-05-18
**Status:** Draft — awaiting approval
**Owner:** single-user app, Abdelouahed
**Scope:** Small integration fix. Not a sub-project. Single PR.

## Problem

Three pieces of the morning intake flow were built but never connected:

1. **`MorningTrigger`** ([components/morning/MorningTrigger.tsx](../../../components/morning/MorningTrigger.tsx)) — defined as an invisible client component that queries today/yesterday checkins, calls `decideIntakeAction()`, and fires `onShouldOpen()` when the user needs to start their daily check-in. **Never imported anywhere.**
2. **Embedded `ChatPanel`** — the panel mounted at [CoachClient.tsx:337](../../../components/coach/CoachClient.tsx#L337) hardcodes `initialKind="coach"`. The "Coach / Morning" mode toggle that exists at [ChatPanel.tsx:1166](../../../components/chat/ChatPanel.tsx#L1166) is only rendered inside the *floating* panel return path, not the embedded one. So the user has zero clickable affordance on `/coach` to enter morning intake mode.
3. **`TodayAnchor` "Morning check-in pending" pill** ([components/chat/TodayAnchor.tsx](../../../components/chat/TodayAnchor.tsx)) — was an `<a href="#">` (no-op). Already converted to a non-interactive `<div>` in the same PR as this spec; needs to become a real entry point once #1 and #2 land.

The API routes (`/api/chat/morning/intake`, `/api/chat/morning/recommendation`, `/api/chat/morning/retry-brief`) and the state machine (`pending → awaiting_feel → awaiting_whoop → assembling_brief → brief_delivered`) all work end-to-end — verified by reading the route handlers. The gap is purely the client-side entry point.

## Goals

1. **When the user lands on `/coach` and today's intake hasn't started, the intake auto-opens** — exactly the contract `MorningTrigger` was designed for. Suppression-per-session already implemented in `MorningTrigger` (sessionStorage `morningHandled-<YYYY-MM-DD>`).
2. **The "Morning check-in pending" pill becomes a one-tap entry point** to the intake, for the second-or-later visit of the day when suppression is active.
3. **Manual escape hatch on `/coach`** — user can switch between Coach and Morning kinds in the embedded panel the same way they can in the floating panel, so dismissing the auto-open doesn't strand them.
4. **State survives refresh** — if the user is mid-intake and refreshes, `/coach` should remount in morning_intake kind. Implies URL is the source of truth, not internal `useState`.

## Non-Goals

- **OS push / PWA badge / notifications.** Out of scope; user discovers via app open.
- **Refactor of `ChatPanel`'s internal `currentMode` state machine.** It already works correctly when `initialKind` changes via remount. No need to make it controlled.
- **Persistence of "I dismissed the morning intake for today" beyond session.** The `MorningTrigger` suppression key is `sessionStorage`-scoped on purpose — a fresh browser session should re-prompt because the user might have ignored the first tab.
- **Re-enabling the floating `ChatPanel` overlay path.** The embedded surface on `/coach` is the only entry point V3 ships with; the overlay return-path in `ChatPanel.tsx` is currently dead code in this app (no FAB mounts it). Don't fix that here; just stop treating its mode chips as the only way to switch kinds.

## Design — chosen approach

**URL-driven kind: `/coach?kind=morning_intake`** (mirrors the existing `?mode=plan_week`, `?retry=brief`, `?view=tools` patterns).

### Why URL over lifted state

| Option | URL `?kind=` (chosen) | Lifted state + prop | Imperative ref |
|---|---|---|---|
| Refresh survives mid-intake | ✅ | ❌ | ❌ |
| Deep-linkable from MorningTrigger | ✅ trivial | ✅ via callback | ✅ via callback |
| Matches existing patterns (`?mode=`, `?retry=`, `?view=`) | ✅ | ➖ | ❌ |
| ChatPanel API change | minimal (rename `initialKind` prop, use `key={kind}` for clean remount) | medium (controlled state, lift `currentMode`) | high (forwardRef + imperativeHandle) |
| Browser back/forward works | ✅ | ❌ | ❌ |

The URL approach also makes the eventual MorningTrigger callback dead simple: it's just `router.replace("/coach?kind=morning_intake")`, no prop-drilling or state-lifting required.

### Force-remount strategy

`ChatPanel` reads `initialKind` as an initial value of `useState` — internal state diverges from the prop after mount. The clean fix is `key={kind}` on the `ChatPanel` element: when `kind` changes via URL, React unmounts and remounts the panel, which re-runs the `useState(initialKind)` initialization with the new value. The history fetch effect runs fresh on remount, which is exactly the desired behavior when switching kinds (the history filter is per-kind anyway).

The cost is a brief flash of "loading…" — acceptable since this only fires on a kind transition (rare event), not on every chat interaction.

### Mode-chip visibility in embedded mode

Move the `Coach / Morning` chip cluster out of the floating-only return block into a shared header subcomponent that both return paths render. Tapping a chip calls `router.replace("/coach?kind=" + m)` instead of `setCurrentMode(m)` — URL drives state, not vice versa.

### MorningTrigger mount site

Mount once at the top of `CoachClient`'s return tree, regardless of `activeView`. Reasoning: the user might land on `/coach?view=tools`, and we still want the intake to prompt. The component is invisible and side-effect-only; mounting it everywhere costs ~zero.

Pass `onShouldOpen={() => router.replace("/coach?kind=morning_intake&view=today")}` so the auto-open also switches the user's tab from Tools/Recent into the chat view where the intake actually renders.

### TodayAnchor pending-pill restoration

Re-add interactivity to the pending pill, but as a proper Link to `/coach?kind=morning_intake` — not a no-op href. Keep the visual change (no chevron, soft styling) so it's not pushy. The pill only appears when intake state is in the awaiting/missing band, so the link is always valid in that context.

## Files to change

| File | Change |
|---|---|
| [components/coach/CoachClient.tsx](../../../components/coach/CoachClient.tsx) | (a) Read `?kind` search param, validate against `"coach" \| "morning_intake"`, default `"coach"`. (b) Pass to `ChatPanel` as `initialKind={kind}` + `key={kind}`. (c) Mount `<MorningTrigger userId={userId} onShouldOpen={...}/>` at top of return tree. (d) Pass `onStartIntake` callback to `TodayAnchor`. |
| [components/chat/ChatPanel.tsx](../../../components/chat/ChatPanel.tsx) | (a) Extract Coach/Morning chip cluster into a small `KindChips` component (or inline render in both return paths). (b) Switch chip `onClick` from `setCurrentMode(m)` to `router.replace("/coach?kind=" + m)`. (c) Render `KindChips` in the embedded return branch too. |
| [components/chat/TodayAnchor.tsx](../../../components/chat/TodayAnchor.tsx) | Accept an optional `onStartIntake?: () => void` prop. In the "Morning check-in pending" branch, if the callback is provided, render as a `<button>` (or `<Link>`); else keep the current non-interactive `<div>`. |
| [components/morning/MorningTrigger.tsx](../../../components/morning/MorningTrigger.tsx) | No change to the component itself — it already does the right thing. Just gets imported. |

No DB migration. No new API route. No new env var. No new dependency.

## Implementation steps

1. **`ChatPanel` chip refactor** (no behavior change yet)
   - Extract the `["coach", "morning_intake"]` chip-map JSX block into a local function component `KindChips({ current })` that reads from props and calls `router.replace`.
   - Render in both the floating return (replacing the existing chip block) and the embedded return (new — pin to the top of the chat surface, above the optional `ShowEarlierPill`).
   - Remove the now-unused `setCurrentMode` calls from the chip `onClick`s. Internal state still derives from `initialKind` on mount; URL is the source of truth.
   - Verify: typecheck passes; behavior unchanged when no kind param in URL.

2. **`CoachClient` kind wiring**
   - Add `function isKind(v: string | null): v is "coach" | "morning_intake"`.
   - Read `const kind = isKind(search.get("kind")) ? search.get("kind")! : "coach"`.
   - Update the `<ChatPanel>` element: `initialKind={kind} key={kind}`.
   - Verify: visiting `/coach?kind=morning_intake` mounts the panel in morning intake kind and the auto-fire effect at [ChatPanel.tsx:737](../../../components/chat/ChatPanel.tsx#L737) starts the intake. Visiting `/coach` (no param) stays in coach kind. Tapping the chip cluster swaps the URL without a full navigation.

3. **`MorningTrigger` mount**
   - Import `MorningTrigger` in `CoachClient`.
   - Mount once at the top of the return tree: `<MorningTrigger userId={userId} onShouldOpen={() => router.replace(\`/coach?kind=morning_intake&view=today\`)} />`.
   - Verify: in a fresh session with no checkin row for today, opening `/coach` auto-redirects to `?kind=morning_intake&view=today` and starts the intake. In an already-handled session (sessionStorage `morningHandled-YYYY-MM-DD` set), no redirect.

4. **`TodayAnchor` pill restoration**
   - Add `onStartIntake?: () => void` to the props type.
   - In the `!brief || brief.sessionLabel == null` branch, if `onStartIntake` is set, render a `<button onClick={onStartIntake}>` with subtle hover styling (still no chevron — keep the soft "informational with affordance" tone). Else render the existing non-interactive `<div>`.
   - In `CoachClient`, pass `onStartIntake={() => router.replace("/coach?kind=morning_intake&view=today")}` to `TodayAnchor`.
   - Verify: tapping the pill switches the panel into morning intake kind.

5. **URL cleanup on intake completion** (small polish)
   - When `intakeState` transitions to `"brief_delivered"`, strip `?kind=morning_intake` from the URL so a refresh doesn't re-mount in intake kind.
   - Implement in `CoachClient` as a `useEffect` watching `intakeState`. Mirrors the existing `?retry=brief` cleanup at [CoachClient.tsx:89-94](../../../components/coach/CoachClient.tsx#L89-L94).

6. **Manual verification**
   - Cold-load `/coach` with no checkin row → MorningTrigger fires → URL becomes `?kind=morning_intake&view=today` → intake starts.
   - Cold-load `/coach` with intake in `awaiting_whoop` → URL stays as-is → pending pill rendered → tap pill → URL becomes `?kind=morning_intake&view=today` → intake resumes from awaiting_whoop.
   - Cold-load `/coach` with `brief_delivered` → MorningTrigger sees `skip` decision → no redirect → happy-path TodayAnchor card renders.
   - Refresh mid-intake (state `awaiting_feel`) → page re-mounts in morning_intake kind → continues from current question.
   - Manual chip toggle from Morning back to Coach → URL becomes `?kind=coach&view=today` → ChatPanel remounts in coach kind → coach history loads.

## Risks

- **Remount flash.** Switching kinds rebuilds the chat state from scratch. Mitigated by the `dynamic({ ssr: false, loading: ... })` import already in place; the loading state is a small text fallback. Acceptable for a kind transition (low-frequency).
- **MorningTrigger fires twice in React strict mode dev.** The component already guards via `sessionStorage` (set before `onShouldOpen`), so the second invocation reads the suppression key and bails. Production runs the effect once anyway.
- **Race between MorningTrigger redirect and a user clicking a chip.** Both write the URL via `router.replace`. Last-write-wins is the correct semantic here — the user's manual choice should override the automatic redirect. The `morningHandled-<day>` suppression key gets set when the redirect fires, so even if the user immediately switches back to coach, MorningTrigger won't re-fire that session.

## Rollback

Single-PR change with no DB writes. Rollback is a `git revert`.

## Follow-ons (deferred, not in this PR)

- **Auto-strip `?view=tools` style URL params on first user interaction** so the URL stays clean. Currently `?view=tools` persists indefinitely; not specific to this work.
- **Persist "dismissed for today" across browser sessions** if the user explicitly closes the auto-opened intake. Today, `MorningTrigger` only suppresses for the current `sessionStorage` window. If the user ignores the prompt and closes the tab, the next visit re-prompts. Probably fine; revisit if it gets annoying.
- **PWA installability + push.** Out of scope.
