// scripts/audit-peter-dashboard.mjs
//
// Dry-run generatePeterDashboard against current data. Reports per-theme
// severity + one_line, cluster detections, and verifies every numeric
// token in narrative_md exists in payload.facts. Roundtrips the
// injection block so the operator can eyeball what Peter actually reads.
//
// Usage:
//   AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//     --experimental-strip-types --env-file=.env.local \
//     scripts/audit-peter-dashboard.mjs

import { createSupabaseServiceRoleClient } from '../lib/supabase/server.ts';
import { generatePeterDashboard } from '../lib/coach/peter-dashboard/index.ts';
import { renderInjectionBlock } from '../lib/coach/peter-dashboard/render-injection.ts';

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error('AUDIT_USER_ID env var required');
  process.exit(1);
}

const sb = createSupabaseServiceRoleClient();
const today = new Date().toISOString().slice(0, 10);

console.log(`auditing peter dashboard for ${userId} on ${today}\n`);

const payload = await generatePeterDashboard({ supabase: sb, userId, today });

console.log('## themes\n');
for (const [k, t] of Object.entries(payload.facts.themes)) {
  console.log(`  ${k.padEnd(16)} [${t.severity.padEnd(6)}] ${t.one_line}`);
}

console.log('\n## clusters\n');
if (payload.facts.clusters.length === 0) console.log('  (none)');
for (const c of payload.facts.clusters) {
  console.log(`  ${c.id}: ${c.themes.join(' + ')}`);
  console.log(`    root: ${c.root_hypothesis}`);
}

console.log('\n## narrative status\n');
console.log(payload.narrative_failed
  ? '  FAILED — used deterministic fallback'
  : '  ok');

console.log('\n## fabrication check\n');
const allowed = collectAllowed(payload.facts);
const offenders = [];
const texts = [];
if (payload.narrative) {
  texts.push(payload.narrative.hero.headline, payload.narrative.hero.body_md);
  for (const card of Object.values(payload.narrative.cards)) {
    texts.push(card.narrative_md);
  }
}
for (const t of texts) {
  for (const tok of t.matchAll(/-?\d+(?:\.\d+)?/g)) {
    if (!allowed.has(tok[0])) offenders.push(tok[0]);
  }
}
if (offenders.length === 0) console.log('  no fabricated numerics');
else console.log(`  OFFENDERS: ${offenders.slice(0, 10).join(', ')}`);

console.log('\n## prompt block (what Peter sees)\n');
console.log(renderInjectionBlock(payload, today));

// Mirrors lib/coach/peter-dashboard/narrate.ts validator: only push the
// ×100 form when |v| <= 1 (avoids flooding the allow-list with bogus
// "percentage" tokens for already-percent values like 67 → "6700").
function collectAllowed(facts) {
  const out = new Set();
  const push = (v) => {
    if (typeof v === 'number') {
      out.add(String(v));
      out.add(String(Math.round(v)));
      out.add(String(Math.round(v * 10) / 10));
      out.add(String(Math.abs(v)));
      out.add(String(Math.round(Math.abs(v))));
      if (Math.abs(v) <= 1) {
        out.add(String(Math.round(v * 100)));
        out.add(String(Math.round(Math.abs(v) * 100)));
      }
    }
    if (typeof v === 'string') {
      for (const t of v.split(/[,\s]+/)) {
        const n = Number(t);
        if (Number.isFinite(n)) push(n);
      }
    }
  };
  for (const t of Object.values(facts.themes)) {
    for (const v of Object.values(t.facts)) push(v);
  }
  push(facts.block_context.block_number);
  push(facts.goal_summary.target);
  for (let i = 0; i <= 100; i++) out.add(String(i));
  return out;
}

process.exit(0);
