// Database row shapes — snake_case, mirrors supabase/schema.sql.

export type DailyLog = {
  user_id: string;
  date: string; // YYYY-MM-DD
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  spo2: number | null;
  skin_temp_c: number | null;
  strain: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  rem_sleep_hours: number | null;
  weight_kg: number | null;
  body_fat_pct: number | null;
  fat_mass_kg: number | null;
  fat_free_mass_kg: number | null;
  muscle_mass_kg: number | null;
  bone_mass_kg: number | null;
  hydration_kg: number | null;
  steps: number | null;
  calories: number | null;
  active_calories: number | null;
  distance_km: number | null;
  exercise_min: number | null;
  calories_eaten: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  respiratory_rate: number | null;
  notes: string | null;
  source: string | null;
  updated_at: string;
};

export type Profile = {
  user_id: string;
  name: string | null;
  age: number | null;
  height_cm: number | null;
  goal: string | null;
  whoop_baselines: Record<string, unknown> | null;
  training_plan: Record<string, unknown> | null;
  /** User-edited coach prompt. NULL = use code default from
   *  lib/coach/system-prompts.ts:DEFAULT_SYSTEM_PROMPT. */
  system_prompt: string | null;
};

export type WhoopTokensRow = {
  user_id: string;
  whoop_user_id: string | null;
  updated_at: string;
};

export type WithingsTokensRow = {
  user_id: string;
  withings_user_id: string | null;
  updated_at: string;
};

export type IngestTokenRow = {
  user_id: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  last_used_source: "apple_health" | "strong" | "yazio" | null;
};

/** DB row shape for chat_messages. The route's typed return shape
 *  (lib/chat/types.ts:ChatMessage) is the API surface; this mirrors what's
 *  in the column directly. */
export type ChatMessageRow = {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error";
  error: string | null;
  model: string | null;
  /** [{name, input, ms, result_rows, range_days, truncated, error}] */
  tool_calls: ToolCallLog[] | null;
  /** Default 'coach' for the existing free-form chat thread; 'morning_intake'
   *  segregates the daily check-in conversation in ChatPanel. */
  kind: "coach" | "morning_intake" | "morning_brief";
  /** Chip definitions / rendering hints for the morning intake bot. NULL on
   *  free-form coach turns. */
  ui: MorningUI | null;
  mode: ChatMode;
  created_at: string;
  updated_at: string;
};

export type ToolCallLog = {
  name:
    | "query_daily_logs"
    | "query_workouts"
    | "query_training_blocks"
    | "query_training_weeks"
    | "get_autoregulation_signals"
    | "compute_adherence"
    | "propose_block"
    | "commit_block"
    | "propose_week_plan"
    | "commit_week_plan"
    | "apply_goal_target"
    | "apply_bedtime_correction"
    | "apply_macros_correction"
    | "apply_protein_correction"
    | "set_sanity_override"
    | "set_goal_narrative_chat"
    | "set_directness"
    | "set_cadence"
    | "set_chronotype"
    | "set_unprompted_actions"
    | "set_free_form_constraints"
    | "propose_plan"
    | "commit_plan"
    | "set_glp1_status"
    | "set_glp1_taper_started"
    | "mark_glp1_discontinued"
    | "regenerate_morning_brief";
  input: Record<string, unknown>;
  ms: number;
  result_rows: number;
  range_days: number;
  truncated: boolean;
  error: string | null;
  /** Tool result `data` field, persisted only for tools whose result the
   *  chat UI needs to render inline (propose_block, propose_week_plan,
   *  commit_block, commit_week_plan). Null/undefined for query tools. */
  result?: unknown;
};

// ── checkins ─────────────────────────────────────────────────────────────────

export type IntakeState =
  | "pending"
  | "awaiting_feel"
  | "awaiting_sickness_notes"
  | "awaiting_whoop"
  | "delivered"
  | "assembling_brief"
  | "brief_delivered"
  | "brief_failed";

export type FatigueLevel = "none" | "some" | "heavy";
export type SorenessSeverity = "mild" | "sharp";

export type CheckinRow = {
  user_id: string;
  date: string; // YYYY-MM-DD
  readiness: number | null;        // 1-10 (subjective body feel)
  energy: number | null;           // legacy int, unused — kept for back-compat
  energy_label: string | null;     // 'low' | 'medium' | 'high'
  mood: string | null;             // emoji
  soreness: string | null;         // legacy free-text — preserved, but readiness math reads soreness_areas
  feel_notes: string | null;
  notes: string | null;
  // 0007 additions
  sick: boolean;
  sickness_notes: string | null;
  fatigue: FatigueLevel | null;
  bloating: boolean | null;        // nullable: not asked = null
  soreness_areas: string[] | null; // ['chest','back','legs','shoulders','arms','core']
  soreness_severity: SorenessSeverity | null;
  intake_state: IntakeState;
  created_at: string;
};

// ── chat_messages.ui (chip rendering) ────────────────────────────────────────

/** Discriminant: presence of `slot` (slot answer) vs `action` (client side-effect)
 *  field. Renderers branch via `"slot" in chip` / `"action" in chip`. */
export type MorningChip =
  // Slot answer — POST {slot, value} to /api/chat/morning/intake
  | { label: string; value: string | number; slot: string }
  // Action chip — client dispatches a side-effect (whoop_sync, skip_whoop, retry_recommendation, retry_brief)
  | { label: string; action: "whoop_sync" | "skip_whoop" | "retry_recommendation" | "retry_brief" };

export type MorningUI = {
  chips?: MorningChip[];
  /** When true, chips form a multi-select; client renders an "Apply" button that
   *  submits the array. Used for soreness-area picker. */
  multi_select?: boolean;
  /** When true, the composer text input remains visible (e.g. for the LLM tail
   *  step). Default: false (composer hidden when chips are present). */
  allow_text?: boolean;
};

// ── training_blocks ──────────────────────────────────────────────────────────

export type BlockStatus = "active" | "completed" | "abandoned";
export type PrimaryLift = "squat" | "bench" | "deadlift" | "ohp";
export type TargetMetric = "e1rm" | "working_weight";

export type TrainingBlock = {
  id: string;
  user_id: string;
  status: BlockStatus;
  /** YYYY-MM-DD, always a Monday. */
  start_date: string;
  /** YYYY-MM-DD, always start + 34 days (week-5 Sunday). */
  end_date: string;
  goal_text: string;
  primary_lift: PrimaryLift | null;
  target_metric: TargetMetric | null;
  target_value: number | null;
  target_unit: string;
  /** Reserved-null in v1. v2 populates with calorie/macro targets. */
  diet_goal: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
};

// ── training_weeks ───────────────────────────────────────────────────────────

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
/** Session-type strings keyed in SESSION_PLANS, plus the literal "REST". */
export type SessionPlan = Partial<Record<Weekday, string>>;
/** Per-primary-lift intensity multipliers; missing keys default to 1.0. */
export type IntensityModifier = Partial<Record<PrimaryLift, number>>;

export type ResearchPhase = "accumulate" | "deload";
export type ProposedBy = "coach" | "user";

export type TrainingWeek = {
  id: string;
  user_id: string;
  block_id: string | null;
  /** YYYY-MM-DD, always a Monday (UTC). */
  week_start: string;
  session_plan: SessionPlan;
  /** Snapshot of session_plan at the moment of the first mid-week edit. NULL on
   *  rows that have never been edited (the common case). Set by the /swap
   *  endpoint on first mutation; never updated thereafter. Reset to NULL when an
   *  identity-restore swap returns session_plan to the original state.
   *  Adherence reads `coalesce(original_session_plan, session_plan)`. */
  original_session_plan: SessionPlan | null;
  weekly_focus: string | null;
  intensity_modifier: IntensityModifier;
  rir_target: number | null;
  research_phase: ResearchPhase | null;
  proposed_by: ProposedBy;
  chat_message_id: string | null;
  committed_at: string;
  created_at: string;
  updated_at: string;
};

// ── chat mode (extends existing ChatMessageRow) ──────────────────────────────

export type ChatMode = "default" | "plan_week" | "setup_block" | "intake";

// ── body_measurements ────────────────────────────────────────────────────────

/** Row shape for `body_measurements`. All circumference fields are nullable
 *  to permit partial entry. `photo_path` is a Supabase Storage object key in
 *  the `health-photos` bucket. */
export type BodyMeasurement = {
  id: string;
  user_id: string;
  measured_on: string; // YYYY-MM-DD
  neck_cm: number | null;
  left_upper_arm_cm: number | null;
  right_upper_arm_cm: number | null;
  chest_cm: number | null;
  high_waist_cm: number | null;
  mid_waist_cm: number | null;
  low_waist_cm: number | null;
  hips_cm: number | null;
  left_thigh_cm: number | null;
  left_thigh_min_cm: number | null;
  right_thigh_cm: number | null;
  right_thigh_min_cm: number | null;
  left_calf_cm: number | null;
  right_calf_cm: number | null;
  photo_path: string | null;
  notes: string | null;
  created_at: string;
};

/** Field key list — the 14 circumference columns, in display order
 *  (Upper → Core → Lower). Used by the form modal, the latest-measurement
 *  table, and the trend config. */
export const BODY_MEASUREMENT_FIELDS = [
  "neck_cm",
  "left_upper_arm_cm",
  "right_upper_arm_cm",
  "chest_cm",
  "high_waist_cm",
  "mid_waist_cm",
  "low_waist_cm",
  "hips_cm",
  "left_thigh_cm",
  "left_thigh_min_cm",
  "right_thigh_cm",
  "right_thigh_min_cm",
  "left_calf_cm",
  "right_calf_cm",
] as const;

export type BodyMeasurementField = (typeof BODY_MEASUREMENT_FIELDS)[number];

// ── Athlete profile (Phase 1) ────────────────────────────────────────────────

export type AthleteProfileStatus = "draft" | "active" | "superseded" | "discarded";

/** Phase 1 intake_payload shape. Phase 2 will add `goal_narrative_chat`,
 *  `coaching_preferences`, and `free_form_constraints` slots populated by the
 *  chat mode; those keys are reserved-absent in Phase 1.
 *
 *  Schema is snake_case to mirror what gets stored in Postgres jsonb.
 *  `schema_version` discriminates future migrations of this shape. */
export type IntakePayload = {
  schema_version: 1 | 2;
  health: {
    conditions: {
      cardiac: boolean;
      hypertension: boolean;
      diabetes: "none" | "type1" | "type2" | "prediabetic";
      autoimmune: boolean;
      joint_surgeries: Array<{ joint: string; year: number; notes?: string }>;
      other: string;
    };
    medications: string;
    recent_illness_injury: string;
    active_injuries: Array<{ joint: string; restriction: string }>;
    allergies: string;
    glp1_status?: {
      medication: "semaglutide" | "tirzepatide" | "compounded";
      dose_mg: number;
      injection_day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
      injection_time: "morning" | "evening" | "night";
      started_on: string;                  // ISO YYYY-MM-DD
      expected_taper_start: string | null;
      expected_end: string | null;
      doctor_protocol_notes: string | null;
    } | null;
  };
  training: {
    years_lifting: number;
    training_age: "beginner" | "intermediate" | "advanced";
    sessions_per_week: number;
    typical_session_minutes: number;
    equipment: {
      barbell: boolean;
      rack: boolean;
      bench: boolean;
      dumbbells: boolean;
      cables: boolean;
      machines: boolean;
      platform: boolean;
      ghd: boolean;
      sled: boolean;
      treadmill: boolean;
      rower: boolean;
      bike: boolean;
      kettlebells: boolean;
      bands: boolean;
      other: string;
    };
    current_e1rm: {
      squat: number | null;
      bench: number | null;
      deadlift: number | null;
      ohp: number | null;
    };
    best_ever_pr: {
      squat: number | null;
      bench: number | null;
      deadlift: number | null;
      ohp: number | null;
    };
    previous_programs: string;
    recent_plateaus: string;
  };
  lifestyle: {
    job_demands: "sedentary" | "mixed" | "active" | "labor";
    commute_minutes: number;
    has_dependents: boolean;
    dependent_notes: string;
    stress_self_rating: 1 | 2 | 3 | 4 | 5;
    days_available: {
      mon: boolean;
      tue: boolean;
      wed: boolean;
      thu: boolean;
      fri: boolean;
      sat: boolean;
      sun: boolean;
    };
    earliest_session_time: string; // "HH:mm"
    latest_session_time: string; // "HH:mm"
    travel_frequency: "none" | "rare" | "monthly" | "weekly";
  };
  nutrition: {
    current_phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
    current_kcal: number;
    current_macros: { protein_g: number; carb_g: number; fat_g: number };
    tracking_experience: "none" | "on_off" | "consistent";
    restrictions: string;
    alcohol_drinks_per_week: number;
    caffeine_mg_per_day: number;
    supplements: string;
  };
  sleep_recovery: {
    avg_sleep_hours: number;
    typical_bedtime: string; // "HH:mm"
    typical_wake_time: string; // "HH:mm"
    sleep_latency_minutes: number;
    awakenings: "none" | "1_2" | "3_plus";
    mobility_work: string;
    soreness_frequency: "rare" | "common" | "always";
    // NEW Phase 2 field — populated by Beat 4 chat
    chronotype?: "lark" | "neutral" | "owl";
  };
  goals: {
    primary_type: "strength" | "body_comp" | "performance" | "health";
    primary_metric: string;
    target_value: number;
    target_unit: string;
    target_date: string; // "YYYY-MM-DD"
    why_narrative: string;
  };

  // ── New in Phase 2 (optional; populated by chat) ─────────────────────────
  goal_narrative_chat?: string;

  coaching_preferences?: {
    directness: "blunt" | "balanced" | "softer";
    cadence: "daily" | "weekly" | "on_demand";
    unprompted_actions: Array<
      "suggest_revisions" | "nudge_on_drift" | "flag_macros" | "flag_sleep"
    >;
  };

  free_form_constraints?: string;

  sanity_overrides?: {
    goal_kept_despite_low_target?: boolean;
    sleep_efficiency_acknowledged?: boolean;
    macros_gap_acknowledged?: boolean;
    protein_floor_acknowledged?: boolean;
  };
};

// ── Sanity-check finding from plan-builder (Beat 1 input) ───────────────────
export type SanityFinding =
  | {
      type: "goal_contradiction";
      current_e1rm: number;
      target_value: number;
      proposed_target: number;
      target_unit: string;
      lift: "squat" | "bench" | "deadlift" | "ohp";
      months_to_target: number;
      rationale: string;
    }
  | {
      type: "sleep_efficiency";
      time_in_bed_h: number;
      avg_sleep_h: number;
      current_efficiency: number;
      proposed_bedtime: string;
      rationale: string;
    }
  | {
      type: "macros_gap";
      target_kcal: number;
      actual_7d_kcal: number;
      gap_pct: number;
      options: Array<"match_actual" | "hit_target">;
      rationale: string;
    }
  | {
      type: "protein_floor";
      current_protein_g: number;
      current_per_kg_bw: number;
      floor: 1.6;
      bodyweight: number;
      proposed_protein_g: number;
      proposed_fat_g: number;
      rationale: string;
    };

// ── PlanPayload — Phase 2 prescribed coaching plan jsonb ────────────────────

export type PlanPayload = {
  schema_version: 1;

  athlete_snapshot: {
    name: string | null;
    age: number | null;
    height_cm: number | null;
    training_age: "beginner" | "intermediate" | "advanced";
    derived_at: string;       // ISO timestamp
  };

  goal: {
    type: "strength" | "body_comp" | "performance" | "health";
    primary_metric: string;
    target_value: number;
    target_unit: string;
    target_date: string;
    narrative_summary: string;
    feasibility_note: string | null;
  };

  periodization: {
    block_length_weeks: number;
    blocks_to_goal_date: number;
    deload_cadence_weeks: number;
    rir_arc: Array<{ week: number; rir: number | null }>;
    rotation_rule: "fixed_split" | "rotate_primary" | "specialization";
  };

  strength: {
    sessions_per_week: number;
    day_pattern: { [weekday: string]: string };
    template_session_types: Array<
      "Chest" | "Legs" | "Back" | "Mobility" | "REST"
    >;
    weekly_volume_targets: {
      [primary_lift: string]: { reps_per_week: number; sets_per_week: number };
    };
    progression_rule: string;
    notes: string | null;
  };

  nutrition: {
    phase: "cut" | "maintain" | "lean_bulk" | "recomp";
    kcal_target: number;
    kcal_range: [number, number];
    protein_g_per_kg_bw: number;
    protein_g: number;
    carb_g: number;
    fat_g: number;
    training_day_uplift: { kcal: number; carb_g: number } | null;
    refeed_cadence_days: number | null;
    refeed_uplift: { kcal: number; carb_g: number } | null;
    hard_rules: {
      alcohol_policy: "none" | "training_day_only" | "weekend_allowed";
      caffeine_cap_mg_per_day: number;
      caffeine_last_dose_hours_before_bed: number;
      tracking_tolerance_missed_days_per_week: number;
    };
    notes: string | null;

    glp1: {
      medication: "semaglutide" | "tirzepatide" | "compounded";
      dose_mg: number;
      injection_day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
      injection_time: "morning" | "evening" | "night";
      started_on: string;
      expected_taper_start: string | null;
      taper_started_on: string | null;
      expected_end: string | null;
      deficit_alarm_pct: number;
      deficit_alarm_kcal: number;
      protein_g_per_kg_bw: number;
      per_meal_protein_floor_g: number;
      hydration_training_day_ml: number;
      sodium_training_day_mg: number;
      tdee_estimate_kcal: number;        // cached at composer time
    } | null;

    classical_phases: Array<{
      start_week: number;
      end_week: number;
      mode: "cut" | "diet_break" | "reverse" | "maintain";
      kcal: number;
      protein_g: number;
      carb_g: number;
      fat_g: number;
      rationale: string;
    }> | null;

    rest_day_delta: {
      kcal: number;
      carb_g: number;
      fat_g: number;
    } | null;
  };

  sleep: {
    chronotype: "lark" | "neutral" | "owl";
    target_hours_min: number;
    target_hours_max: number;
    wake_target: string;
    bedtime_target: string;
    efficiency_target: number;
    latency_target_min: number;
    hygiene_rules: {
      caffeine_cutoff_hours_before_bed: number;
      alcohol_cutoff_hours_before_bed: number;
      last_meal_cutoff_hours_before_bed: number;
      screen_cutoff_minutes_before_bed: number;
      intense_exercise_cutoff_hours_before_bed: number;
      morning_light_exposure_minutes: number;
      weekend_consistency_within_minutes: number;
    };
    concern_triggers: {
      avg_sleep_below_h: number;
      efficiency_below: number;
      latency_above_min: number;
      consecutive_short_nights: number;
    };
  };

  recovery: {
    mobility_minutes_per_week: number;
    deload_triggers: string[];
    reactivity_protocol: string;
  };

  coaching_agreement: {
    cadence: "daily" | "weekly" | "on_demand";
    directness: "blunt" | "balanced" | "softer";
    unprompted_actions_allowed: string[];
    re_evaluation_cadence_weeks: number;
  };
};

/** Row mirror of public.athlete_profile_documents. */
export type AthleteProfileDocument = {
  id: string;
  user_id: string;
  version: number;
  status: AthleteProfileStatus;
  intake_payload: IntakePayload;
  plan_payload: PlanPayload | null; // populated in Phase 2
  rendered_md: string | null;
  acknowledged_at: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
};

// ── Morning brief (extends 0007_morning_intake via 0011_morning_brief) ───────

export type MorningBriefVariant = "training" | "rest";

export type MorningBriefExercise = {
  name: string;            // "Squat (Barbell)"
  sets: number;            // 3
  reps: number;            // 6
  kg: number | null;       // 62.5 for prescribed lifts; null for bodyweight/duration
  note?: string;           // "Do BEFORE Incline DB" or undefined
  /** Minimum non-zero loadable increment for this exercise (e.g., 2.5 for barbell,
   *  2 for dumbbells). Present only when the exercise has increment metadata.
   *  Surfaced in the AI advice prompt so the coach recommends valid progressions. */
  min_increment_kg?: number;
};

export type MorningBriefRecap = {
  yesterday_date: string;                // "YYYY-MM-DD"
  sleep_hours: number | null;
  kcal_actual: number | null;
  kcal_target: number;
  protein_actual_g: number | null;
  protein_target_g: number;
  trained_yesterday: string | null;      // "Legs" | "REST" | null
  top_e1rm_yesterday: { lift: string; kg: number } | null;
};

export type MorningBriefMacros = {
  kcal_target: number;
  protein_target_g: number;
  carb_target_g: number;
  fat_target_g: number;
};

export type MorningBriefReadiness = {
  score: number | null;                       // 1-10 from checkins.readiness
  hrv: number | null;                         // from daily_logs[today].hrv
  recovery: number | null;                    // 0-100 from daily_logs[today].recovery
  band: "low" | "moderate" | "high";          // derived from score + hrv vs baselines
};

export type MorningBriefTonight = {
  sleep_target_hours: number;
  bedtime_target: string;                     // "HH:mm"
};

export type MorningBriefHydration = {
  water_ml: number;
  sodium_mg: number;
  /** Context note explaining the hydration recommendation. */
  note: string;
};

export type MorningBriefCard = {
  variant: MorningBriefVariant;
  readiness: MorningBriefReadiness;
  recap: MorningBriefRecap;
  session: {
    type: string;                             // "Legs" | "Chest" | "Back" | "Mobility" | "REST"
    start_time: string | null;                // "13:00" for training; null for rest
    exercises: MorningBriefExercise[];        // empty for rest
  };
  /** Present when GLP-1 mode is active and today is a training day.
   *  Rendered above the Macros section. null/undefined otherwise. */
  hydration?: MorningBriefHydration | null;
  macros: MorningBriefMacros;
  advice_md: string;                          // AI-generated 2-4 sentences markdown
  /** Deterministically set by lib/morning/brief/assembler.ts when band='low'
   *  AND today's session is non-REST/non-Mobility AND a training_weeks row
   *  exists for this week. Renders as a yellow chip below BriefTonight. The
   *  "acknowledged" state (after the user taps Swap) is derived client-side
   *  from training_weeks.session_plan[today] !== card.session.type — the jsonb
   *  in chat_messages.ui is NEVER rewritten on swap.
   *
   *  By the time the chip renders the acknowledged state, the swap has already
   *  mutated `session_plan`, so the inequality is the correct signal — clients
   *  do NOT need to compare against `original_session_plan`. */
  coach_suggestion: MorningBriefCoachSuggestion;
  tonight: MorningBriefTonight;
};

/** Computed deterministically by lib/morning/brief/flags.ts. Passed to the
 *  AI prompt as named booleans so coaching logic stays in versioned TS code,
 *  not in a prompt string. Each flag is one threshold check or regex match. */
export type AdviceFlags = {
  /** Structured GLP-1 flag. `active` mirrors the old `has_glp1` boolean;
   *  the additional fields carry mode + 7-day deficit state from TodayTargets
   *  so the Advice prompt can branch without re-querying daily_logs. */
  glp1: {
    active: boolean;
    medication: string | null;
    dose_mg: number | null;
    /** Resolved nutrition mode from TodayTargets. null when no active profile. */
    mode: ResolvedNutritionMode | null;
    /** True when the 7-day rolling deficit exceeds the GLP-1 alarm threshold. */
    deficit_alarm_triggered: boolean;
    /** Rolling 7-day average deficit in kcal/day; null when insufficient data. */
    rolling_7d_avg_deficit: number | null;
  };
  alcohol_low_readiness_warning: boolean;
  has_active_injuries: boolean;
  poor_sleep_efficiency: boolean;
  missed_protein_yesterday: boolean;
  /** True when MorningBriefCard.coach_suggestion?.kind === 'swap_to_mobility'.
   *  Tells the advice-prompt that a swap chip is visible — prose should
   *  explain WHY (signals fired), not re-decide WHETHER to swap, and should
   *  drop workout-anchored eating timing. */
  coach_swap_suggested: boolean;
};

// ── Schedule flexibility (migration 0012) ────────────────────────────────────

export type SwapAction = "swap" | "replace";

export type SwapConflict = {
  /** The day with the new placement that conflicts. */
  day: Weekday;
  /** The adjacent day (day ± 1) causing the conflict. */
  neighbor_day: Weekday;
  /** The session type that would be duplicated across two adjacent days. */
  session_type: string;
};

export type SwapBody =
  | { action: "swap"; source_day: Weekday; target_day: Weekday }
  | { action: "replace"; source_day: Weekday; session_type: string };

export type SwapResult = {
  week: TrainingWeek;
  swap: {
    source_day: Weekday;
    action: SwapAction;
    /** Session type at source_day before the operation. */
    before: string;
    /** Session type at source_day after the operation. For action='swap',
     *  this is the previous target_day value. */
    after: string;
  };
};

/** Structured 409 response body returned by `POST /api/training-weeks/[week_start]/swap`
 *  when conflicts are detected and the client did NOT pass `?confirm=true`. Not an
 *  exception — clients receive this as the JSON body of a 4xx response and use it to
 *  populate the warning UI. The mutation hook re-throws it as a `SwapErrorWithPreview`
 *  for ergonomic consumer handling (see Task 6). */
export type SwapConflictResponse = {
  conflicts: SwapConflict[];
  /** The plan that would be written if the client retries with ?confirm=true. */
  preview_plan: SessionPlan;
};

// ── Morning brief coach_suggestion (consumed by Schedule flexibility) ────────

export type MorningBriefCoachSuggestion =
  | { kind: "swap_to_mobility"; rationale: "low_readiness" }
  | null;

// ── GLP-1-aware nutrition helper types ──────────────────────────────────────

export type Glp1Config = NonNullable<PlanPayload["nutrition"]["glp1"]>;
export type Glp1Status = NonNullable<IntakePayload["health"]["glp1_status"]>;
export type PhaseStep = NonNullable<PlanPayload["nutrition"]["classical_phases"]>[number];
export type RestDayDelta = NonNullable<PlanPayload["nutrition"]["rest_day_delta"]>;
export type ResolvedNutritionMode = "glp1_active" | "glp1_tapering" | "classical" | "steady_state";
