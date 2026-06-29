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
