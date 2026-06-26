# Living App-Map — Design

**Date:** 2026-06-26
**Status:** Approved (brainstorm), pending implementation plan

## Goal

Produce a single, self-contained, clickable HTML page — `docs/app-map.html` — that is a **functional decomposition tree** of Apex Health OS. A reader clicks a branch to drill into more detail: the coaching team and what each coach does, the inputs the user provides, the functionalities the app offers, and the screens it presents.

Two non-negotiables:

1. **Plain, non-technical language.** Every label and description a person reads is written for someone with no knowledge of the codebase. No jargon in the main reading experience. The technical facts (file paths, tool names, migrations) are quarantined to one opt-in branch plus a faint, ignorable "under the hood" line per node.
2. **Living, not rotting.** The page is generated from the repo by `npm run map`. A drift check warns — visibly, not silently — when the code grows a route/coach/tool/migration the curated layer doesn't describe, or when the curated layer points at code that no longer exists.

## Freshness model — hybrid (auto-skeleton + curated descriptions)

The structure the app *has* is read mechanically from code (routes, coach→tool partitions, migrations, coach voices). The *meaning* of each piece ("Nora handles nutrition") is hand-written in a curated manifest. Extraction never fabricates intent; the manifest never silently drifts from code. They are joined by stable `id`s and reconciled by the drift check.

## Architecture

Three files under `scripts/app-map/`, plus one HTML output, plus one package.json script.

### 1. `scripts/app-map/extract.mjs` — the auto-skeleton

Pure `fs` + light regex. **No app imports** (does not load the Next app or Supabase). Returns a plain object of structural facts that are safe to read mechanically:

- **Routes** — walk `app/**/page.tsx`, derive route paths (`/`, `/meal`, `/coach`, `/metrics`, `/strength`, `/trends`, `/profile`, …). Ignore route groups `(…)` and dynamic-segment brackets are normalized (`[week_start]` → `:week_start`).
- **API routes** — walk `app/api/**/route.ts`, derive endpoint paths.
- **Coaches → tools** — parse the `PETER_TOOLS` / `CARTER_TOOLS` / `NORA_TOOLS` / `REMI_TOOLS` array literals in [lib/coach/tools.ts](../../../lib/coach/tools.ts); extract the tool identifiers each contains.
- **Coach voices** — detect the presence of `PETER_BASE` / `CARTER_BASE` / `NORA_BASE` / `REMI_BASE` exports in [lib/coach/system-prompts.ts](../../../lib/coach/system-prompts.ts).
- **Migrations** — list `supabase/migrations/*.sql` filenames.

Extraction is best-effort and resilient: if a parse target's shape changes, the extractor returns what it can and the drift check surfaces the gap — it never throws the build.

### 2. `scripts/app-map/manifest.mjs` — the curated layer (the human truth)

A JS module exporting the node hierarchy. Each node:

```js
{
  id: 'coach-nora',              // stable id, joined to extracted facts
  label: 'Nora — your nutrition coach',   // plain English
  description: 'Helps you eat to hit your goals...',  // plain English, no jargon
  children: [ /* nested nodes */ ],
  // optional links into extracted facts, for the "under the hood" line + drift check:
  code: { coach: 'nora', route: '/meal', tools: ['log_meal_entry', ...] }
}
```

This file is the single place a human edits to keep the *meaning* current. The `code` hints are how a node claims responsibility for an extracted fact (so the drift check can tell what's documented).

### 3. `scripts/app-map/build.mjs` — merge + render + drift-check

- **Merge:** join manifest nodes to extracted facts by their `code` hints. Attach the resolved technical detail to each node (for the "under the hood" line).
- **Drift check:**
  - Every extracted route / coach / coach-tool / migration with **no** manifest `code` hint claiming it → printed to console as `⚠ undocumented: <thing>` **and** surfaced in the tree under branch 6 with an `undocumented` badge. Visible, not silent.
  - Every manifest `code` hint pointing at a route/tool/coach that extraction **didn't** find → printed as `✗ stale: <thing>` and badged `stale` in the tree.
  - Drift warnings do **not** fail the build (exit 0) by default; a `--strict` flag makes any drift exit non-zero (useful if wired into CI later — out of scope for v1).
- **Render:** emit the merged tree as inlined JSON inside a self-contained HTML file written to `docs/app-map.html`.

### 4. package.json

```json
"map": "node scripts/app-map/build.mjs"
```

## The tree taxonomy

Root: **Apex Health OS — your personal health & performance coach.**

Six top-level branches. Branches 1–5 read like a guidebook (plain language). Branch 6 is the engineer's view, collapsed by default.

1. **Your coaching team** → Peter (head coach, ties everything together), Carter (strength & conditioning), Nora (nutrition), Remi (recovery & sleep). Each coach expands to: *what they help you with*, *what they can change for you*, *where you meet them*.
2. **What you put in** → the wearables & apps that feed it (WHOOP, Withings scale, Strava, Apple Health / Garmin, food logging, workout logging, body measurements) and the things you tell it (morning check-in, chat, your goals & profile).
3. **What it does for you** → morning brief, weekly review, weekly plan, daily dashboard, trends, nudges, food logging, workout logging, endurance training, GLP-1-aware nutrition.
4. **Where you go** → the screens (home, meals, metrics, coach, strength, trends, profile) and what each is for.
5. **How it decides** → plain-language explanations: readiness scoring, how training loads get prescribed, how "today" is figured out (timezone), data ownership ("steps come from your watch, not the scale").
6. **Under the hood** *(collapsed by default)* → the technical map: routes, API endpoints, coach tools, migrations — auto-listed and drift-checked. This is the only branch where raw technical identifiers are first-class.

The first five branches are authored in the manifest with plain descriptions. Branch 6 is assembled largely from extraction output.

## The HTML viewer

Self-contained single file. Dark theme matching the app's aesthetic. **Zero external dependencies** — all CSS/JS inlined, tree data inlined as JSON.

- **Left pane:** the collapsible tree. Click a branch to expand/collapse its children.
- **Right pane:** detail panel for the selected node — its plain-English `description`, and a faint, de-emphasized "under the hood" line showing the file/route/tool it maps to (omitted for nodes with no `code` hint).
- **Top:** breadcrumb of the current path, and a search box that filters nodes by label (case-insensitive substring; matches stay visible with their ancestors).
- **Badges:** `undocumented` / `stale` rendered as small inline chips on the relevant nodes.
- No build step, no server — open the file directly in a browser.

## Out of scope (v1)

- Wiring the drift check into CI / git hooks (the `--strict` flag exists but nothing calls it automatically).
- Auto-extracting semantic descriptions from code comments — descriptions are curated only.
- Diagram/graph layout (e.g. force-directed). v1 is a collapsible outline tree, not a node-graph canvas.
- Embedding the map as a route inside the Next app.
- Per-node deep links into the live app or GitHub.

## Success criteria

- `npm run map` regenerates `docs/app-map.html` with no manual steps.
- A non-technical reader can open the file and understand the coaches, inputs, features, and screens without encountering jargon (branches 1–5).
- Adding a new route or coach tool to the code, then running `npm run map`, surfaces it as `undocumented` until described in the manifest.
- Removing/renaming code that the manifest references surfaces as `stale`.
