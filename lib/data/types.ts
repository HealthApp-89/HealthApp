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
  kind: "coach" | "morning_intake";
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
  | "delivered";

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
  // Action chip — client dispatches a side-effect (whoop_sync, skip_whoop, retry_recommendation)
  | { label: string; action: "whoop_sync" | "skip_whoop" | "retry_recommendation" };

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
