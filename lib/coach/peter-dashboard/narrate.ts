// lib/coach/peter-dashboard/narrate.ts
//
// Single Sonnet 4.6 call wrapping the facts payload. Validates output shape
// + fabrication-checks every numeric token. Retries once on failure with
// the offending text quoted. Falls back to deterministic body_md when the
// retry also fails — the dashboard still renders, just clinically.

import { callClaude } from '@/lib/anthropic/client';
import { NARRATIVE_MODEL } from '@/lib/anthropic/models';
import type {
  PeterDashboardFacts,
  Narrative,
  ThemeKey,
  ThemePayload,
} from './types';
import { ALL_THEME_KEYS } from './types';
import { NARRATIVE_SYSTEM_PROMPT, buildUserMessage } from './narrative-prompt';

const MAX_TOKENS = 900;

type NarrateResult = {
  narrative: Narrative | null;
  failed: boolean;
  failure_reason?: string;
};

export async function narrate(facts: PeterDashboardFacts): Promise<NarrateResult> {
  let attempt = 0;
  let lastError: string | null = null;

  while (attempt < 2) {
    attempt++;
    const systemPrompt = attempt === 1
      ? NARRATIVE_SYSTEM_PROMPT
      : `${NARRATIVE_SYSTEM_PROMPT}\n\nPrior attempt failed validation with: ${lastError}\nRetry. Fix the offending text. Same JSON shape.`;

    let raw: string;
    try {
      raw = await callClaude(
        [{ role: 'user', content: buildUserMessage(facts) }],
        {
          model: NARRATIVE_MODEL,
          system: systemPrompt,
          maxTokens: MAX_TOKENS,
          cacheSystem: true,
        },
      );
    } catch (e) {
      lastError = `claude call threw: ${String(e)}`;
      continue;
    }

    const parsed = tryParse(raw);
    if (!parsed.ok) {
      lastError = parsed.error;
      continue;
    }

    const validation = validate(parsed.narrative, facts);
    if (!validation.ok) {
      lastError = validation.error;
      continue;
    }

    return { narrative: parsed.narrative, failed: false };
  }

  return { narrative: null, failed: true, failure_reason: lastError ?? 'unknown' };
}

function tryParse(raw: string): { ok: true; narrative: Narrative } | { ok: false; error: string } {
  // Strip ```json fences if present.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: `JSON parse: ${String(e)}` };
  }
  if (
    typeof parsed !== 'object' || parsed == null ||
    typeof (parsed as { hero?: unknown }).hero !== 'object' ||
    typeof (parsed as { cards?: unknown }).cards !== 'object'
  ) {
    return { ok: false, error: 'shape: missing hero or cards' };
  }
  const n = parsed as Narrative;
  for (const k of ALL_THEME_KEYS) {
    if (typeof n.cards[k]?.narrative_md !== 'string') {
      return { ok: false, error: `shape: missing cards.${k}.narrative_md` };
    }
  }
  return { ok: true, narrative: n };
}

function validate(n: Narrative, facts: PeterDashboardFacts): { ok: true } | { ok: false; error: string } {
  // Word caps.
  if (countWords(n.hero.headline) > 20) {
    return { ok: false, error: `hero.headline > 20 words: "${n.hero.headline}"` };
  }
  if (countWords(n.hero.body_md) > 60) {
    return { ok: false, error: `hero.body_md > 60 words` };
  }
  for (const k of ALL_THEME_KEYS) {
    if (countWords(n.cards[k].narrative_md) > 50) {
      return { ok: false, error: `cards.${k}.narrative_md > 50 words` };
    }
  }

  // Fabrication check: every numeric token in narrative text must exist in facts.
  const allowed = collectAllowedNumbers(facts);
  const offenders: string[] = [];
  for (const text of [n.hero.headline, n.hero.body_md, ...ALL_THEME_KEYS.map((k) => n.cards[k].narrative_md)]) {
    for (const tok of extractNumericTokens(text)) {
      if (!allowed.has(tok)) offenders.push(tok);
    }
  }
  if (offenders.length > 0) {
    return { ok: false, error: `numeric tokens not in facts: ${offenders.slice(0, 5).join(', ')}` };
  }

  // Cluster mention enforcement: when facts.clusters is non-empty, hero.body_md
  // must reference at least one cluster theme pair OR the affected cards must
  // each name the partner theme.
  if (facts.clusters.length > 0) {
    const heroText = n.hero.body_md.toLowerCase();
    const heroNamesAnyCluster = facts.clusters.some((c) =>
      c.themes.every((t) => heroText.includes(themeMention(t).toLowerCase())),
    );
    if (!heroNamesAnyCluster) {
      return { ok: false, error: 'cluster present but hero.body_md does not name the cluster relationship' };
    }
  }

  return { ok: true };
}

function themeMention(k: ThemeKey): string {
  return ({
    recomp: 'recomp',
    energy: 'energy',
    fatigue: 'fatigue',
    performance: 'performance',
    plan_adherence: 'adherence',
    goal_distance: 'goal',
  } as Record<ThemeKey, string>)[k];
}

function collectAllowedNumbers(facts: PeterDashboardFacts): Set<string> {
  const out = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === 'number') {
      // Allow the raw number and a few common renderings (with sign, rounded).
      out.add(String(v));
      out.add(String(Math.round(v)));
      out.add(String(Math.round(v * 10) / 10));
      out.add(String(Math.round(v * 100) / 100));      // 2-decimal: 0.8917 → 0.89
      out.add(String(Math.abs(v)));
      out.add(String(Math.abs(Math.round(v))));
      out.add(String(Math.round(Math.abs(v) * 10) / 10));
      out.add(String(Math.round(Math.abs(v) * 100) / 100));
      // Percentages: facts often store ratios (0.07 → "7%"). Only allow the
      // ×100 rendering when the raw value is in the ratio range [-1, 1] —
      // otherwise pushing 750 for 7.5 lets the model freely fabricate "750%".
      if (Math.abs(v) <= 1) {
        out.add(String(Math.round(v * 100)));
        out.add(String(Math.round(Math.abs(v) * 100)));
      }
    }
    if (typeof v === 'string') {
      // ISO date "YYYY-MM-DD" → push year + month + day (with and without
      // sign / leading zero) so Sonnet's natural "by 2026-06-25" rendering
      // doesn't trip the fabrication check on the dash-separated tokens.
      const isoMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoMatch) {
        const [, y, m, d] = isoMatch;
        out.add(y);
        out.add(m);                       // "06"
        out.add(String(Number(m)));        // "6"
        out.add(`-${m}`);                  // "-06" (regex captures as negative)
        out.add(`-${Number(m)}`);          // "-6"
        out.add(d);
        out.add(String(Number(d)));
        out.add(`-${d}`);
        out.add(`-${Number(d)}`);
        return;
      }
      // String fields may carry comma-separated numerics ("3.2,-1.1,0.4").
      for (const t of v.split(/[,\s]+/)) {
        const n = Number(t);
        if (Number.isFinite(n)) push(n);
      }
    }
  };
  for (const t of Object.values(facts.themes)) {
    for (const v of Object.values(t.facts)) push(v);
  }
  push(facts.block_context.block_number);
  push(facts.block_context.week_of_block);
  push(facts.goal_summary.target);
  push(facts.goal_summary.target_date);   // ISO date → year/month/day tokens via the string branch
  // Always allow small integers and percentages for general prose.
  for (let i = 0; i <= 100; i++) out.add(String(i));
  return out;
}

function extractNumericTokens(text: string): string[] {
  return Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g)).map((m) => m[0]);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Build a deterministic fallback Narrative from theme body_md fields.
 *  Used when narrate() returns failed=true. */
export function fallbackNarrative(
  themes: Record<ThemeKey, ThemePayload>,
): Narrative {
  const urgent = ALL_THEME_KEYS
    .map((k) => themes[k])
    .filter((t) => t.severity === 'urgent');
  const warn = ALL_THEME_KEYS
    .map((k) => themes[k])
    .filter((t) => t.severity === 'warn');
  const headline = urgent.length > 0
    ? `${themeLabel(urgent[0].key)} urgent — ${urgent[0].one_line}`
    : warn.length > 0
      ? `${themeLabel(warn[0].key)} watch — ${warn[0].one_line}`
      : 'On track';
  const body_md = urgent.length > 0
    ? urgent[0].body_md
    : warn.length > 0
      ? warn[0].body_md
      : 'No urgent or watch-level themes today.';
  const cards = Object.fromEntries(
    ALL_THEME_KEYS.map((k) => [k, { narrative_md: themes[k].body_md }]),
  ) as Record<ThemeKey, { narrative_md: string }>;
  return { hero: { headline, body_md }, cards };
}

function themeLabel(k: ThemeKey): string {
  return ({
    recomp: 'Recomp',
    energy: 'Energy',
    fatigue: 'Fatigue',
    performance: 'Performance',
    plan_adherence: 'Plan adherence',
    goal_distance: 'Goal',
  } as Record<ThemeKey, string>)[k];
}
