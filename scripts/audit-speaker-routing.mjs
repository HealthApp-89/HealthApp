#!/usr/bin/env node
// scripts/audit-speaker-routing.mjs
//
// Read-only audit: for the last N chat messages, report the speaker
// distribution and flag obvious mis-routings via keyword heuristics
// (Carter answering nutrition questions, Nora answering training, etc.).
// Useful for tuning Peter's routing prompt.
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
const { data: messages, error } = await supabase
  .from("chat_messages")
  .select("created_at, role, speaker, kind, content")
  .eq("user_id", userId)
  .order("created_at", { ascending: false })
  .limit(N);
if (error) throw error;

console.log(`→ last ${messages.length} messages`);
const dist = messages.reduce((acc, m) => {
  acc[m.speaker] = (acc[m.speaker] ?? 0) + 1;
  return acc;
}, {});
console.log("  speaker distribution:", dist);

// Keyword heuristics — flag messages where the speaker doesn't match obvious cues.
const cues = {
  carter: /\b(rpe|reps|sets|lift|squat|bench|deadlift|hypertrophy|deload|mesocycle)\b/i,
  nora:   /\b(macro|protein|kcal|calorie|fiber|carbs?|fat|meal|food|portion|hydra)/i,
  remi:   /\b(hrv|sleep|recovery|strain|nap|rest|fatigue|illness)\b/i,
};

let mismatches = 0;
for (const m of messages) {
  if (m.role !== "assistant" || m.kind === "system_routing") continue;
  if (m.speaker === "peter") continue; // peter is allowed everywhere
  // Find the user message before this one for context (rough heuristic: previous row).
  const idx = messages.indexOf(m);
  const prevUser = messages.slice(idx + 1).find((x) => x.role === "user");
  if (!prevUser) continue;
  const cue = cues[m.speaker];
  if (!cue.test(prevUser.content) && !cue.test(m.content)) {
    mismatches++;
    console.warn(`[MISMATCH] ${m.speaker} answered: "${prevUser.content.slice(0, 80)}"`);
  }
}

console.log(`\n${mismatches} potential mis-routings out of ${messages.length} messages`);
