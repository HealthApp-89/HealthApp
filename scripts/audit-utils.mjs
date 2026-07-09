// scripts/audit-utils.mjs
//
// Shared reporter for the fixture-based (no-DB) audit scripts. Each script
// creates its own reporter; `summary()` prints totals and sets a non-zero
// exit code on any failure so CI/manual runs surface red.

export function createAuditReporter() {
  let pass = 0;
  let fail = 0;

  function assert(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else      { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  }

  function summary(label = "audit") {
    console.log(`\n${label}: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
    return { pass, fail };
  }

  return { assert, summary };
}
