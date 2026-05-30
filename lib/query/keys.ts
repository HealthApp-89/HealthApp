// lib/query/keys.ts

/**
 * Centralised query-key factory. Always import from here — never inline
 * key arrays. Keeps invalidation safe (e.g. `queryClient.invalidateQueries({
 * queryKey: queryKeys.dailyLogs.all(userId) })` evicts every range without
 * having to know what the consumers did with `from`/`to`).
 *
 * Hierarchy: ["entity", userId, ...sub-args]
 */
export const queryKeys = {
  dailyLogs: {
    all: (userId: string) => ["daily-logs", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["daily-logs", userId, "range", from, to] as const,
    /** Narrow column projection used by /trends — only the 6 charted metrics
     *  + date. Separate cache key from `range` because the result shape is
     *  smaller (Pick<DailyLog, ...>), not the full `DailyLog`. */
    trend: (userId: string, from: string, to: string) =>
      ["daily-logs", userId, "trend", from, to] as const,
    single: (userId: string, date: string) =>
      ["daily-logs", userId, "single", date] as const,
    latestWeight: (userId: string, before: string) =>
      ["daily-logs", userId, "latest-weight", before] as const,
    last7: (userId: string, before: string) =>
      ["daily-logs", userId, "last7", before] as const,
  },
  bodyMeasurements: {
    all: (userId: string) => ["body-measurements", userId] as const,
  },
  healthTrend: {
    range: (userId: string, from: string, to: string) =>
      ["health-trend", userId, from, to] as const,
  },
  profile: {
    one: (userId: string) => ["profile", userId] as const,
  },
  checkin: {
    one: (userId: string, date: string) => ["checkin", userId, date] as const,
    range: (userId: string, from: string, to: string) =>
      ["checkin", userId, "range", from, to] as const,
  },
  intakeState: {
    one: (userId: string, day: string) => ["intake-state", userId, day] as const,
  },
  symptomLog: {
    list: (userId: string, limit: number) =>
      ["symptom-log", userId, limit] as const,
  },
  unreadCounts: {
    all: () => ["unread-counts"] as const,
  },
  workouts: {
    all: (userId: string) => ["workouts", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["workouts", userId, "range", from, to] as const,
  },
  userSessionTemplates: {
    all: (userId: string) => ["user-session-templates", userId] as const,
    one: (userId: string, sessionType: string) =>
      ["user-session-templates", userId, sessionType] as const,
  },
  previousSet: {
    one: (userId: string, exerciseName: string, setIndex: number, excludeId: string | null) =>
      ["previous-set", userId, exerciseName.trim().toLowerCase(), setIndex, excludeId ?? "none"] as const,
  },
  tokens: {
    whoop: (userId: string) => ["tokens", userId, "whoop"] as const,
    withings: (userId: string) => ["tokens", userId, "withings"] as const,
    ingest: (userId: string) => ["tokens", userId, "ingest"] as const,
  },
  insights: {
    strength: (userId: string) => ["insights", userId, "strength"] as const,
  },
  trainingWeeks: {
    one: (userId: string, weekStart: string) =>
      ["training-weeks", userId, "one", weekStart] as const,
    range: (userId: string, from: string, to: string) =>
      ["training-weeks", userId, "range", from, to] as const,
  },
  blockProgress: {
    active: (userId: string) => ["block-progress", userId, "active"] as const,
  },
  blockOutcome: (blockId: string) => ["block-outcome", blockId] as const,
  recentE1RMs: {
    one: (userId: string, today: string) =>
      ["recent-e1rms", userId, today] as const,
  },
  activeNudges: {
    all: (userId: string) => ["activeNudges", userId] as const,
    byUser: (userId: string) => ["activeNudges", userId] as const,
  },
  athleteProfile: {
    /** Active acknowledged version for this user (status='active'). */
    active: (userId: string) => ["athlete-profile", userId, "active"] as const,
    /** All non-discarded versions for this user, ordered version desc. */
    history: (userId: string) => ["athlete-profile", userId, "history"] as const,
    /** Current draft, if any (status='draft'). */
    draft: (userId: string) => ["athlete-profile", userId, "draft"] as const,
    /** Single document by id (used by ViewModal for any version). */
    one: (userId: string, id: string) => ["athlete-profile", userId, "one", id] as const,
    /** Wide invalidation prefix — use after any write. */
    all: (userId: string) => ["athlete-profile", userId] as const,
  },
  labAcks: {
    one: (userId: string) => ["labAcks", userId] as const,
  },
  coachRecent: {
    list: (userId: string) => ["coach-recent", userId] as const,
  },
  morningBrief: {
    /** Today's morning_brief chat_messages row (the `ui` MorningBriefCard
     *  payload) for a (user, day). Surfaced by the TodayAnchor on /coach. */
    today: (userId: string, day: string) =>
      ["morning-brief", userId, "today", day] as const,
  },
  muscleVolume: {
    all: (userId: string) => ["muscleVolume", userId] as const,
    snapshot: (userId: string, today: string) =>
      ["muscleVolume", userId, "snapshot", today] as const,
  },
  weeklyReviews: {
    all: (userId: string) => ["weeklyReviews", userId] as const,
    one: (userId: string, weekStart: string) =>
      ["weeklyReviews", userId, "one", weekStart] as const,
  },
  coachTrends: {
    all: (userId: string) => ["coachTrends", userId] as const,
    one: (userId: string) => ["coachTrends", userId, "current"] as const,
  },
  blockHistory: {
    all: (userId: string) => ["blockHistory", userId] as const,
    one: (userId: string) => ["blockHistory", userId, "current"] as const,
  },
  recoveryIntelligence: {
    all: (userId: string) => ["recoveryIntelligence", userId] as const,
    one: (userId: string) => ["recoveryIntelligence", userId, "current"] as const,
  },
  peterDashboard: {
    all: (userId: string) => ["peterDashboard", userId] as const,
    latest: (userId: string, date: string) =>
      ["peterDashboard", userId, "latest", date] as const,
  },
  foodEntries: {
    all: (userId: string) => ["food-entries", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["food-entries", userId, "range", from, to] as const,
  },
  todayTargets: {
    all: (userId: string) => ["today-targets", userId] as const,
    byDate: (userId: string, date: string) =>
      ["today-targets", userId, date] as const,
  },
  foodLibrary: {
    all: (userId: string) => ["food-library", userId] as const,
    sections: (userId: string, slot: string | null, q: string) =>
      ["food-library", userId, "sections", slot ?? "no-slot", q] as const,
  },
  foodItemFavorites: {
    all: (userId: string) => ["food-item-favorites", userId] as const,
  },
  foodHistory: {
    all: (userId: string) => ["food-history", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["food-history", userId, "range", from, to] as const,
  },
  userFoodItems: {
    all: (userId: string) => ["user-food-items", userId] as const,
    search: (userId: string, q: string) =>
      ["user-food-items", userId, "search", q] as const,
    recent: (userId: string) => ["user-food-items", userId, "recent"] as const,
  },
} as const;
