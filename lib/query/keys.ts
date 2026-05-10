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
  },
  workouts: {
    all: (userId: string) => ["workouts", userId] as const,
    range: (userId: string, from: string, to: string) =>
      ["workouts", userId, "range", from, to] as const,
  },
  tokens: {
    whoop: (userId: string) => ["tokens", userId, "whoop"] as const,
    withings: (userId: string) => ["tokens", userId, "withings"] as const,
    ingest: (userId: string) => ["tokens", userId, "ingest"] as const,
  },
  insights: {
    daily: (userId: string, date: string) =>
      ["insights", userId, "daily", date] as const,
    strength: (userId: string) => ["insights", userId, "strength"] as const,
    weeklyReview: (userId: string, weekEnd: string) =>
      ["insights", userId, "weekly-review", weekEnd] as const,
  },
  recommendations: {
    week: (userId: string, weekStart: string) =>
      ["recommendations", userId, weekStart] as const,
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
} as const;
