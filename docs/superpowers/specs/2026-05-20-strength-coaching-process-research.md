# Strength-coaching process: what an expert actually does

**Status:** research brief (not a feature spec)
**Date:** 2026-05-20
**Audience:** future session designing Coach Carter's exercise library and rotation policy
**Why this exists:** the app already knows about blocks and MEV/MAV/MRV volume landmarks ([lib/coach/volume-landmarks.ts](../../lib/coach/volume-landmarks.ts)), but it has no model for *which* exercises Carter should select from or *when* he should swap one. This document synthesizes the literature and coaching consensus on those gaps so the next brainstorm starts from a shared base.

A note on honesty: where the research is firm I'll say so; where the field runs on consensus and coaching practice I'll say so too. The exercise-rotation question in particular is one of the parts of strength training where studies are thin and coaching practice has converged on heuristics rather than proofs.

## 1. The macro frame

An expert strength coach orchestrates four nested timescales:

- **Macrocycle** (training year): the long-arc plan. Defines what the athlete is peaking for, what they're building toward, and how many qualities can be pushed in parallel.
- **Mesocycle** (block, ~4–6 weeks): a single focused adaptation window — hypertrophy block, strength block, peak block. The deload at the end is *part of* the block, not a recovery from it.
- **Microcycle** (week): the rotation of session types and their weekly volume.
- **Session**: the individual training day.

This hierarchy exists because of two physiological models the field treats as load-bearing:

- **Fitness–fatigue (Banister, refined by Chiu/Barnes):** every training stimulus deposits both fitness and fatigue. Fitness decays slowly, fatigue decays fast. Performance ≈ fitness − fatigue. The implication is that you can't continuously push — you have to manage fatigue to let fitness express itself.
- **Supercompensation (Selye/GAS-derived):** an overload phase elevates capacity, but only if followed by adequate recovery. Without the recovery beat, you accumulate fatigue and regress.

Three philosophies dominate how these timescales are organized:

| Philosophy | Mechanism | Best fit |
|---|---|---|
| **Linear (NSCA classic, Matveyev)** | Volume drops and intensity rises across a long phase | Novices preparing for a single peak; largely deprecated for hypertrophy goals |
| **Block periodization (Issurin)** | Sequential mesocycles each emphasize one ability (accumulation → transmutation → realization) | Strength/power athletes peaking for competition |
| **Undulating volume periodization (Israetel / Helms / RP)** | Each mesocycle ramps volume MEV → MRV per muscle; phase focus shifts across blocks but each block is internally a volume ramp | Recreational and competitive hypertrophy; intermediate→advanced lifters with multi-quality goals |

For a recreational physique-plus-strength athlete (Abdelouahed's profile), the RP-style mesocycle is the strongest match and is already the implicit shape of the app's `training_blocks` / `training_weeks` schema. The rest of this brief assumes that framing.

## 2. MEV / MAV / MRV in practice

These are *per muscle, per week* set counts. The four landmarks form a stack:

- **MV** (Maintenance Volume): the minimum to not lose muscle. Roughly one third of MEV. Useful during specialization phases where one muscle is pushed and others cruise.
- **MEV** (Minimum Effective Volume): below this, no growth.
- **MAV** (Maximum Adaptive Volume): the sweet spot — best growth-per-set ratio. The band you want to spend most of a block in.
- **MRV** (Maximum Recoverable Volume): the ceiling. Past this, fatigue rises faster than adaptation.

The app's [literatureBand()](../../lib/coach/volume-landmarks.ts) returns the intermediate-tier numbers and scales by training age (beginner 0.7×, advanced 1.2×). For an intermediate male lifter, RP's published bands look like: chest 10/12–20/22, quads 8/12–18/20, lats 10/14–22/25 (MEV / MAV range / MRV).

These numbers are *coaching consensus cross-referenced against Schoenfeld's 2017 and 2022 meta-analyses* on volume dose-response — they are not clinical-trial-validated thresholds. The honest statement in the codebase comment is correct: "field-best-practice consensus, NOT clinical-trial-validated thresholds." Treat them as informed defaults that should be overridden by per-athlete observation.

### The ramp shape

The standard mesocycle ramp (matching `targetSetsForWeek`):

- Week 1: ~MEV (1.0× MEV)
- Week 2: ~1.13× MEV
- Week 3: ~1.27× MEV
- Week 4: ~1.4× MEV (peak)
- Week 5: ~0.5× MEV (deload)

The asymmetry — gradual climb, sharp cut — is intentional. Fatigue compounds nonlinearly (each week of overreaching costs more than the last), so the climb has to be slow. Recovery from a one-week deload is faster than fatigue accumulation, so the cut can be steep. The week-5 deload isn't optional rest; it's the *fitness expression window* the fitness-fatigue model predicts.

### What the landmarks *don't* tell you

MEV/MAV/MRV say nothing about:
- Which exercises deliver the sets.
- How those sets distribute across the week.
- Intensity (RPE/RIR/%1RM) within the sets.
- When to change an exercise.

Those gaps are the substance of sections 3–5.

## 3. Exercise selection — the criteria experts weigh

An expert doesn't pick exercises from a flat list. They evaluate candidates against roughly eight axes:

1. **Movement pattern** (push horizontal/vertical, pull horizontal/vertical, squat, hinge, lunge, carry, core). This is the *coarsest* lens — the one already in [lib/coach/exercise-categories.ts](../../lib/coach/exercise-categories.ts).
2. **Primary mover** (chest, quads, lats, etc.) and secondary mover with weighting (matching `secondary_set_factor: 0.5` in `DEFAULT_COUNTING_RULES`).
3. **Stability vs. systemic fatigue cost.** A leg press isolates quads with low systemic cost; a back squat builds quads *and* taxes the central nervous system, spinal erectors, and recovery budget. For pure hypertrophy of the target muscle, lower stability cost is often better; for general strength, the opposite.
4. **Loadability / microloadability.** Can the athlete add 2.5 kg next week, or does the equipment force jumps of 5 kg? The increment column the app already tracks on [SESSION_PLANS](../../lib/coach/sessionPlans.ts) lives here.
5. **ROM, especially lengthened-position emphasis.** Recent work (Wolf et al. 2023 meta on ROM; multiple 2020s lengthened-partials studies) supports the practice of preferring exercises that load the target muscle in its stretched position — Romanian deadlifts over leg curls for hamstrings, dumbbell flyes over cable crossovers for chest. The evidence is recent and still consolidating.
6. **Skill demand.** Technical lifts (snatch, clean) carry a learning cost that for a non-Olympic-lifter eats time that could be spent on adaptation.
7. **Joint stress profile.** Which joints (shoulders, low back, knees) take the wear. An athlete with shoulder restriction skips overhead pressing variations; one with a low-back history substitutes hack squats for back squats.
8. **Trainee preference.** Adherence is a force multiplier. An exercise the athlete hates done at MEV beats an "optimal" exercise done sporadically.

### The SRA curve

Stimulus → Recovery → Adaptation. The best exercises maximize stimulus per unit of recovery cost. A deadlift delivers enormous stimulus but a 4–5 day recovery cost; a cable row delivers moderate stimulus with a 24-hour recovery cost. The right exercise depends on the week's other sessions: a heavy deadlift on a leg day burns recovery you might need for back day.

### The exercise library isn't a list — it's a graph

The practical operationalization: for each session slot, an expert has a small ranked set of *acceptable substitutes within pattern*. "Decline barbell bench" has 3–5 acceptable swaps that share the pattern and primary mover but differ on stability, ROM bias, or joint stress. The substitution graph is the data structure that makes mid-block swaps possible.

## 4. Keep the same exercises, or change them?

Coaches argue about this. There are four main schools.

### School 1 — never change (powerlifting / Sheiko)

Same lifts for years. Squat, bench, deadlift every week. You only change *how heavy* and *how many reps*, not *which* exercise.

- **Why it works:** you get really good at the exact movement, and you can see your progress cleanly because nothing else is changing.
- **Why it doesn't:** your joints take all the wear on the same groove. Not ideal for building muscle, because muscles grow best when worked through varied angles.

### School 2 — rotate accessories every ~5 weeks (Renaissance Periodization, Helms)

The dominant evidence-based view. Keep the big lifts forever, but swap **one or two accessory exercises** every time you start a new 4–6 week block. So your block might end with "incline dumbbell press" and the next one starts with "cable fly."

- **Why it works:** joints get a break from the same groove, and your muscle stops "tuning out" the repeated stimulus (a real effect — Damas's studies show muscle protein synthesis drops after ~3 weeks on the same routine).
- **Why it doesn't:** the first week of any new exercise has worse progression tracking — you're still learning the movement.

### School 3 — change to match the block's goal (Issurin block periodization)

A "build muscle" block uses different exercises than a "get strong" block than a "peak for a meet" block. Selection shifts with phase.

- **When to use it:** competitive lifters peaking for an event.
- **When not:** general physique work. Overkill.

### School 4 — rotate the heavy lift constantly (Westside / Conjugate)

The main max-effort lift changes every 1–3 weeks. Accessories chosen by attacking your weak point ("bench fails at lockout → do triceps").

- **Why it works at elite level:** prevents staleness on heavy work; weak-point analysis is data-driven.
- **Why it's risky for the rest of us:** needs deep diagnostic skill. Most lifters don't have clean enough strength data to drive it.

### What does the research actually say?

Honestly — not much. The few direct studies:

- **Fonseca 2014:** varied vs. same quad exercises → similar total growth, but varied was *more even* across the four quad heads. Small study.
- **Baz-Valle 2019:** varied vs. same for hypertrophy → no real difference in muscle gain. Small bump for motivation.
- **Damas 2015 / 2019:** muscle protein synthesis is high for ~3 weeks on a new stimulus, then drops, then partially recovers. This is the *mechanism* behind "swap every ~5 weeks."
- **Schoenfeld 2017 / 2022 (meta-analyses):** total weekly volume is by far the strongest driver of growth. Variation effects are small next to volume.

**Honest synthesis:** volume and slowly adding weight drive 80% of progress. Variation only matters at the margins — for adherence (you don't get bored), joint health (different angles share the wear), and hitting parts of a muscle one exercise misses. The "keep main lifts forever, rotate accessories every block" recipe most good coaches use is *sensible* — it lines up with what we know — but it's not *proven* by a clean study.

## 5. When should I actually swap THIS exercise?

The practical decision an expert makes. Six triggers, ordered by urgency:

| What happened | What to do |
|---|---|
| **Joint pain or a suspicious tweak** | Swap right now. Pick something that hits the same muscle but feels different on the joint. Don't wait for the block to end. |
| **You stopped progressing for 2–3 weeks** at the same effort level | **Don't swap yet. Take a deload week first.** About 70% of stalls fix themselves after a deload. Only swap if the next week *after* the deload is also flat. |
| **Equipment broken / gym crowded** | Forced swap to the closest alternative. |
| **One muscle is lagging** (chest small relative to back, etc.) | Don't swap. *Add* a new exercise for the lagging muscle next block — the rest of the program stays. |
| **End of a 5-week block** | Planned rotation. Swap one or two of your accessories. Keep the big lifts. |
| **You're just bored** | Allowed to swap one accessory. If you'd quit otherwise, the swap is worth it. Adherence beats optimization. |

Two ideas buried in the table that are worth pulling out:

1. **"I'm stuck, I need a new exercise" is usually wrong.** When you stop progressing, your body is fatigued, not bored. Rest first. Change the exercise only if rest didn't fix it.
2. **Squat, bench, deadlift, RDL — don't swap these on a whim.** They're too valuable to re-learn from scratch and too central to general strength to throw away. Only swap a main lift for a real reason (pain, multi-month stall) — not because you saw something new on Instagram.

## 6. The long-arc progression — beginner, intermediate, advanced

How "expert process" scales with training age:

| Tier | Progression timescale | Variation cadence | Exercise count |
|---|---|---|---|
| **Beginner** (< 1 yr serious training) | Per session (add load every workout) | Almost none — 5–7 lifts, learn the patterns | Narrow |
| **Intermediate** (1–3 yrs) | Per week (MEV→MRV ramps; load adds weekly) | Per block: rotate ~20% of accessories | Moderate (~12–18 lifts in rotation) |
| **Advanced** (3+ yrs) | Per block (load adds across blocks, not within) | Per block + specialization phases for lagging muscles | Wide (20+ lifts; substitutes-within-pattern graph well-populated) |

The volume landmarks themselves shift with tier — the `TIER_SCALAR` in `volume-landmarks.ts` (0.7 / 1.0 / 1.2) captures this. But the bigger qualitative change is *what counts as progress*. A beginner adding 2.5 kg/week to the bench is normal; an advanced lifter adding 2.5 kg per *block* (10–12 weeks) is doing well.

Carter's policy needs to know which tier the athlete is on, because the same observation ("no load added this week") means very different things at each tier. For an intermediate, it's a flag; for an advanced lifter, it's expected within a non-realization block.

## 7. Implications for Coach Carter

What this brief implies the next brainstorm needs to design:

- **An exercise library** organized as a graph, not a list. Each exercise carries: movement pattern (already have via `EXERCISE_CATEGORY`), primary mover + secondary movers with weights (already have for volume rollups), stability tier, loadability/microloadability (already have via `increment`), ROM bias (lengthened-favorable / midrange / shortened), joint stress profile, skill demand, and a `substitutes` edge set ranked by similarity. The current 4-session, ~28-exercise [SESSION_PLANS](../../lib/coach/sessionPlans.ts) is a *seeded subset* of this library, not the library itself.

- **A main-lift vs. accessory classifier.** Main lifts are sticky across blocks. Accessories are rotatable. The classifier could be a column on the exercise record, or a derived rule (compound + barbell + appears in athlete's top-3 strength priorities → main; otherwise accessory). The distinction matters because Carter's swap policy is different for each.

- **A stall detector.** Reads from `query_workouts` (top-set e1RM by exercise, week-over-week). Flat ≥ 2 weeks at same RIR → flag. Carter's response should be "deload first" the first time and "consider swap" only if a post-deload week also stalls. Cleanest place: a derived field on the weekly review's prescription section.

- **A rotation-cadence policy at block boundaries.** When a `training_block` rolls into a new mesocycle (or the user runs the Sunday weekly-planning ritual on a transition week), Carter should *propose* a 20–30% accessory rotation using the substitutes-within-pattern graph. Going through `propose_week_plan` / `commit_week_plan` keeps the existing HMAC approval flow.

- **Athlete-tier awareness.** Already partially present via the tier scalar on volume landmarks; Carter's swap policy and progression expectations should read from the same tier field.

What Carter should explicitly *not* do:

- Make block-level rotation decisions silently mid-conversation. Block-boundary rotations are propose-then-commit, not in-place edits — they affect the next week's plan, the weekly review, and the volume rollups.
- Swap a main lift without a clear pain / multi-block-stall trigger. The substitutes graph permits it; the policy should not.
- Override the user's stated exercise preferences without surfacing the reason. Adherence wins ties.

## 8. Athlete's chosen policies (decided 2026-05-20)

These are the operational choices Abdelouahed made from the options surveyed in sections 4 and 5. They are inputs to the next brainstorm — the Carter exercise library + rotation engine should implement exactly this behavior.

### Rotation cadence — Section 4, School 2

**Rotate accessories every block (~5 weeks). Main lifts stay across blocks for years.**

- Main compound lifts (squat, bench, deadlift, RDL and the athlete's current equivalents) are *sticky* — same exercise across many mesocycles, only the load and rep targets change.
- At each block boundary (week-5 deload rolling into next block's week 1), Carter proposes swapping **1–2 accessory exercises** for alternatives in the same movement pattern.
- Swap candidates come from the substitutes-within-pattern graph the next brainstorm will design.
- Proposals go through `propose_week_plan` / `commit_week_plan` so the athlete approves before the next Sunday's plan locks.

### Mid-block swap policy — Section 5, urgency order

The six triggers below apply in this exact order. When Carter sees a question or a signal that fits, he applies the matching action without escalating to a different school.

1. **Pain or suspicious tweak** → swap immediately. Same pattern, lower stability cost or different joint angle. Don't wait for the block boundary.
2. **Stall ≥ 2–3 weeks at the same RIR** → **deload first, swap only if the week after the deload also stalls.** Carter must not propose a swap on a fresh stall.
3. **Equipment unavailable** → forced swap to the closest pattern-matched alternative.
4. **Lagging muscle** → *add* an exercise next block, don't swap. The existing program stays; a new lift joins it.
5. **Block boundary** → planned 1–2 accessory rotation per the cadence above.
6. **Boredom / adherence risk** → one accessory swap allowed mid-block if the athlete explicitly raises it. Adherence beats optimization.

### The main-lift exception

A main lift (squat, bench, deadlift, RDL) is only swapped on triggers 1 (pain) or 2 (multi-block stall confirmed post-deload). Triggers 3–6 apply to accessories only. Boredom doesn't justify swapping a squat variant.

This gives Carter a single ordered decision tree — no ambiguity about which school he's applying when a swap question comes up.

## 9. Sources

Consensus-and-coaching-practice sources, in rough order of weight on this brief:

- **Renaissance Periodization** — Mike Israetel, Chad Wesley Smith, James Hoffmann. *Scientific Principles of Strength Training* (2015); *The Hypertrophy Training Guide / Renaissance Periodization Diet*. Source for MEV/MAV/MRV framework, block ramp shape, accessory rotation cadence.
- **Eric Helms** — *The Muscle and Strength Pyramids* (2016 / 2019). Synthesis of evidence-based programming; the rotation cadence and main-lift-sticky-accessory-rotatable view.
- **Brad Schoenfeld** — meta-analyses on volume (2017, 2022) and frequency (2019). The volume dose-response numbers underlying MEV/MRV bands. Subsequent ROM/lengthened-partials work by Wolf, Pedrosa, and colleagues (2022–2024) extends the picture but is still consolidating.
- **Vladimir Issurin** — *Block Periodization* (2008). Phase-potentiation framing.
- **Damas, Phillips et al. (2015, 2016, 2019)** — muscle protein synthesis attenuation studies. Mechanistic basis for periodic variation.
- **Fonseca et al. 2014; Baz-Valle et al. 2019** — direct RCTs on exercise variation vs. constant. Empirical evidence on the variation question.
- **Krzysztofik et al. 2019** — review of training variables for hypertrophy.
- **Sheiko (Boris Sheiko)** — powerlifting programming archives. The "stay constant" school.
- **Louie Simmons / Westside Barbell** — *The Conjugate Method*. The max-effort rotation school.
- **ACSM** — position stands on progression for healthy adults (informs the beginner/intermediate/advanced tier definitions).

Note on weighting: sections 2–3 lean heavily on coaching consensus that has good but not airtight research backing. Section 4's "what the research shows" subsection cites the specific RCTs that exist; the rest of section 4 (school descriptions) is coaching-practice description. Section 5's decision rule is coaching practice — there are no RCTs on "when to swap an exercise mid-block" because that's not a tractable study design.
