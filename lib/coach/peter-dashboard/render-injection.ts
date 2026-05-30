// lib/coach/peter-dashboard/render-injection.ts
//
// Renders the "Today's read" markdown block that gets injected into
// Peter's system prompt. Single source of truth so the block on the
// dashboard UI and the block in the prompt cannot diverge.

import type { PeterDashboardPayload } from './types';
import { ALL_THEME_KEYS, THEME_LABEL } from './types';

export function renderInjectionBlock(
  payload: PeterDashboardPayload,
  generatedOn: string,
): string {
  const n = payload.narrative;
  if (n == null) {
    return '# Today\'s read\n\nNot generated successfully today — synthesize from the snapshot directly.';
  }

  const lines: string[] = [];
  lines.push(`# Today's read (Peter — generated ${generatedOn} 04:00 UTC)`);
  lines.push('');
  lines.push(`> ${n.hero.headline}`);
  lines.push('>');
  lines.push(`> ${n.hero.body_md}`);
  lines.push('');

  for (const k of ALL_THEME_KEYS) {
    const theme = payload.facts.themes[k];
    const card = n.cards[k];
    // Legacy payloads (cached before a theme was added to ALL_THEME_KEYS)
    // won't have an entry for the new key. Skip rather than crash; next
    // dashboard regen will fill it in.
    if (!theme || !card) continue;
    lines.push(`## ${THEME_LABEL[k]} — ${theme.severity}`);
    lines.push(card.narrative_md);
    lines.push('');
  }

  if (payload.facts.clusters.length > 0) {
    lines.push('---');
    for (const c of payload.facts.clusters) {
      lines.push(
        `Cluster (same root): ${c.themes.map((t) => THEME_LABEL[t]).join(' + ')}. Root hypothesis: ${c.root_hypothesis}.`,
      );
    }
    lines.push('');
  }

  lines.push('Use these takes when answering today\'s questions. If the user asks about a theme, ground in the card\'s specifics rather than re-deriving.');

  return lines.join('\n');
}

/** Placeholder used when there's no row yet (first-run user, cron hasn't fired). */
export function noPayloadInjection(): string {
  return '# Today\'s read\n\nNot yet generated — synthesize from the snapshot directly.';
}
