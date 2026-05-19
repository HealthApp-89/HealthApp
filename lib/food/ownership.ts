// lib/food/ownership.ts
//
// Kill switch for in-app food logging's ownership of the daily_logs nutrition
// columns. Defaults to ON (the documented "in-app wins, Yazio is fallback"
// precedence from CLAUDE.md). Set FOOD_LOG_OWNS_DAILY_LOGS=false to revert
// to Yazio-as-primary while testing the meal-logging flow — food_log_entries
// rows still write, /meal still renders them, but daily_logs aggregation is
// skipped and Yazio is allowed to overwrite on the same date.

export function foodLogOwnsDailyLogs(): boolean {
  const v = process.env.FOOD_LOG_OWNS_DAILY_LOGS;
  if (v === undefined) return true;
  return v.toLowerCase() !== "false";
}
