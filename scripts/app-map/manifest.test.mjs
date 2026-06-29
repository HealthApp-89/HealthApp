import assert from 'node:assert/strict';
import { manifest } from './manifest.mjs';

const ids = new Set();
(function visit(n, depth) {
  assert.ok(n.id && typeof n.id === 'string', 'node has id');
  assert.ok(!ids.has(n.id), `id unique: ${n.id}`);
  ids.add(n.id);
  assert.ok(n.label && typeof n.label === 'string', `node ${n.id} has label`);
  assert.ok(n.description && typeof n.description === 'string', `node ${n.id} has description`);
  for (const c of n.children ?? []) visit(c, depth + 1);
})(manifest, 0);

// Six top-level branches, in guidebook order.
const top = manifest.children.map((c) => c.id);
assert.deepEqual(top, [
  'team', 'inputs', 'features', 'screens', 'how-it-decides', 'under-the-hood',
], 'six top-level branches in order');

// The four coaches are claimed somewhere.
const claimedCoaches = new Set();
(function collect(n) {
  for (const c of n.code?.coaches ?? []) claimedCoaches.add(c);
  for (const c of n.children ?? []) collect(c);
})(manifest);
assert.deepEqual([...claimedCoaches].sort(), ['carter', 'nora', 'peter', 'remi'], 'all coaches claimed');

// Under-the-hood branch claims migrations + all routes/api wholesale.
const uth = manifest.children.find((c) => c.id === 'under-the-hood');
assert.ok(uth.code?.migrations === 'all', 'under-the-hood claims migrations');

console.log('manifest.test.mjs OK');
