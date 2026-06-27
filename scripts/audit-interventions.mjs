// scripts/audit-interventions.mjs
//
// Read-only audit for the coach_interventions table. Asserts the core
// invariants of the Coach Responsiveness Memory feature (Phase 3).
//
// Assertions:
//   (a) CORE INVARIANT: no reactive_deload row has context.block_phase === "deload_week".
//       A planned deload must never be recorded as a reactive intervention.
//   (b) Every row with outcome_evaluated_at set has a schema-valid outcome
//       (parsed against the Task 1 Zod outcome schemas).
//   (c) No surviving duplicate explicit+inferred rows for the same (kind, ±7d).
//       Verifies the cron dedup held: if a later inferred row sits within ±7d of
//       an explicit row with the same kind, the dedup contract was violated.
//
// Also prints:
//   - Per-kind summary table (total / explicit / inferred / evaluated / success)
//   - "Would surface to coach" count (evaluated rows with success ∈ {true, false})
//
// Run via:
//   AUDIT_USER_ID=<uuid> node \
//     --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types \
//     --env-file=.env.local \
//     scripts/audit-interventions.mjs
//
// NOTE: Never writes — always read-only.

import { createClient } from "@supabase/supabase-js";

// ── Env guard ─────────────────────────────────────────────────────────────────

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  console.error("Usage: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-interventions.mjs");
  process.exit(1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

// ── Import Zod outcome schemas (lazy — handles table-missing gracefully) ──────

let DeloadOutcomeSchema, SwapOutcomeSchema, NutritionOutcomeSchema;
try {
  const types = await import("@/lib/coach/interventions/types.ts");
  DeloadOutcomeSchema   = types.DeloadOutcomeSchema;
  SwapOutcomeSchema     = types.SwapOutcomeSchema;
  NutritionOutcomeSchema = types.NutritionOutcomeSchema;
} catch (e) {
  console.warn("[warn] Could not import outcome schemas — assertion (b) will be skipped:", e.message);
}

// ── Assertion harness ─────────────────────────────────────────────────────────

let pass = 0, fail = 0;

function assert(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name, reason) {
  console.log(`  ~ ${name} [SKIPPED: ${reason}]`);
}

// ── Fetch rows ────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
console.log(`\naudit-interventions · user ${userId} · date ${today}\n`);

const { data: rows, error: fetchErr } = await supabase
  .from("coach_interventions")
  .select("*")
  .eq("user_id", userId)
  .order("started_on", { ascending: true });

if (fetchErr) {
  const isTableMissing =
    fetchErr.code === "42P01" ||                              // PostgreSQL relation-not-found
    (typeof fetchErr.code === "string" && fetchErr.code.startsWith("PGRST")) || // PostgREST schema-cache miss (e.g. PGRST205)
    fetchErr.message?.includes("does not exist") ||
    fetchErr.message?.includes("Could not find the table") ||
    fetchErr.message?.includes("relation");
  if (isTableMissing) {
    console.log("coach_interventions table not found (migration not yet applied) — all assertions skipped gracefully.");
    console.log("\n0 passed, 0 failed.\n");
    process.exit(0);
  }
  console.error("Unexpected error fetching coach_interventions:", fetchErr.message);
  process.exit(1);
}

if (!rows || rows.length === 0) {
  console.log("No coach_interventions rows for this user — nothing to audit.\n");
  console.log("0 passed, 0 failed.\n");
  process.exit(0);
}

console.log(`Fetched ${rows.length} row(s).\n`);

// ── Per-kind stats ─────────────────────────────────────────────────────────────

const kinds = ["reactive_deload", "exercise_swap", "nutrition_change"];
const stats = {};
for (const k of kinds) {
  stats[k] = { total: 0, explicit: 0, inferred: 0, evaluated: 0, success_true: 0, success_false: 0, success_null_after_eval: 0 };
}

for (const row of rows) {
  const s = stats[row.kind];
  if (!s) continue; // unknown kind — not our concern here
  s.total++;
  if (row.source === "explicit") s.explicit++;
  if (row.source === "inferred") s.inferred++;
  if (row.outcome_evaluated_at != null) {
    s.evaluated++;
    const success = row.outcome?.success;
    if (success === true)  s.success_true++;
    else if (success === false) s.success_false++;
    else s.success_null_after_eval++;
  }
}

console.log("## Per-kind summary\n");
console.log("  Kind               | total | explicit | inferred | evaluated | ✓ succ | ✗ fail | ~ null");
console.log("  -------------------|-------|----------|----------|-----------|--------|--------|-------");
for (const k of kinds) {
  const s = stats[k];
  const label = k.padEnd(18);
  console.log(
    `  ${label} |  ${String(s.total).padStart(4)} |     ${String(s.explicit).padStart(4)} |     ${String(s.inferred).padStart(4)} |      ${String(s.evaluated).padStart(4)} |   ${String(s.success_true).padStart(4)} |   ${String(s.success_false).padStart(4)} |  ${String(s.success_null_after_eval).padStart(4)}`
  );
}

const wouldSurface = rows.filter(
  (r) => r.outcome_evaluated_at != null && typeof r.outcome?.success === "boolean"
).length;
console.log(`\n  Would-surface-to-coach count (evaluated, success ∈ {true,false}): ${wouldSurface}`);

// ─────────────────────────────────────────────────────────────────────────────
// Assertion (a): NO reactive_deload row has context.block_phase === "deload_week"
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n## (a) Core invariant — reactive_deload never has block_phase=deload_week\n");

const deloadRows = rows.filter((r) => r.kind === "reactive_deload");
if (deloadRows.length === 0) {
  console.log("  (no reactive_deload rows — invariant holds vacuously)");
} else {
  const violators = deloadRows.filter((r) => r.context?.block_phase === "deload_week");
  assert(
    `${deloadRows.length} reactive_deload row(s): none with block_phase=deload_week`,
    violators.length === 0,
    violators.length > 0
      ? `${violators.length} violation(s): ids [${violators.map((v) => v.id).join(", ")}]`
      : undefined,
  );
  if (violators.length > 0) {
    for (const v of violators) {
      console.error(`    id=${v.id} started_on=${v.started_on} source=${v.source} block_phase=${v.context?.block_phase}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion (b): Every row with outcome_evaluated_at set has a schema-valid outcome
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n## (b) Outcome schema validity — evaluated rows parse against Task 1 schemas\n");

const evaluatedRows = rows.filter((r) => r.outcome_evaluated_at != null);
if (evaluatedRows.length === 0) {
  console.log("  (no evaluated rows yet — skipping schema check)");
} else if (!DeloadOutcomeSchema) {
  skip("outcome schema validity", "schemas not importable");
} else {
  const schemaMap = {
    reactive_deload:  DeloadOutcomeSchema,
    exercise_swap:    SwapOutcomeSchema,
    nutrition_change: NutritionOutcomeSchema,
  };

  let badCount = 0;
  const badRows = [];
  for (const row of evaluatedRows) {
    const schema = schemaMap[row.kind];
    if (!schema) {
      // Unknown kind — skip
      continue;
    }
    const parsed = schema.safeParse(row.outcome);
    if (!parsed.success) {
      badCount++;
      badRows.push({ id: row.id, kind: row.kind, started_on: row.started_on, errors: parsed.error.issues });
    }
  }

  assert(
    `${evaluatedRows.length} evaluated row(s): all have schema-valid outcomes`,
    badCount === 0,
    badCount > 0 ? `${badCount} schema-invalid row(s)` : undefined,
  );

  if (badRows.length > 0) {
    for (const b of badRows) {
      console.error(`    id=${b.id} kind=${b.kind} started_on=${b.started_on}`);
      for (const iss of b.errors) {
        console.error(`      • ${iss.path.join(".")} — ${iss.message}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion (c): No surviving duplicate explicit+inferred rows for same (kind, ±7d)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n## (c) Dedup integrity — no inferred row within ±7d of an explicit row (same kind)\n");

const DEDUP_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dateMs(iso) {
  return new Date(iso + "T00:00:00Z").getTime();
}

const explicitRows = rows.filter((r) => r.source === "explicit");
const inferredRows = rows.filter((r) => r.source === "inferred");

if (explicitRows.length === 0 || inferredRows.length === 0) {
  console.log("  (no explicit+inferred pair possible — dedup holds vacuously)");
} else {
  const dupViolations = [];

  for (const inf of inferredRows) {
    for (const exp of explicitRows) {
      if (exp.kind !== inf.kind) continue;
      const diffDays = Math.abs(dateMs(exp.started_on) - dateMs(inf.started_on)) / MS_PER_DAY;
      if (diffDays <= DEDUP_DAYS) {
        dupViolations.push({ explicit_id: exp.id, inferred_id: inf.id, kind: inf.kind, diff_days: Math.round(diffDays) });
      }
    }
  }

  assert(
    `No inferred row survives within ±${DEDUP_DAYS}d of an explicit row (same kind)`,
    dupViolations.length === 0,
    dupViolations.length > 0 ? `${dupViolations.length} dedup violation(s)` : undefined,
  );

  if (dupViolations.length > 0) {
    for (const v of dupViolations) {
      console.error(`    kind=${v.kind} explicit_id=${v.explicit_id} inferred_id=${v.inferred_id} diff=${v.diff_days}d`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
