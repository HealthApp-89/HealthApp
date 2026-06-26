# Living App-Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `npm run map`, which scans the repo and emits a single self-contained, clickable `docs/app-map.html` — a plain-language functional decomposition tree of Apex Health OS, kept honest by a drift check.

**Architecture:** Three plain ESM scripts under `scripts/app-map/`. `extract.mjs` mechanically reads structural facts from the codebase (routes, API endpoints, coach→tool arrays, coach voices, migrations) with `fs` + regex and zero app imports. `manifest.mjs` is a hand-curated, plain-English node tree. `build.mjs` joins the two by stable ids, runs a drift check (undocumented/stale), and renders a self-contained HTML viewer.

**Tech Stack:** Node ESM (`.mjs`), no new dependencies, no test framework — tests are `node:assert`-based scripts run with `node` (matches the repo's existing `scripts/audit-*.mjs` convention).

## Global Constraints

- No new npm dependencies. Node built-ins only (`node:fs`, `node:path`, `node:assert`, `node:url`).
- `extract.mjs` MUST NOT import any app code (no `lib/`, no Supabase, no Next). It only reads files as text.
- Plain, non-technical language in all manifest labels/descriptions for branches 1–5. Raw technical identifiers appear only in branch 6 and the faint per-node "under the hood" line.
- Self-contained HTML output: all CSS, JS, and tree JSON inlined into `docs/app-map.html`. Zero external network/asset references.
- Number/copy display is plain prose; no app UI helpers are involved (this is a standalone artifact).
- All paths below are relative to repo root `/Users/abdelouahedelbied/Health app`.

---

### Task 1: Mechanical extractor (`extract.mjs`)

**Files:**
- Create: `scripts/app-map/extract.mjs`
- Test: `scripts/app-map/extract.test.mjs`

**Interfaces:**
- Produces: `export function extract(repoRoot)` returning:
  ```
  {
    routes:     string[]   // e.g. ['/', '/coach', '/coach/weeks/:week_start']
    apiRoutes:  string[]   // e.g. ['/api/food/commit']
    coaches:    { id: string, hasVoice: boolean, tools: string[] }[]
                           // id ∈ 'peter'|'carter'|'nora'|'remi'; tools are *_TOOL identifiers
    migrations: string[]   // e.g. ['0042_profile_timezone.sql']
  }
  ```

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/app-map/extract.test.mjs`
Expected: FAIL — `Cannot find module './extract.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// scripts/app-map/extract.mjs
import fs from 'node:fs';
import path from 'node:path';

/** Recursively collect files named `target` under `dir`. */
function walk(dir, target, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
      walk(full, target, out);
    } else if (e.name === target) {
      out.push(full);
    }
  }
  return out;
}

/** Turn an app/ page.tsx path into a route. Strips route groups `(x)`,
 *  normalizes `[seg]` → `:seg`, collapses the trailing /page.tsx. */
function pageToRoute(appDir, file) {
  const rel = path.relative(appDir, path.dirname(file)); // '' for app/page.tsx
  const segments = rel.split(path.sep).filter(Boolean);
  const kept = [];
  for (const seg of segments) {
    if (seg.startsWith('(') && seg.endsWith(')')) continue; // route group
    if (seg.startsWith('[') && seg.endsWith(']')) {
      kept.push(':' + seg.slice(1, -1).replace(/^\.\.\./, '')); // [..rest] → :rest
    } else {
      kept.push(seg);
    }
  }
  return '/' + kept.join('/') === '/' && kept.length === 0 ? '/' : '/' + kept.join('/');
}

function apiPathOf(appDir, file) {
  const rel = path.relative(appDir, path.dirname(file));
  const segments = rel.split(path.sep).filter(Boolean).map((seg) =>
    seg.startsWith('[') && seg.endsWith(']') ? ':' + seg.slice(1, -1).replace(/^\.\.\./, '') : seg,
  );
  return '/' + segments.join('/');
}

/** Extract the *_TOOL identifiers inside `export const NAME...= [ ... ];`. */
function toolsInArray(source, constName) {
  const re = new RegExp(`export const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = source.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/([A-Z0-9_]+_TOOL)\b/g)].map((x) => x[1]);
}

export function extract(repoRoot) {
  const appDir = path.join(repoRoot, 'app');

  const pageFiles = walk(appDir, 'page.tsx');
  const routes = [...new Set(pageFiles.map((f) => pageToRoute(appDir, f)))].sort();

  const routeFiles = walk(appDir, 'route.ts').filter((f) => f.includes(`${path.sep}api${path.sep}`));
  const apiRoutes = [...new Set(routeFiles.map((f) => apiPathOf(appDir, f)))].sort();

  const toolsSrc = readSafe(path.join(repoRoot, 'lib', 'coach', 'tools.ts'));
  const promptsSrc = readSafe(path.join(repoRoot, 'lib', 'coach', 'system-prompts.ts'));
  const coachDefs = [
    ['peter', 'PETER_TOOLS', 'PETER_BASE'],
    ['carter', 'CARTER_TOOLS', 'CARTER_BASE'],
    ['nora', 'NORA_TOOLS', 'NORA_BASE'],
    ['remi', 'REMI_TOOLS', 'REMI_BASE'],
  ];
  const coaches = coachDefs.map(([id, toolsConst, baseConst]) => ({
    id,
    hasVoice: new RegExp(`export const ${baseConst}\\b`).test(promptsSrc),
    tools: toolsInArray(toolsSrc, toolsConst),
  }));

  const migDir = path.join(repoRoot, 'supabase', 'migrations');
  const migrations = (safeReaddir(migDir)).filter((f) => f.endsWith('.sql')).sort();

  return { routes, apiRoutes, coaches, migrations };
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/app-map/extract.test.mjs`
Expected: PASS — prints `extract.test.mjs OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/app-map/extract.mjs scripts/app-map/extract.test.mjs
git commit -m "feat(app-map): mechanical codebase extractor"
```

---

### Task 2: Curated manifest (`manifest.mjs`)

**Files:**
- Create: `scripts/app-map/manifest.mjs`
- Test: `scripts/app-map/manifest.test.mjs`

**Interfaces:**
- Produces: `export const manifest` — the root node. Node shape:
  ```
  { id, label, description, children?, code? }
  // code?: { coaches?: string[], routes?: string[], apiRoutes?: string[],
  //         tools?: string[], migrations?: 'all' }
  ```
  `id` is unique across the whole tree. `code` hints are how a node claims
  responsibility for extracted facts (consumed by the drift check in Task 3).

- [ ] **Step 1: Write the failing test**

```js
// scripts/app-map/manifest.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/app-map/manifest.test.mjs`
Expected: FAIL — `Cannot find module './manifest.mjs'`.

- [ ] **Step 3: Write the implementation**

Author the plain-language tree. Descriptions must read for a non-technical person. `code` hints reference the real extracted facts (note real routes are `/diet`, `/health`, `/coach`, `/strength`, `/profile`, `/onboarding`, `/` — NOT `/meal` or `/metrics`).

```js
// scripts/app-map/manifest.mjs
// Curated, plain-language decomposition tree. This is the human source of truth
// for MEANING. The build step joins `code` hints to mechanically-extracted facts
// and flags anything documented here but missing in code (stale) or present in
// code but claimed by no node (undocumented).

export const manifest = {
  id: 'root',
  label: 'Apex Health OS — your personal health & performance coach',
  description:
    'An app that gathers everything about your training, sleep, recovery, body and food into one place, then gives you a coaching team that tells you what to do each day.',
  children: [
    {
      id: 'team',
      label: 'Your coaching team',
      description:
        'Four coaches share one chat. You talk to all of them; your question is quietly handed to whichever one it belongs to.',
      children: [
        {
          id: 'coach-peter',
          label: 'Peter — your head coach',
          description:
            'The coach in charge. He sees the big picture, settles anything that spans several areas, sets your multi-week training blocks, and writes your morning summary and weekly review.',
          code: { coaches: ['peter'] },
        },
        {
          id: 'coach-carter',
          label: 'Carter — strength & conditioning',
          description:
            'Handles your workouts: which exercises, how heavy, how many sets, when to push and when to back off, plus your cardio/endurance sessions.',
          code: { coaches: ['carter'] },
        },
        {
          id: 'coach-nora',
          label: 'Nora — nutrition',
          description:
            'Handles food: how much to eat, your protein and macro targets, hydration, and your weight-loss-medication phase. You can log meals by chatting with her.',
          code: { coaches: ['nora'] },
        },
        {
          id: 'coach-remi',
          label: 'Remi — recovery & sleep',
          description:
            'Watches how rested you are: heart-rate variability versus your normal, sleep quality, training stress versus recovery, and early warning signs of illness.',
          code: { coaches: ['remi'] },
        },
      ],
    },
    {
      id: 'inputs',
      label: 'What you put in',
      description: 'Where the app gets its information — partly from your devices, partly from you.',
      children: [
        {
          id: 'inputs-devices',
          label: 'Your devices & apps',
          description:
            'Automatic feeds: your WHOOP strap (recovery, sleep, strain), your Withings scale (weight and body composition), Strava (rides, runs, swims), Apple Health via your Garmin watch (steps, calories, distance).',
        },
        {
          id: 'inputs-you',
          label: 'Things you tell it',
          description:
            'What you enter yourself: your morning check-in (how you feel, soreness, illness), meals you log, workouts you log, monthly body measurements, your goals and profile, and anything you say in chat.',
        },
      ],
    },
    {
      id: 'features',
      label: 'What it does for you',
      description: 'The coaching things the app produces from all that information.',
      children: [
        { id: 'feat-brief', label: 'Morning brief', description: 'A short daily card: yesterday recap, how ready you are today, today’s session or rest, your food targets, a coaching tip, and tonight’s sleep goal.' },
        { id: 'feat-weekly-review', label: 'Weekly review', description: 'A Sunday recap of the week and a plan for the next one, which you confirm.' },
        { id: 'feat-weekly-plan', label: 'Weekly plan', description: 'Your committed training week — which session falls on which day, with the right weights worked out for you.' },
        { id: 'feat-dashboard', label: 'Daily dashboard', description: 'Peter’s once-a-day read of how your goals, energy, fatigue and progress fit together.' },
        { id: 'feat-trends', label: 'Trends', description: 'Longer-term patterns in strength, body composition, nutrition and recovery.' },
        { id: 'feat-nudges', label: 'Nudges', description: 'The coach reaching out on its own when something needs attention — a stall, falling behind a target, or recovery dropping.' },
        { id: 'feat-food-log', label: 'Food logging', description: 'Log meals by typing, scanning a barcode, or chatting with Nora; she works out the calories and macros.' },
        { id: 'feat-workout-log', label: 'Workout logging', description: 'Log lifts set by set in the app, with a rest timer and voice entry, instead of a separate app.' },
        { id: 'feat-endurance', label: 'Endurance training', description: 'Cardio training built around heart-rate zones and training load, fed by Strava.' },
        { id: 'feat-glp1', label: 'Medication-aware nutrition', description: 'Nutrition that adjusts while you’re on weight-loss medication — higher protein, no diet breaks — and switches back afterward.' },
      ],
    },
    {
      id: 'screens',
      label: 'Where you go',
      description: 'The screens in the app and what each one is for.',
      children: [
        { id: 'screen-home', label: 'Home', description: 'Your daily readiness view at a glance.', code: { routes: ['/'] } },
        { id: 'screen-diet', label: 'Meals', description: 'Your food journal, meal by meal.', code: { routes: ['/diet'] } },
        { id: 'screen-health', label: 'Metrics & log', description: 'Your numbers — recovery, sleep, body — and the place to enter or correct them by hand.', code: { routes: ['/health'] } },
        { id: 'screen-coach', label: 'Coach', description: 'Chat with the coaching team and see Peter’s dashboard.', code: { routes: ['/coach'] } },
        { id: 'screen-strength', label: 'Strength', description: 'Today’s session and your lifting plan.', code: { routes: ['/strength'] } },
        { id: 'screen-profile', label: 'Profile', description: 'Your goals, settings, device connections and food library.', code: { routes: ['/profile'] } },
        { id: 'screen-onboarding', label: 'Onboarding', description: 'The first-time setup that captures your history and goals.', code: { routes: ['/onboarding'] } },
      ],
    },
    {
      id: 'how-it-decides',
      label: 'How it decides',
      description: 'The thinking behind the advice, in plain terms.',
      children: [
        { id: 'decide-readiness', label: 'Readiness score', description: 'Combines recovery, sleep and strain into a single “how ready are you today” band that shapes the day’s plan.' },
        { id: 'decide-prescription', label: 'How weights are chosen', description: 'A fixed set of rules — not guesswork by the coach — picks each session’s weights from your recent lifts and where you are in the block.' },
        { id: 'decide-today', label: 'What counts as “today”', description: 'Everything is anchored to your timezone, so a workout at midnight lands on the right day.' },
        { id: 'decide-ownership', label: 'Which source wins', description: 'When two devices report the same thing, the more accurate one wins — e.g. steps come from your watch, not your scale.' },
      ],
    },
    {
      id: 'under-the-hood',
      label: 'Under the hood (for the curious)',
      description: 'The technical map: every screen, behind-the-scenes endpoint, coach tool and database change. You can ignore this branch entirely.',
      code: { migrations: 'all' },
      children: [
        { id: 'uth-routes', label: 'All screens (routes)', description: 'Every page the app serves.', code: { routes: '*' } },
        { id: 'uth-api', label: 'Behind-the-scenes endpoints', description: 'The server endpoints that sync devices, run the coaches and save your data.', code: { apiRoutes: '*' } },
        { id: 'uth-tools', label: 'Coach tools', description: 'The specific actions each coach is allowed to take.', code: { tools: '*' } },
        { id: 'uth-migrations', label: 'Database history', description: 'Every change made to the database structure over time.', code: { migrations: 'all' } },
      ],
    },
  ],
};
```

NOTE for the implementer: the `'*'` sentinel on `uth-routes`/`uth-api`/`uth-tools` means "this node absorbs ALL extracted facts of that kind for drift purposes" — define and honor it in Task 3. Keep descriptions plain; do not add jargon to branches 1–5.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/app-map/manifest.test.mjs`
Expected: PASS — prints `manifest.test.mjs OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/app-map/manifest.mjs scripts/app-map/manifest.test.mjs
git commit -m "feat(app-map): curated plain-language manifest tree"
```

---

### Task 3: Merge + drift check (`merge.mjs`)

**Files:**
- Create: `scripts/app-map/merge.mjs`
- Test: `scripts/app-map/merge.test.mjs`

**Interfaces:**
- Consumes: `extract()` output (Task 1), `manifest` (Task 2).
- Produces:
  ```
  export function buildTree(manifest, facts) -> {
    tree,    // manifest deep-cloned; each node gains `underHood: string[]`
             // (resolved technical refs) and `badges: ('stale'|'undocumented')[]`;
             // the '*' nodes get children synthesized from facts.
    drift: { undocumented: string[], stale: string[] }
  }
  ```
  Rules:
  - A `code.coaches/routes/apiRoutes/tools` array claims those exact facts.
  - A `'*'` value on `routes/apiRoutes/tools` claims ALL facts of that kind.
  - `migrations: 'all'` claims all migrations.
  - **undocumented:** any extracted fact (route, apiRoute, coach, tool) claimed by no node. (Migrations are always claimed wholesale by under-the-hood, so they never go undocumented.)
  - **stale:** any explicit (non-`'*'`) claimed ref that does not exist in facts.
  - `'*'` nodes synthesize one leaf child per fact (label = the fact string, description = '').

- [ ] **Step 1: Write the failing test**

```js
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

console.log('merge.test.mjs OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/app-map/merge.test.mjs`
Expected: FAIL — `Cannot find module './merge.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// scripts/app-map/merge.mjs

export function buildTree(manifest, facts) {
  const allFacts = {
    route: facts.routes,
    apiRoute: facts.apiRoutes,
    coach: facts.coaches.map((c) => c.id),
    tool: [...new Set(facts.coaches.flatMap((c) => c.tools))],
    migration: facts.migrations,
  };

  const claimed = { route: new Set(), apiRoute: new Set(), coach: new Set(), tool: new Set(), migration: new Set() };
  const starKinds = { route: false, apiRoute: false, tool: false };
  const stale = [];

  // Pass 1: walk manifest, record claims, compute stale, attach underHood + clone.
  function clone(node) {
    const out = { id: node.id, label: node.label, description: node.description, badges: [], underHood: [] };
    const code = node.code;
    if (code) {
      for (const kind of ['routes', 'apiRoutes', 'coaches', 'tools']) {
        const singular = { routes: 'route', apiRoutes: 'apiRoute', coaches: 'coach', tools: 'tool' }[kind];
        const val = code[kind];
        if (val === '*') {
          starKinds[singular] = true;
        } else if (Array.isArray(val)) {
          for (const ref of val) {
            claimed[singular].add(ref);
            if (!allFacts[singular].includes(ref)) {
              stale.push(`${singular}:${ref}`);
              out.badges.push('stale');
            } else {
              out.underHood.push(`${singular}: ${ref}`);
            }
          }
        }
      }
      if (code.migrations === 'all') {
        for (const mfile of allFacts.migration) claimed.migration.add(mfile);
        out.underHood.push(`migrations: ${allFacts.migration.length} files`);
      }
    }
    const synthesized = synthChildren(node, allFacts);
    const realChildren = (node.children ?? []).map(clone);
    const children = [...realChildren, ...synthesized];
    if (children.length) out.children = children;
    return out;
  }

  const tree = clone(manifest);

  // Pass 2: resolve '*' absorption, then compute undocumented.
  for (const k of ['route', 'apiRoute', 'tool']) {
    if (starKinds[k]) for (const f of allFacts[k]) claimed[k].add(f);
  }
  const undocumented = [];
  for (const k of ['route', 'apiRoute', 'coach', 'tool']) {
    for (const f of allFacts[k]) if (!claimed[k].has(f)) undocumented.push(`${k}:${f}`);
  }

  // Pass 3: badge undocumented leaves that were synthesized under '*' nodes? No —
  // undocumented are by definition unclaimed, so they live in no node. They are
  // reported in `drift` and surfaced by the renderer as a dedicated list.

  return { tree, drift: { undocumented: undocumented.sort(), stale: [...new Set(stale)].sort() } };
}

/** For '*'/all nodes, synthesize one plain leaf per fact. */
function synthChildren(node, allFacts) {
  const code = node.code;
  if (!code) return [];
  const out = [];
  const map = { routes: 'route', apiRoutes: 'apiRoute', tools: 'tool' };
  for (const [kind, singular] of Object.entries(map)) {
    if (code[kind] === '*') {
      for (const f of allFacts[singular]) {
        out.push({ id: `${node.id}--${slug(f)}`, label: f, description: '', badges: [], underHood: [] });
      }
    }
  }
  if (code.migrations === 'all') {
    for (const f of allFacts.migration) {
      out.push({ id: `${node.id}--${slug(f)}`, label: f, description: '', badges: [], underHood: [] });
    }
  }
  return out;
}

function slug(s) {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/app-map/merge.test.mjs`
Expected: PASS — prints `merge.test.mjs OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/app-map/merge.mjs scripts/app-map/merge.test.mjs
git commit -m "feat(app-map): merge manifest with facts + drift check"
```

---

### Task 4: HTML renderer + build entrypoint + npm script

**Files:**
- Create: `scripts/app-map/render.mjs`
- Create: `scripts/app-map/build.mjs`
- Modify: `package.json` (add `"map"` script)
- Output (generated, committed): `docs/app-map.html`

**Interfaces:**
- Consumes: `buildTree()` (Task 3), `extract()` (Task 1), `manifest` (Task 2).
- `render.mjs` produces: `export function renderHtml({ tree, drift, generatedNote })` → a complete self-contained HTML string (CSS + JS + data inlined).
- `build.mjs`: orchestrates extract → buildTree → renderHtml → write `docs/app-map.html`; prints drift to console; supports `--strict` (exit 1 if any drift).

- [ ] **Step 1: Write `render.mjs`**

```js
// scripts/app-map/render.mjs
// Pure string templating. No external assets. Tree + drift inlined as JSON.

export function renderHtml({ tree, drift, generatedNote }) {
  const data = JSON.stringify({ tree, drift, generatedNote }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Apex Health OS — App Map</title>
<style>
:root{--bg:#0c0e12;--panel:#14171d;--line:#252a33;--fg:#e7e9ee;--muted:#8a93a3;--accent:#6ea8fe;--warn:#e0b341;--stale:#e06c6c;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,'DM Sans',sans-serif;}
header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0;font-weight:600}
#search{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 10px;min-width:200px}
.note{color:var(--muted);font-size:12px}
#wrap{display:flex;min-height:calc(100dvh - 52px)}
#tree{flex:1;padding:14px 18px;overflow:auto;max-width:62%}
#detail{width:38%;border-left:1px solid var(--line);padding:18px;position:sticky;top:0;align-self:flex-start;max-height:100dvh;overflow:auto}
ul{list-style:none;margin:0;padding-left:16px}
li{margin:2px 0}
.row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer}
.row:hover{background:var(--panel)}
.row.sel{background:#1b2330;outline:1px solid var(--accent)}
.tw{width:14px;color:var(--muted);font-size:11px;user-select:none}
.leaf .tw{visibility:hidden}
.badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid}
.badge.stale{color:var(--stale);border-color:var(--stale)}
.badge.undocumented{color:var(--warn);border-color:var(--warn)}
.hidden{display:none}
#detail h2{margin:0 0 8px;font-size:18px}
#detail .uh{margin-top:14px;color:var(--muted);font-size:12px;border-top:1px dashed var(--line);padding-top:10px}
#detail .uh code{color:#9fb4cf}
#crumb{color:var(--muted);font-size:12px;margin-bottom:10px}
#drift{margin-top:18px;font-size:12px;color:var(--muted)}
#drift b{color:var(--warn)}
</style></head>
<body>
<header>
  <h1>Apex Health OS — App Map</h1>
  <input id="search" placeholder="Search…" autocomplete="off"/>
  <span class="note" id="gen"></span>
</header>
<div id="wrap">
  <div id="tree"></div>
  <div id="detail"><div id="crumb"></div><div id="body"><p class="note">Pick a branch on the left to read about it.</p></div></div>
</div>
<script>
const DATA = ${data};
const parents = new Map();
function tag(node,parent){ parents.set(node.id, parent); (node.children||[]).forEach(c=>tag(c,node)); }
tag(DATA.tree, null);
document.getElementById('gen').textContent = DATA.generatedNote || '';

function el(t,props={},...kids){const e=document.createElement(t);Object.assign(e,props);for(const k of kids)e.append(k);return e;}

function renderNode(node){
  const li=el('li');
  const hasKids=(node.children||[]).length>0;
  const row=el('div',{className:'row'+(hasKids?'':' leaf')});
  const tw=el('span',{className:'tw',textContent:hasKids?'▸':'•'});
  row.append(tw, el('span',{textContent:node.label}));
  for(const b of node.badges||[]) row.append(el('span',{className:'badge '+b,textContent:b}));
  row.dataset.id=node.id;
  let kidsUl=null;
  if(hasKids){ kidsUl=el('ul',{className:'hidden'}); for(const c of node.children) kidsUl.append(renderNode(c)); }
  row.onclick=(e)=>{
    e.stopPropagation();
    if(hasKids){ kidsUl.classList.toggle('hidden'); tw.textContent=kidsUl.classList.contains('hidden')?'▸':'▾'; }
    select(node);
  };
  li.append(row); if(kidsUl) li.append(kidsUl);
  return li;
}

function select(node){
  document.querySelectorAll('.row.sel').forEach(r=>r.classList.remove('sel'));
  const row=document.querySelector('.row[data-id="'+CSS.escape(node.id)+'"]'); if(row) row.classList.add('sel');
  const crumb=[]; let p=node; while(p){crumb.unshift(p.label); p=parents.get(p.id);} 
  document.getElementById('crumb').textContent=crumb.join('  ›  ');
  const body=document.getElementById('body'); body.textContent='';
  body.append(el('h2',{textContent:node.label}));
  if(node.description) body.append(el('p',{textContent:node.description}));
  if((node.underHood||[]).length){
    const uh=el('div',{className:'uh'}); uh.append(el('div',{textContent:'Under the hood'}));
    for(const u of node.underHood){ const c=el('code',{textContent:u}); uh.append(el('div',{},c)); }
    body.append(uh);
  }
}

const rootUl=el('ul'); rootUl.append(renderNode(DATA.tree));
document.getElementById('tree').append(rootUl);
// expand root by default
document.querySelector('.row').click();

// search: show only rows whose label matches, plus ancestors; expand matches.
const search=document.getElementById('search');
search.oninput=()=>{
  const q=search.value.trim().toLowerCase();
  document.querySelectorAll('#tree li').forEach(li=>li.classList.remove('hidden'));
  document.querySelectorAll('#tree ul').forEach(u=>{ if(u.parentElement.tagName==='LI'&&!q) u.classList.add('hidden'); });
  if(!q){ return; }
  document.querySelectorAll('#tree .row').forEach(row=>{
    const match=row.textContent.toLowerCase().includes(q);
    if(match){ let li=row.closest('li'); while(li){ li.classList.remove('hidden'); const ul=li.parentElement.closest('li'); const sub=li.querySelector(':scope > ul'); if(sub) sub.classList.remove('hidden'); li=ul; } }
  });
  // hide non-matching leaves
  document.querySelectorAll('#tree li').forEach(li=>{
    const row=li.querySelector(':scope > .row');
    const anyVisibleChild=li.querySelector(':scope > ul > li:not(.hidden)');
    if(row && !row.textContent.toLowerCase().includes(q) && !anyVisibleChild) li.classList.add('hidden');
  });
};

// drift footer in detail panel
if((DATA.drift.undocumented.length+DATA.drift.stale.length)>0){
  const d=el('div',{id:'drift'});
  if(DATA.drift.undocumented.length) d.append(el('div',{},el('b',{textContent:'Undocumented in code: '}), document.createTextNode(DATA.drift.undocumented.join(', '))));
  if(DATA.drift.stale.length) d.append(el('div',{},el('b',{textContent:'Stale (described but gone): '}), document.createTextNode(DATA.drift.stale.join(', '))));
  document.getElementById('detail').append(d);
}
</script>
</body></html>`;
}
```

- [ ] **Step 2: Write `build.mjs`**

```js
// scripts/app-map/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './extract.mjs';
import { manifest } from './manifest.mjs';
import { buildTree } from './merge.mjs';
import { renderHtml } from './render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const strict = process.argv.includes('--strict');

const facts = extract(repoRoot);
const { tree, drift } = buildTree(manifest, facts);

const generatedNote = `${facts.routes.length} screens · ${facts.apiRoutes.length} endpoints · ${facts.coaches.length} coaches · ${facts.migrations.length} migrations`;
const html = renderHtml({ tree, drift, generatedNote });

const outDir = path.join(repoRoot, 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'app-map.html');
fs.writeFileSync(outFile, html, 'utf8');

console.log(`Wrote ${path.relative(repoRoot, outFile)} — ${generatedNote}`);
for (const u of drift.undocumented) console.warn(`⚠ undocumented: ${u}`);
for (const s of drift.stale) console.warn(`✗ stale: ${s}`);
if (strict && (drift.undocumented.length || drift.stale.length)) {
  console.error(`Drift detected (${drift.undocumented.length} undocumented, ${drift.stale.length} stale).`);
  process.exit(1);
}
```

- [ ] **Step 3: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
"map": "node scripts/app-map/build.mjs"
```

- [ ] **Step 4: Generate and smoke-test**

Run: `npm run map`
Expected: prints `Wrote docs/app-map.html — N screens · …`. Drift warnings for any real route/tool/coach not yet described (e.g. `/privacy`, `/login`, `/coach/reviews`, extra API routes) are EXPECTED and fine — they are the drift check doing its job.

Then verify the file is self-contained and parses:

Run: `node -e "const h=require('fs').readFileSync('docs/app-map.html','utf8'); if(!h.includes('Apex Health OS')) throw new Error('missing title'); if(/src=|href=\"http/.test(h)) throw new Error('external asset reference'); console.log('html ok, '+h.length+' bytes')"`
Expected: `html ok, <N> bytes`.

Open `docs/app-map.html` in a browser: confirm branches expand/collapse, the detail panel shows plain text, search filters, and branch 6 lists routes/tools/migrations.

- [ ] **Step 5: Run all tests + typecheck guard**

Run: `node scripts/app-map/extract.test.mjs && node scripts/app-map/manifest.test.mjs && node scripts/app-map/merge.test.mjs`
Expected: three `… OK` lines.

(No `tsc` needed — these are `.mjs` outside the TS project. Do NOT run `npm run lint` per repo convention.)

- [ ] **Step 6: Commit**

```bash
git add scripts/app-map/render.mjs scripts/app-map/build.mjs package.json docs/app-map.html
git commit -m "feat(app-map): self-contained HTML renderer + npm run map"
```

---

### Task 5: README pointer + reconcile obvious drift

**Files:**
- Modify: `scripts/app-map/manifest.mjs` (add description nodes for any high-value undocumented items worth narrating)
- Create: `scripts/app-map/README.md`

**Interfaces:** none new.

- [ ] **Step 1: Triage drift output**

Run: `npm run map` and read the `⚠ undocumented` list. Decide per item: leave it surfaced under branch 6’s `'*'` nodes (fine for low-value endpoints like `/login`, `/privacy`), OR add a plain-language node in branches 1–5 if it’s user-facing and worth narrating (e.g. a screen the manifest missed). Do NOT chase every API route to zero — undocumented API endpoints are acceptable; the `'*'` node absorbs them so they never report as drift anyway.

- [ ] **Step 2: Write the README**

```markdown
# App Map (`npm run map`)

Generates `docs/app-map.html` — a clickable, plain-language tree of the whole app.
Open that file in any browser. No server, no build.

- `extract.mjs` — reads structural facts from the codebase (routes, API endpoints,
  coach→tool arrays, coach voices, migrations). Pure file reads, no app imports.
- `manifest.mjs` — the hand-written, plain-English tree. **Edit this** to keep
  descriptions current. Branches 1–5 must stay jargon-free.
- `merge.mjs` — joins manifest to facts, computes drift (undocumented / stale).
- `render.mjs` / `build.mjs` — emit the self-contained HTML.

When you add a screen, coach tool, or migration, run `npm run map`. New items
show up under "Under the hood" and, if user-facing, should get a plain node in
the manifest. Run `npm run map -- --strict` to fail on any drift (e.g. in CI).

Tests: `node scripts/app-map/{extract,manifest,merge}.test.mjs`.
```

- [ ] **Step 3: Regenerate + commit**

```bash
npm run map
git add scripts/app-map/README.md scripts/app-map/manifest.mjs docs/app-map.html
git commit -m "docs(app-map): README + reconcile high-value drift"
```

---

## Self-Review

**Spec coverage:**
- Plain-language tree, branches 1–6 → Task 2 manifest. ✓
- Auto-skeleton (routes, api, coach→tools, voices, migrations) → Task 1. ✓
- Hybrid join + drift (undocumented/stale, visible not silent) → Task 3 + Task 4 console output + render footer. ✓
- Self-contained HTML viewer (left tree, right detail, breadcrumb, search, badges, under-the-hood line) → Task 4 render.mjs. ✓
- `npm run map` one command → Task 4 package.json. ✓
- `--strict` flag → Task 4 build.mjs. ✓
- Out-of-scope items (CI wiring, semantic auto-descriptions, graph layout, in-app route, deep links) → not built. ✓
- Success criteria (regenerates with no manual steps; non-technical readable; new code surfaces as undocumented; removed code surfaces as stale) → covered by Tasks 1–4 and verified in Task 4 Step 4 + Task 5. ✓

**Placeholder scan:** Synthesized `'*'` leaves use `description: ''` deliberately (the label IS the fact); the renderer guards `if(node.description)`. No TBD/TODO left. ✓

**Type consistency:** `extract()` shape consumed identically in merge.test, merge.mjs, build.mjs. `buildTree(manifest, facts)` returns `{tree, drift}` everywhere. `renderHtml({tree, drift, generatedNote})` matches build.mjs call. Node fields (`badges`, `underHood`, `children`) consistent between merge.mjs output and render.mjs consumption. ✓
