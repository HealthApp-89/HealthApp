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
