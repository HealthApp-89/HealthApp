# Chat Cold-Path Latency Profile

**Date:** 2026-06-26  
**Purpose:** Map where time goes between POST `/api/chat/messages` and first SSE token so Task 2 can parallelise the real bottleneck.

---

## Static dependency map

The cold path (from the streaming branch entry to the first call to `runChatStream`) has six sequential phases.

### Phase 0 — user timezone lookup
```
await getUserTimezone(user.id)          // 1 DB read: profiles.timezone
```
- Feeds all subsequent date-window computations (`since`, `triggersSince`, `workoutsSince`).
- Serial because everything else depends on `todayIso`.
- **Duration estimate:** 1 network round-trip to Supabase (~20–60 ms on Vercel).

### Phase 1 — parallel data fetch (`Promise.all`)
Six operations run concurrently:
1. `profiles.system_prompt` — 1 row read.
2. `buildSnapshot(…)` — itself runs a 7-way internal `Promise.all`:
   - `profiles` (name, goal, whoop_baselines)
   - `daily_logs` for last 14 days
   - `loadWorkouts(userId)` — all workouts (no date filter at this layer)
   - `athlete_profile_documents` (active, intake + plan)
   - `getTodayTargets(…)` (override → plan → intake chain)
   - `renderEnduranceBlocks(…)` (strava_tokens + endurance_activities + sum_endurance_for_day RPC)
   - **`buildAthleteIntelligence(…)`** — its own 6-way `Promise.all`:
     - `loadWorkouts(userId)` (full history — second call, independent from snapshot's)
     - `daily_logs` for last **56 days** (wider window, separate query)
     - `profiles.whoop_baselines`
     - `athlete_profile_documents.intake_payload`
     - `getTodayTargets(…)` (third call across the whole path)
     - `food_log_entries` for last **90 days**
3. Rolling chat window — last 30 `chat_messages` rows.
4. `daily_logs` for last 30 days (trigger computation).
5. `workouts` for last 14 days (trigger computation).
6. `getTodayTargets(…)` (second call at this level).

**Key observation — redundant fetches inside Phase 1:**  
`loadWorkouts` is called twice (once inside `buildSnapshot → buildAthleteIntelligence`, once inside `buildAthleteIntelligence` directly). `getTodayTargets` is called three times across the tree (snapshot, intelligence, and the outer `Promise.all`). `profiles` is read twice (snapshot + outer).  
All run inside the single `await Promise.all([…])`, so they overlap, but each still costs a round-trip.

**Duration estimate:** dominated by the slowest branch. `buildAthleteIntelligence`'s 90-day `food_log_entries` query and `loadWorkouts` (no date filter) are the likely tail. Estimate 150–400 ms.

### Phase 2 — `buildSystemPrompt`
```
await buildSystemPrompt({ mode, activeTriggers, … })
```
- In **`default` mode** (most turns): pure string assembly — no DB calls. ~0 ms.
- In **`plan_week` mode**: two serial awaits:
  - `fetchActiveBlockContext` → 1 DB read + `getUserTimezone`
  - `fetchAutoregContext` → depends on result of first call → 2–3 DB reads
  - **Serial dependency chain** — cannot parallelise within this function as written.
- In **`setup_block` mode**: 1 serial await for `fetchSetupBlockContext` (~3 DB reads).
- In **`intake` mode**: 1 serial await for `fetchIntakeContext` (~2 DB reads).

**Key finding:** In `default` mode (the vast majority of turns) `buildSystemPrompt` is ~free. In `plan_week`/`setup_block` modes it adds a serial 2-step chain of ~40–120 ms after Phase 1 finishes.

### Phase 3 — `buildEphemeralHeader`
```
await buildEphemeralHeader({ supabase, userId, tz })
```
Internal `Promise.all` of four things:
- `daily_logs` for today + yesterday (2 rows)
- `getSyncFreshness` (metadata query)
- `training_weeks` latest row
- `Promise.resolve(nowInUserTz(…))` (sync, free)

**Key finding:** Phase 3 has **no data dependency on Phase 2**. It only needs `tzForToday` (available from Phase 0). Today it runs sequentially after `buildSystemPrompt`, but there is nothing in the data flow that prevents running it in parallel with Phase 2.

**Duration estimate:** 2–3 concurrent DB round-trips → ~30–80 ms.

### Phase 4 — per-speaker context (inside `ReadableStream.start()`)
This runs **after the HTTP response object is created but before the first `runChatStream` iteration produces a token**. The client is already reading the SSE stream, but no bytes have been written yet — the user sees the typing indicator for this entire duration.

- **Peter:** two serial awaits:
  1. `buildPeterContextBlock` (~4 DB reads in `Promise.all`)
  2. `getUserTimezone` (redundant — already fetched in Phase 0)
  3. `loadLatestPeterDashboard` — depends on `today` from step 2 → serial

  **Serial chain after Phase 4 entry:** `buildPeterContextBlock` → `getUserTimezone` → `loadLatestPeterDashboard`. Steps 2 and 3 are serialised but could be parallelised with step 1 because `loadLatestPeterDashboard` only needs `today` (derivable from the already-known `tzForToday`).

- **Carter:** parallel `Promise.all` of three context builders — already optimal.

- **Nora:** one `profiles` read (eating_identity_cache + dietary_exclusions) — single round-trip.

**Duration estimate:** Peter ~60–150 ms; Carter ~40–100 ms; Nora ~20–50 ms.

### Phase 5 — `runChatStream` opens (first token)
Anthropic API call begins. TTFT from here is determined by Anthropic latency + prompt-cache hit rate.

---

## Execution timeline (default mode, Peter speaker)

```
t0  ── getUserTimezone ─────────────────────────────────── ~30 ms
t1  ── Promise.all: snapshot + window + triggers + targets ─ ~200–350 ms
t2  ── buildSystemPrompt (default: pure, ~0 ms) ────────── ~0 ms
t3  ── buildEphemeralHeader (internal Promise.all) ──────── ~40–70 ms
        [try block exits; ReadableStream.start() enters]
t4  ── buildPeterContextBlock ─────────────────────────── ~50–100 ms
t4b ── getUserTimezone (REDUNDANT) ──────────────────────── ~30 ms
t4c ── loadLatestPeterDashboard ─────────────────────────── ~20–40 ms
t5  ── runChatStream first token ────────────────────────── Anthropic TTFT
```

**Total pre-stream CPU-gated time (static estimate): ~370–620 ms** before Anthropic is even called.

---

## Runtime numbers — to be captured by user

Install the guard and run the dev server:

```bash
CHAT_COLDPATH_PROFILE=1 npm run dev
```

Send one turn each for Peter, Carter, and Nora. The server terminal will emit a line:

```
[chat-cold] summary {"speaker":"peter","mode":"default","tz_ms":…,"promise_all_ms":…,"system_prompt_ms":…,"ephemeral_header_ms":…,"speaker_context_ms":…,"total_pre_stream_ms":…}
```

Record per-phase ms (min/median/max) across 3 turns per speaker and fill in the table below.

| Phase | Peter | Carter | Nora |
|---|---|---|---|
| tz_ms (Phase 0) | TO CAPTURE | TO CAPTURE | TO CAPTURE |
| promise_all_ms (Phase 1) | TO CAPTURE | TO CAPTURE | TO CAPTURE |
| system_prompt_ms (Phase 2) | TO CAPTURE | TO CAPTURE | TO CAPTURE |
| ephemeral_header_ms (Phase 3) | TO CAPTURE | TO CAPTURE | TO CAPTURE |
| speaker_context_ms (Phase 4) | TO CAPTURE | TO CAPTURE | TO CAPTURE |
| total_pre_stream_ms | TO CAPTURE | TO CAPTURE | TO CAPTURE |

---

## Parallelisation candidates (input for Task 2)

### Win 1 (HIGH) — Move `buildEphemeralHeader` into the Phase 1 `Promise.all`
- **Current:** runs sequentially after `buildSystemPrompt` (Phase 2 → Phase 3).
- **Why safe:** `buildEphemeralHeader` only needs `tzForToday` (Phase 0 output). It has no dependency on `buildSystemPrompt`'s output or any Phase 1 result.
- **Expected saving:** the full Phase 3 duration (~40–70 ms, possibly 100+ ms on cold Supabase) removed from the serial critical path.
- **How:** add `buildEphemeralHeader(…)` as a seventh member of the existing `Promise.all([…])` at line ~580. Destructure the result alongside the others.

### Win 2 (MEDIUM) — Deduplicate redundant fetches in Phase 1
- **Current:** `loadWorkouts(userId)` called twice (snapshot → intelligence AND intelligence directly); `getTodayTargets` called three times; `profiles` read twice.
- **Why matters:** while they all run inside a single `Promise.all`, each still costs a network round-trip, puts load on Supabase, and consumes Vercel function timeout budget.
- **How:** pass the `loadWorkouts` result from the outer `buildSnapshot` call into `buildAthleteIntelligence` as a parameter (add an optional `workouts?` param to `buildAthleteIntelligence`). Thread `todayTargets` from the outer call into both `buildSnapshot` and `buildAthleteIntelligence`. Net effect: 2 fewer DB queries per turn.

### Win 3 (MEDIUM) — Fix Phase 4 serial chain for Peter
- **Current:** `buildPeterContextBlock` → `getUserTimezone` (redundant) → `loadLatestPeterDashboard` run sequentially inside the stream's `start()` callback.
- **Why safe:** `today` needed by `loadLatestPeterDashboard` is already computed in Phase 0 (`tzForToday` + `todayIso`); no need to call `getUserTimezone` again.
- **How:** pass `tz` and `today` from Phase 0 into the stream setup so Phase 4 can parallelise all three Peter reads: `Promise.all([buildPeterContextBlock, loadLatestPeterDashboard])`.

### Win 4 (LOW) — Deduplicate `getUserTimezone` calls
- **Current:** called 3× across the cold path (Phase 0, Phase 4, and once inside `fetchActiveBlockContext` in plan_week mode).
- **How:** plumb `tzForToday` from Phase 0 into Phase 4 and into the `buildSystemPrompt` options. This is a refactor win; the DB cost is tiny (single row, likely cached at Supabase edge), but it removes the redundancy.

---

## Single biggest win (static analysis verdict)

**Phase 3 (`buildEphemeralHeader`) is a pure serial tail that has zero data dependency on Phase 2 (`buildSystemPrompt`).** Moving it into the Phase 1 `Promise.all` collapses ~40–70 ms of serial Supabase latency at essentially zero implementation risk. This is the change Task 2 should ship first.

The runner-up is Phase 4's Peter serial chain (two unnecessary sequential awaits after `buildPeterContextBlock`), which adds another ~50–70 ms to every Peter turn.

---

## Instrumentation location

The timing marks live in `app/api/chat/messages/route.ts`, gated behind `process.env.CHAT_COLDPATH_PROFILE === "1"`. When the env var is unset (the default), all mark variables are `const _cpEnabled = false`, every mark is guarded by `if (_cpEnabled)`, and the summary log block is never reached — zero overhead on normal runs.
