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
  name: "query_daily_logs" | "query_workouts" | "query_training_blocks" | "query_training_weeks" | "get_autoregulation_signals" | "compute_adherence" | "propose_block" | "commit_block" | "propose_week_plan" | "commit_week_plan";
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

export type ChatMode = "default" | "plan_week" | "setup_block";

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
  schema_version: 1;
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
  };
  goals: {
    primary_type: "strength" | "body_comp" | "performance" | "health";
    primary_metric: string;
    target_value: number;
    target_unit: string;
    target_date: string; // "YYYY-MM-DD"
    why_narrative: string;
  };
};

/** Row mirror of public.athlete_profile_documents. */
export type AthleteProfileDocument = {
  id: string;
  user_id: string;
  version: number;
  status: AthleteProfileStatus;
  intake_payload: IntakePayload;
  plan_payload: unknown | null; // populated in Phase 2
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

export type MorningBriefCard = {
  variant: MorningBriefVariant;
  readiness: MorningBriefReadiness;
  recap: MorningBriefRecap;
  session: {
    type: string;                             // "Legs" | "Chest" | "Back" | "Mobility" | "REST"
    start_time: string | null;                // "13:00" for training; null for rest
    exercises: MorningBriefExercise[];        // empty for rest
  };
  macros: MorningBriefMacros;
  advice_md: string;                          // AI-generated 2-4 sentences markdown
  tonight: MorningBriefTonight;
};

/** Computed deterministically by lib/morning/brief/flags.ts. Passed to the
 *  AI prompt as named booleans so coaching logic stays in versioned TS code,
 *  not in a prompt string. Each flag is one threshold check or regex match. */
export type AdviceFlags = {
  has_glp1: boolean;
  alcohol_low_readiness_warning: boolean;
  has_active_injuries: boolean;
  poor_sleep_efficiency: boolean;
  missed_protein_yesterday: boolean;
};
