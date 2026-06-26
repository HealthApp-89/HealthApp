# Comprehensive Health App Audit
**Date:** 2026-06-26  
**Scope:** Coach intelligence, UI/performance, bugs, roadmap recommendations  
**Priority:** Coach quality (main weakness) → Performance/UX → Strategic growth features

---

## Executive Summary

Your app is well-architected and deterministically sound (prescription engine, timezone handling, RLS security all solid). However, **coach quality is the weakening link**. Coaches give generic advice because they lack three things:

1. **Rich context understanding** — Profile only loaded at intake; no athlete identity blocks (your top exercises, eating patterns, constraints)
2. **Cross-domain pattern recognition** — Coaches answer their lane in isolation; miss multi-metric signals (low HRV + missed protein = fatigue)
3. **Evolved memory** — Advice cycles forever without adapting to what you've tried or what worked

**Recommended next step:** Phase 1 (Coach Intelligence, 5 weeks) addresses all three gaps via snapshot context injection + new intelligence composers + prompt adaptation. This unblocks Phase 2 (performance polish) and Phase 3 (strategic growth features).

---

## Part 1: Coach Architecture & Weaknesses

### Current Context Injection Flow

**Snapshot Prefix (Cached, ~14 days):**
- Profile + WHOOP baselines (rolling 30d + historical 6mo)
- Last 14 days daily_logs (HRV, recovery, sleep, strain, steps, weight, macros)
- 5 most recent workouts (sets, volume, exercises)
- Training plan (week labels, session types)
- Athlete profile (medical history, equipment, lifestyle, goal narrative)

**Per-Turn Header (Fresh, not cached):**
- NOW timestamp + current week bounds (Mon→Sun)
- TODAY (partial daily_logs) + YESTERDAY (full row)
- Data freshness (last ingest time per source, hours-ago precision)

**Coach-Specific Tool Access:**
- **Peter:** All tools (cross-domain queries)
- **Carter:** Workouts + recovery columns (HRV, RHR, recovery %, sleep, strain)
- **Nora:** Food log + body composition (weight, body fat, fat-free mass)
- **Remi:** Daily_logs recovery/sleep cluster (HRV, RHR, sleep hours, sleep score, skin temp, respiratory rate)

### Weakness A: Lack of Context Understanding

**Problem:** Coaches give generic advice because they don't know who you are beyond intake-time profile.

**Symptoms:**
- Suggests exercises you hate or can't do (no injury history active in prompts)
- Repeats nutrition advice you've heard 10 times
- No reference to your equipment constraints (home gym vs commercial)
- Same advice regardless of your actual 90-day patterns (you might hate high-volume training but coach keeps pushing it)

**Root cause:** Profile is loaded once at intake, then only referenced for static context (goal narrative, medical history). No "athlete identity" blocks showing:
- Top 5 exercises per category (what you actually train regularly)
- Eating identity (proteins you eat 5+ times/week, carb sources, cuisines you prefer)
- Training style signature (volume preference, intensity distribution, recovery speed)
- Active constraints (current injuries, equipment access, schedule patterns)

**Impact on user:** Feels like the coach doesn't know you. Generic advice is low-signal, noise-adjacent.

### Weakness B: Limited Data Correlation

**Problem:** Each coach answers their lane in isolation; no cross-domain synthesis before responding.

**Symptoms:**
- Low HRV + missed protein target = fatigue signal, but coach only addresses HRV in isolation
- High endurance volume + strength plateau = interference warning, but coaches don't flag this link
- Weight trending up + deficit increasing + sleep dropping = overreach pattern, but coach misses it
- Losing muscle vs fat loss indistinguishable in coach responses (no body comp + protein + lift volume correlation)
- Peter has "Today's read" (cross-domain synthesis) but it's expensive and only fires daily, not per-turn

**Root cause:** Intelligence composers exist for Peter (peter-dashboard, weekly-review, proactive-nudges) but they're domain-specific. No reusable library of correlation patterns:
- Recovery readiness (HRV + RHR + sleep quality + recent strain)
- Nutrition-performance linker (protein consistency vs strength gains, carbs timing vs workout execution, deficit magnitude vs recovery)
- Strength-endurance interference checker (TSS ratio + volume trend + lift plateau onset)
- Body composition direction (weight trend + body fat % + muscle-based lift performance + protein intake)

**Impact on user:** Coach misses the obvious cross-domain story. You have to synthesize it yourself, then ask the coach to confirm.

### Weakness C: Repetitive / Stale Prompts

**Problem:** Coach advice doesn't evolve with your situation; base prompts cycle forever.

**Symptoms:**
- "Sleep 8 hours" every time sleep dips, even if you've already optimized sleep
- "Hit protein target" cycling, ignoring that you hit it 6 of 7 days for 4 weeks
- Deload suggestions use hard-coded HRV thresholds, not your personal recovery speed
- Proactive nudges (Remi reaching out) have fixed triggers with no personalization
- No long-term pattern memory (coach forgets what you tried 6 weeks ago)
- No success tracking (sleep improved? coach doesn't acknowledge the win or back off sleep emphasis)

**Root cause:** System prompts are static base text. No adapters for:
- Responsiveness memory (which interventions you actually respond to)
- Success acknowledgment (pattern detection for "this worked")
- Constraint-aware suggestions (auto-exclude painful exercises, respect your schedule)
- Personalized thresholds (your sleep baseline is 7.5h, not the generic 8h)
- Historical context (what you've tried, failures and wins)

**Impact on user:** Feels robotic and repetitive. Coaching becomes noise rather than signal.

---

## Part 2: Proposed Solutions

### Layer 1: Rich Context Injection (Fixes Weakness A)

**Location:** `lib/coach/intelligence/` modules, injected into `snapshot.ts`

**New blocks to build:**

#### Athlete Identity Composer (90-day rollup)
```
- top_exercises_by_category: {
    lower: [Squat, RDL, Hip Thrust, Leg Press],
    upper: [Bench Press, Bent Rows, OHP],
    pulls: [Weighted Chins, Lat Pulldown],
    isolation: [Leg Curl, Lateral Raise, DB Curl]
  }
- eating_identity: {
    proteins: [chicken breast, eggs, Greek yogurt, salmon],
    carbs: [white rice, sweet potato, oats],
    fats: [olive oil, butter, coconut oil],
    cuisines: [Mediterranean, Asian, simple prep]
  }
- training_style_signature: {
    volume_preference: "moderate" | "high" | "low",
    intensity_distribution: 60% RPE6-7 / 30% RPE8-9 / 10% RPE10,
    recovery_speed_days: 2.5,  // avg days for HRV to rebound post-deload
    session_duration_preference_min: 45
  }
```

#### Constraint Block (active flags from profile)
```
- active_injuries: [{ area: "shoulder", status: "improving", weeks: 3 }],
- exercise_exclusions: [OHP, "Heavy Bench press", "Overhead throws"],
- equipment_access: "commercial_gym",
- schedule_constraints: [
    "can't train before 6pm (work)",
    "3 sessions/week max (family time)",
    "travel every 3rd week"
  ]
```

#### Coach History Block (what's been tried, outcomes)
```
- recent_deloads: [
    { date: "2026-06-15", type: "HRV-triggered", hrv_recovery_days: 5, success: true },
    { date: "2026-05-20", type: "off_pace", success: false, reason: "strength didn't rebound" }
  ],
- exercise_swaps_8w: [
    { from: "Barbell Rows", to: "Seal Rows", reason: "shoulder pain", result: "success" },
    { from: "Lat Pulldown", to: "Weighted Chins", result: "failed", reason: "shoulder aggravated" }
  ],
- nutrition_interventions: [
    { intervention: "caffeine cutoff 2pm", duration_weeks: 3, sleep_improvement: "marginal", adopted: false },
    { intervention: "protein 2.2g/kg", duration_weeks: 6, strength_gain: "strong", adopted: true }
  ]
```

**Coaches see:** "Given your shoulder restriction and pain history with chins, avoid overhead work and heavy pulling for 4 more weeks" — instead of suggesting OHP or weighted chins off the cuff.

---

### Layer 2: Cross-Domain Intelligence Composers (Fixes Weakness B)

**Location:** `lib/coach/intelligence/` pure functions (no DB calls)

**New modules to build:**

#### Recovery Readiness Composer
```
Input: last 7 days of HRV, RHR, sleep_quality, sleep_hours, strain
Output: {
  status: "recovering_well" | "stalled" | "warning_overreach",
  confidence: 0.75,
  drivers: ["HRV+0.5SD", "RHR stable", "sleep_score 80+"],
  action: null | "consider_deload"
}
```
Used by: All coaches for autoregulation decisions.

#### Nutrition-Performance Linker
```
Input: protein_consistency (% days hitting target), carbs_timing, deficit_magnitude, strength_gains_4w, body_comp_trend
Output: {
  protein_status: "adequate" | "marginally_short" | "critically_low",
  carb_timing_optimal: true | false,
  deficit_severity: "appropriate" | "aggressive_but_sustainable" | "unsustainable",
  predicted_muscle_loss_risk: "low" | "moderate" | "high"
}
```
Used by: Peter (cross-domain), Nora (to set targets).

#### Strength-Endurance Interference Checker
```
Input: weekly_TSS, volume_trend_4w, lift_performance_plateau_days, current_block_phase
Output: {
  interference_level: "none" | "mild" | "high",
  tss_ratio_4w_28w: 0.92,
  action: null | "reduce_endurance_volume" | "reduce_lifting_volume"
}
```
Used by: Carter (for load decisions), Peter (for block planning).

#### Body Composition Direction Detector
```
Input: weight_trend_4w, body_fat_trend, muscle_based_lift_topset_trend, protein_consistency
Output: {
  direction: "gaining_muscle" | "losing_muscle" | "neutral" | "unknown",
  confidence: 0.82,
  days_to_signal: 18,  // how many more days until confident
  muscle_loss_risk: "low" | "moderate"
}
```
Used by: Nora (protein targets), Peter (phase decisions).

**Coaches see:** "Your metrics show mild interference (TSS ratio 1.3x) — endurance isn't blocking strength yet, but the trend is concerning. Consider dropping Z2 to 45 min/week for next 2 weeks" — instead of ignoring the multi-metric signal.

---

### Layer 3: Prompt Evolution & Memory (Fixes Weakness C)

**Location:** Prompt template injectors in `lib/coach/system-prompts.ts`

**New adapters:**

#### Responsiveness Memory
```
Track: which interventions (deload timing, macro adjustments, sleep protocols, exercise swaps) you respond to.

Inject: "Based on your history, you recover fastest after 5-day deloads (not 7), and you're responsive to protein bumps but not to caffeine cutoff. Prioritize accordingly."

Coach behavior: Emphasizes high-ROI levers (protein for you, deload duration), de-emphasizes low-signal interventions (sleep hygiene if you're already consistent).
```

#### Success Acknowledgment
```
Detect: Recent action worked (HRV recovered post-deload, strength recovered post-diet bump, weight stable despite calorie reduction).

Inject: "Your last deload worked — HRV is back to 65 ms baseline. The 5-day duration was right for you."

Coach behavior: Says the win out loud, doesn't suggest the same intervention again immediately. Backs off emphasis on that domain.
```

#### Constraint-Aware Suggestions
```
Auto-exclude: Exercises flagged as painful in history. Never suggest OHP if shoulder issues are active.

Auto-tailor: All advice to your equipment (no "add a cable machine exercise" if you're at home gym) and schedule (no "add 2 more sessions" if you're at 3/week capacity).

Inject: Coach sees constraint block pre-turn, rejects suggestions that violate them before they reach the LLM.
```

#### Personalized Thresholds
```
Sleep threshold: Your baseline is 7.5h (not generic 8h). Alarm at <7h or >8.5h (2 consecutive nights), not <8h.

Deload trigger: Your HRV recovers in 5 days (not generic 7). Trigger at -7% (not -5%) if sustained 3 days.

Protein floor: 2.0g/kg for you (you respond to bumps) vs 1.6g/kg baseline.

Inject: Coach's decision thresholds personalized per athlete, not hard-coded.
```

**Coaches see:** "Based on your history, you respond well to protein bumps and recover in 5 days. Let's bump to 2.2g/kg and deload next Friday for 5 days" — instead of generic "consider deloading if HRV drops."

---

## Part 3: UI, Performance & Bugs

### 🔴 High Priority (Performance)

**1. Chat streaming latency (2-3s first token)**
- **Root cause:** Snapshot building parallelizes queries but chat route waits for all data before opening stream
- **Fix:** Stream first token within 1s; return incomplete snapshot, fill async
- **Effort:** ~12 hours
- **Impact:** Feels 2-3× faster

**2. Workout logger sluggish on mobile**
- **Root cause:** Exercise reorder + rest timer missing memo boundaries
- **Symptoms:** Frame drops below 60fps on 3-step session
- **Fix:** Add React.memo to ExerciseRow, RestTimer; lazy-load swapper modal
- **Effort:** ~8 hours
- **Impact:** 60+ fps consistently

**3. Weekly review page slow (2-4s Suspense wait)**
- **Root cause:** Fetches workouts → daily_logs → weekly_reviews in series, then renders 5 sections
- **Fix:** Parallel fetch + granular Suspense per section (recap first, trends stream)
- **Effort:** ~6 hours
- **Impact:** First paint <1s, progressive loading

### 🟠 Medium Priority (UX & Bugs)

**4. Coach responds before data ready (off-by-one day)**
- **Root cause:** Snapshot window mismatch; fresh endurance/food entries not visible
- **Fix:** Align snapshot bounds with data freshness headers
- **Effort:** ~4 hours
- **Impact:** Coaches cite current data consistently

**5. Coach input chips overflow on mobile**
- **Root cause:** Approve/Reject buttons don't wrap on narrow (<375px) screens
- **Fix:** Wrap on mobile, stack vertically
- **Effort:** ~2 hours
- **Impact:** UX completeness

**6. Coach language impersonal**
- **Root cause:** "Your HRV is low" without baseline context or athlete name
- **Fix:** Inject athlete name, cite baseline, personalize language
- **Effort:** ~3 hours (prompt changes)
- **Impact:** Feels more human

**7. UI clarity issues**
- Readiness bands (green/yellow/red) have no labels → add "Good / Watch / Action"
- Session states (as_planned / swapped / missed) have subtle icons → clarify with text
- Coach speaker badges small + not distinctive → larger, distinct colors per coach
- WHOOP terms (strain, recovery %, HRV) unexplained → add glossary hover hints
- **Effort:** ~10 hours
- **Impact:** New user onboarding clearer

### ✅ What's Working Well

**Deterministic prescription engine:** Load progression bulletproof. Phase rules correct. Swing loss, consolidation, pre_target all sound.

**Timezone handling (PR #137):** Profile sync + ambient chip + travel mismatch detection all working. "Today" computations consistent.

**Food logging + chat integration:** Nora's resolve → propose → commit flow smooth. Library dedup working. Macro resolution (USDA → LLM fallback) accurate.

**RLS + security:** Single-user app with strong Supabase RLS. Ingest token system prevents unauthorized entry. No known security gaps.

---

## Part 4: Recommended Roadmap

### Phase 1: Coach Intelligence (5 weeks) — START HERE
**Blocking:** Phase 2 performance work, Phase 3 strategic features. Coach quality is the main weakness.

**Week 1-2: Layer 1 (Athlete Identity)**
- Build composers: top_exercises_by_category, eating_identity, training_style_signature, constraints_summary
- Inject into snapshot prefix
- **Effort:** ~40 hours
- **Impact:** Coaches immediately less generic

**Week 2-3: Layer 2 (Cross-Domain Intelligence)**
- Build composers: recovery_readiness, nutrition_performance_linker, interference_checker, body_comp_direction
- Audit fixtures for each (pure function tests)
- Inject results into snapshot
- **Effort:** ~50 hours
- **Impact:** Coach catches multi-metric problems

**Week 4: Layer 3 (Prompt Adaptation)**
- Add adapters to system-prompts.ts: responsiveness_memory, success_acknowledgment, constraint_aware_suggestions, personalized_thresholds
- Test prompt injection
- **Effort:** ~25 hours
- **Impact:** Coach advice feels custom, evolves

**Week 5: Testing & Tuning**
- Audit each composer against live data
- Verify snapshot injection end-to-end
- Manual chat validation (test coaches' contextual understanding)
- Tune prompt macros

**Deliverable:** Coach system that understands your context, correlates across domains, and adapts to what works for you.

---

### Phase 2: Performance & UX (2-3 weeks, parallel weeks 2-5 of Phase 1)

**Chat latency:** ~12h → Stream first token <1s  
**Workout logger smoothness:** ~8h → 60+ fps on mobile  
**Weekly review page:** ~6h → Parallel fetch, granular Suspense  
**UI clarity:** ~10h → Labels, icons, glossary hints  
**Mobile fixes:** ~2h → Wrap input chips  

**Deliverable:** App feels snappy and intuitive.

---

### Phase 3: Strategic Growth (After Phase 1)

**Endurance phase expansion (build/race_prep/taper):** ~30h. Requires interference checks from Phase 1.  
**Coach team growth (add Felix or Maria):** ~60h. Requires Phase 1 context layers for tool gating.  
**GLP-1 Phase 2 (auto-detect status):** ~20h. Requires athlete identity data from Phase 1.  
**Athlete profile Phase 2 (AI plan generation):** ~80h. Requires Phase 1 context for narrative quality.  

**Deliverable:** Broader coaching coverage, multi-sport support, auto-personalized plans.

---

## Why This Order?

**Phase 1 fixes the main weakness.** A faster app with generic coaching isn't useful. A slower app with smart, contextual coaching keeps you engaged and drives action.

**Phase 2 matters, but only after Phase 1.** Polish a well-designed system, not a broken one.

**Phase 3 features all depend on Phase 1's foundation.** New coaches need rich context layers to avoid duplication and provide specialized insight. Endurance expansion needs interference signals. Plan generation needs athlete identity.

**Timeline:** Phase 1 + Phase 2 = 7-8 weeks total. Then Phase 3 features unlock.

---

## Implementation Starting Point

See [Phase 1 Implementation Plan](./2026-06-26-phase-1-coach-intelligence-plan.md) for the step-by-step breakdown of what to build, where, and in what order.
