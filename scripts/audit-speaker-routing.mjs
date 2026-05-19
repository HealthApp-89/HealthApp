#!/usr/bin/env node
// scripts/audit-speaker-routing.mjs
//
// Read-only audit of the chat routing layer.
//
//   Section 1 — visible-message speaker distribution (Carter/Nora/Remi/Peter)
//                 and a keyword-cue heuristic flagging plausibly mis-routed turns.
//   Section 2 — system_routing audit rows: method distribution
//                 (manual / mention / keyword / haiku / fallback / handoff),
//                 per-speaker method breakdown, classifier-vs-manual disagreements.
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-speaker-routing.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf-8")
  .split("\n")
  .reduce((acc, line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) acc[m[1]] = m[2].replace(/^"|"$/g, "");
    return acc;
  }, {});

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID env var"); process.exit(1); }

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const N = 100;

// ── Section 1: visible-message speaker distribution + mismatch heuristic ──
const { data: visible, error: vErr } = await supabase
  .from("chat_messages")
  .select("created_at, role, speaker, kind, content")
  .eq("user_id", userId)
  .neq("kind", "system_routing")
  .order("created_at", { ascending: false })
  .limit(N);
if (vErr) throw vErr;

console.log(`→ last ${visible.length} visible messages`);
const dist = visible.reduce((acc, m) => {
  acc[m.speaker] = (acc[m.speaker] ?? 0) + 1;
  return acc;
}, {});
console.log("  speaker distribution:", dist);

const cues = {
  carter: /\b(rpe|reps|sets|lift|squat|bench|deadlift|hypertrophy|deload|mesocycle)\b/i,
  nora:   /\b(macro|protein|kcal|calorie|fiber|carbs?|fat|meal|food|portion|hydra)/i,
  remi:   /\b(hrv|sleep|recovery|strain|nap|rest|fatigue|illness)\b/i,
};

let mismatches = 0;
for (const m of visible) {
  if (m.role !== "assistant") continue;
  if (m.speaker === "peter") continue;
  const idx = visible.indexOf(m);
  const prevUser = visible.slice(idx + 1).find((x) => x.role === "user");
  if (!prevUser) continue;
  const cue = cues[m.speaker];
  if (!cue.test(prevUser.content) && !cue.test(m.content)) {
    mismatches++;
    console.warn(`[MISMATCH] ${m.speaker} answered: "${prevUser.content.slice(0, 80)}"`);
  }
}
console.log(`\n${mismatches} potential mis-routings out of ${visible.length} visible messages`);

// ── Section 2: routing audit rows ─────────────────────────────────────────
const { data: audits, error: aErr } = await supabase
  .from("chat_messages")
  .select("created_at, speaker, content, ui")
  .eq("user_id", userId)
  .eq("kind", "system_routing")
  .order("created_at", { ascending: false })
  .limit(N);
if (aErr) throw aErr;

console.log(`\n→ last ${audits.length} routing audit rows`);
const methodCounts = {};
const perSpeakerMethod = { peter: {}, carter: {}, nora: {}, remi: {} };
let disagreements = 0;

for (const r of audits) {
  const ui = r.ui ?? {};
  const method = ui.method ?? "unknown";
  methodCounts[method] = (methodCounts[method] ?? 0) + 1;
  const sp = ui.decided_speaker ?? r.speaker ?? "unknown";
  if (perSpeakerMethod[sp]) {
    perSpeakerMethod[sp][method] = (perSpeakerMethod[sp][method] ?? 0) + 1;
  }
  // Disagreement: classifier wanted X, user manually picked Y (look at the
  // user_message_id paired routing rows — both would exist in this audit
  // window if both fired in close succession).
  if (method === "manual" && ui.override_source === "picker") {
    // Look for a sibling automatic decision for the same user_message_id —
    // there shouldn't be one (manual short-circuits classifyTurn), so this
    // is informational only.
    const sibling = audits.find(
      (x) => x !== r && (x.ui?.user_message_id ?? null) === (ui.user_message_id ?? null) && x.ui?.method !== "manual",
    );
    if (sibling) disagreements++;
  }
}

console.log("  method distribution:", methodCounts);
console.log("  per-speaker method breakdown:");
for (const sp of ["peter", "carter", "nora", "remi"]) {
  console.log(`    ${sp.padEnd(8)} →`, perSpeakerMethod[sp]);
}
console.log(`\n${disagreements} classifier-vs-manual disagreements (manual override on a message the classifier had a confident opinion about)`);
