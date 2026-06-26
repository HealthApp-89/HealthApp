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
