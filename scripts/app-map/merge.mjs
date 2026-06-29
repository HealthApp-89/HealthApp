// scripts/app-map/merge.mjs

export function buildTree(manifest, facts, options = {}) {
  const exemptScreens = new Set(options.exemptScreens ?? []);

  const allFacts = {
    route: facts.routes,
    apiRoute: facts.apiRoutes,
    coach: facts.coaches.map((c) => c.id),
    tool: [...new Set(facts.coaches.flatMap((c) => c.tools))],
    migration: facts.migrations,
  };

  // Pre-pass: collect every route narrated by an explicit Array in any node's code.routes.
  // (Excludes '*' sentinel — those are the catch-all absorbers.)
  const narratedRoutes = new Set();
  function collectNarratedRoutes(node) {
    const val = node.code?.routes;
    if (Array.isArray(val)) for (const r of val) narratedRoutes.add(r);
    for (const ch of node.children ?? []) collectNarratedRoutes(ch);
  }
  collectNarratedRoutes(manifest);

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
    const synthesized = synthChildren(node, allFacts, narratedRoutes, exemptScreens);
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

  // Compute unnarrated screens: page routes not narrated by any screens-branch node
  // and not in the exempt list.
  const unnarratedScreens = facts.routes
    .filter((r) => !narratedRoutes.has(r) && !exemptScreens.has(r))
    .sort();

  return { tree, drift: { undocumented: undocumented.sort(), stale: [...new Set(stale)].sort(), unnarratedScreens } };
}

/** For '*'/all nodes, synthesize one plain leaf per fact. */
function synthChildren(node, allFacts, narratedRoutes, exemptScreens) {
  const code = node.code;
  if (!code) return [];
  const out = [];
  const map = { routes: 'route', apiRoutes: 'apiRoute', tools: 'tool' };
  for (const [kind, singular] of Object.entries(map)) {
    if (code[kind] === '*') {
      for (const f of allFacts[singular]) {
        // For route leaves synthesized under a '*' node, badge them as 'needs-desc'
        // when the route is not narrated by any explicit screens-branch node and not exempt.
        const badges =
          singular === 'route' && !narratedRoutes.has(f) && !exemptScreens.has(f)
            ? ['needs-desc']
            : [];
        out.push({ id: `${node.id}--${slug(f)}`, label: f, description: '', badges, underHood: [] });
      }
    }
  }
  if (code.migrations === 'all') {
    const childHoldsMigs = (node.children ?? []).some((ch) => ch.code?.migrations === 'all');
    if (!childHoldsMigs) {
      for (const f of allFacts.migration) {
        out.push({ id: `${node.id}--${slug(f)}`, label: f, description: '', badges: [], underHood: [] });
      }
    }
  }
  return out;
}

function slug(s) {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}
