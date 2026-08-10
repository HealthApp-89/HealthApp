// lib/coach/live-session/index.ts
//
// Between-sets coaching. Given the set just committed, return AT MOST ONE
// line — or null, which is the common case by design: a set that went to plan
// gets silence. Scarcity is what keeps the line credible.
//
// Priority is fixed and deliberate:
//   1. PR              — celebrate at the moment it happens
//   2. failure budget  — safety before progression
//   3. drop-off        — stop the exercise before it buys pure fatigue
//   4. load call       — the core verdict
//   5. rest discipline — pacing, lowest stakes
//
// Spec: docs/superpowers/specs/2026-08-10-live-session-coaching-design.md

import { rulePr } from "./rule-pr";
import { ruleFailureBudget } from "./rule-failure-budget";
import { ruleDropOff } from "./rule-drop-off";
import { ruleLoadCall } from "./rule-load-call";
import { ruleRestDiscipline } from "./rule-rest-discipline";
import type { CoachLine, LiveSetInput } from "./types";

export type {
  CoachLine,
  CoachLineKind,
  LiveSetInput,
  LiveSessionContext,
  SessionSetRef,
} from "./types";

const RULES: ReadonlyArray<(input: LiveSetInput) => CoachLine | null> = [
  rulePr,
  ruleFailureBudget,
  ruleDropOff,
  ruleLoadCall,
  ruleRestDiscipline,
];

export function evaluateSet(input: LiveSetInput): CoachLine | null {
  for (const rule of RULES) {
    try {
      const line = rule(input);
      if (line) return line;
    } catch {
      // A rule bug must never prevent a set from being logged. The coaching
      // line is strictly additive; silence is always an acceptable output.
    }
  }
  return null;
}
