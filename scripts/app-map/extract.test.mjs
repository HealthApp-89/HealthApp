// scripts/app-map/extract.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './extract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const r = extract(repoRoot);

// Routes: home + known pages present, route groups stripped, dynamic segments normalized.
assert.ok(r.routes.includes('/'), 'home route');
assert.ok(r.routes.includes('/coach'), '/coach route');
assert.ok(r.routes.includes('/coach/weeks/:week_start'), 'dynamic segment normalized');
assert.ok(!r.routes.some((x) => x.includes('(')), 'route groups stripped');
assert.ok(!r.routes.some((x) => x.includes('[')), 'no raw brackets');

// API routes.
assert.ok(r.apiRoutes.some((x) => x.startsWith('/api/')), 'has api routes');

// Coaches: all four, each with a detected voice and a non-empty tool list.
const ids = r.coaches.map((c) => c.id).sort();
assert.deepEqual(ids, ['carter', 'nora', 'peter', 'remi'], 'four coaches');
for (const c of r.coaches) {
  assert.ok(c.hasVoice, `${c.id} has voice`);
  assert.ok(c.tools.length > 0, `${c.id} has tools`);
  assert.ok(c.tools.every((t) => /_TOOL$/.test(t)), `${c.id} tool ids end in _TOOL`);
}
const peter = r.coaches.find((c) => c.id === 'peter');
assert.ok(peter.tools.includes('WORKOUTS_TOOL'), 'peter has WORKOUTS_TOOL');

// Migrations.
assert.ok(r.migrations.includes('0042_profile_timezone.sql'), 'known migration listed');
assert.ok(r.migrations.length >= 40, 'most migrations listed');

console.log('extract.test.mjs OK');
