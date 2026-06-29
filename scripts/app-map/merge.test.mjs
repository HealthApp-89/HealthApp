// scripts/app-map/merge.test.mjs
import assert from 'node:assert/strict';
import { buildTree } from './merge.mjs';

const facts = {
  routes: ['/', '/coach', '/ghost'],
  apiRoutes: ['/api/x'],
  coaches: [
    { id: 'peter', hasVoice: true, tools: ['A_TOOL', 'B_TOOL'] },
    { id: 'nora', hasVoice: true, tools: ['B_TOOL'] },
  ],
  migrations: ['0001_x.sql'],
};

const m = {
  id: 'root', label: 'r', description: 'd',
  children: [
    { id: 'team', label: 't', description: 'd', children: [
      { id: 'p', label: 'Peter', description: 'd', code: { coaches: ['peter'] } },
      { id: 'gone', label: 'Gone', description: 'd', code: { coaches: ['zzz'] } }, // stale
    ]},
    { id: 'uth', label: 'uth', description: 'd', code: { migrations: 'all' }, children: [
      { id: 'ur', label: 'routes', description: 'd', code: { routes: '*' } },
      { id: 'ut', label: 'tools', description: 'd', code: { tools: '*' } },
      // note: no apiRoutes:'*' node and nora not claimed -> undocumented
    ]},
  ],
};

const { tree, drift } = buildTree(m, facts);

// nora coach + /api/x apiRoute are claimed by nobody -> undocumented.
assert.ok(drift.undocumented.includes('coach:nora'), 'nora undocumented');
assert.ok(drift.undocumented.includes('apiRoute:/api/x'), 'api undocumented');
// routes & tools absorbed by '*' nodes -> not undocumented.
assert.ok(!drift.undocumented.some((x) => x.startsWith('route:')), 'routes absorbed');
assert.ok(!drift.undocumented.some((x) => x.startsWith('tool:')), 'tools absorbed');
// 'zzz' coach claimed but absent -> stale.
assert.ok(drift.stale.includes('coach:zzz'), 'zzz stale');

// '*' route node synthesized a child per route.
const uth = tree.children.find((c) => c.id === 'uth');
const ur = uth.children.find((c) => c.id === 'ur');
assert.equal(ur.children.length, 3, 'three route leaves');

// stale node carries a badge.
const team = tree.children.find((c) => c.id === 'team');
const gone = team.children.find((c) => c.id === 'gone');
assert.ok(gone.badges.includes('stale'), 'gone badged stale');

// Peter node resolved under-the-hood refs.
const p = team.children.find((c) => c.id === 'p');
assert.ok(p.underHood.some((x) => x.includes('peter')), 'peter underHood resolved');

// ── Regression: parent with migrations:'all' + child with migrations:'all'
//    Parent must delegate synthesis; total .sql leaves across tree == 2 (not 4).
{
  const facts2 = {
    routes: [],
    apiRoutes: [],
    coaches: [],
    migrations: ['0001_a.sql', '0002_b.sql'],
  };

  const m2 = {
    id: 'root2', label: 'root2', description: '',
    children: [
      {
        id: 'parent', label: 'parent', description: '',
        code: { migrations: 'all' },
        children: [
          {
            id: 'child-migs', label: 'child-migs', description: '',
            code: { migrations: 'all' },
          },
        ],
      },
    ],
  };

  const { tree: tree2 } = buildTree(m2, facts2);

  // Collect all .sql-labeled leaves across the entire tree.
  function collectSqlLeaves(node) {
    const acc = [];
    if (/\.sql$/.test(node.label)) acc.push(node.label);
    for (const ch of node.children ?? []) acc.push(...collectSqlLeaves(ch));
    return acc;
  }

  const allSqlLeaves = collectSqlLeaves(tree2);
  assert.equal(allSqlLeaves.length, 2, 'total sql leaves == 2 (no duplicates)');

  // Parent synthesizes 0 migration leaves (delegates to child).
  const parentNode = tree2.children.find((c) => c.id === 'parent');
  const parentDirectSqlLeaves = (parentNode.children ?? [])
    .filter((c) => /\.sql$/.test(c.label));
  assert.equal(parentDirectSqlLeaves.length, 0, 'parent synthesizes 0 migration leaves');

  // Child synthesizes exactly 2 migration leaves.
  const childNode = (parentNode.children ?? []).find((c) => c.id === 'child-migs');
  const childSqlLeaves = (childNode.children ?? []).filter((c) => /\.sql$/.test(c.label));
  assert.equal(childSqlLeaves.length, 2, 'child synthesizes exactly 2 migration leaves');
}

console.log('merge.test.mjs OK');
