// lib/coach/peter-dashboard/compose-fatigue.ts
//
// Fatigue debt: composite of HRV, sleep, strain, and which Remi
// proactive triggers fired in the last 14 days. Reads
// generateRecoveryIntelligence() + chat_messages for trigger lookup.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import {
  FATIGUE_REMI_TRIGGER_COUNT_WARN,
  FATIGUE_REMI_TRIGGER_COUNT_URGENT,
  FATIGUE_HRV_BELOW_BASELINE_PCT_WARN,
} from './thresholds';
import { generateRecoveryIntelligence } from '@/lib/coach/recovery-intelligence';
import { fmtNum } from '@/lib/ui/score';
import { isoDaysAgo } from '@/lib/time/dates';

const DEDUP_WINDOW_DAYS = 14;

export async function composeFatigue(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ThemePayload> {
  const { supabase, userId, today } = args;

  const ri = await generateRecoveryIntelligence({ supabase, userId, today });

  // Remi triggers fired in last 14 days.
  const start = isoDaysAgo(today, DEDUP_WINDOW_DAYS - 1);
  const { data: nudges, error: nErr } = await supabase
    .from('chat_messages')
    .select('ui, created_at')
    .eq('user_id', userId)
    .eq('kind', 'proactive_nudge')
    .eq('speaker', 'remi')
    .gte('created_at', `${start}T00:00:00Z`);
  if (nErr) throw nErr;

  const triggerKeys = (nudges ?? [])
    .map((n) => {
      const ui = n.ui as { trigger_key?: string } | null;
      return ui?.trigger_key ?? null;
    })
    .filter((k): k is string => k != null);
  const uniqueTriggerCount = new Set(triggerKeys).size;

  // HRV 7d vs baseline is pre-computed by the recovery-intelligence layer.
  const hrvVsBaseline7d = ri.derived.hrv_vs_baseline_pct_7d;
  const hrvChronicSignal =
    hrvVsBaseline7d != null && hrvVsBaseline7d <= FATIGUE_HRV_BELOW_BASELINE_PCT_WARN;
  const hrvChronicDepression = triggerKeys.includes('hrv_chronic_depression');

  // 7d sleep average — not pre-computed by recovery-intelligence, derive inline.
  const sleepLast7 = ri.daily
    .slice(-7)
    .map((d) => d.sleep_hours)
    .filter((h): h is number => h != null);
  const sleepAvg7d = avg(sleepLast7);

  let severity: ThemePayload['severity'];
  if (uniqueTriggerCount >= FATIGUE_REMI_TRIGGER_COUNT_URGENT || hrvChronicDepression) {
    severity = 'urgent';
  } else if (uniqueTriggerCount >= FATIGUE_REMI_TRIGGER_COUNT_WARN || hrvChronicSignal) {
    severity = 'warn';
  } else {
    severity = 'ok';
  }

  // Sparkline: HRV vs personal baseline over 28d (daily series).
  const hrvBaseline = ri.baselines.hrv_mean;
  const hrvSeries = ri.daily
    .slice(-28)
    .filter((p) => p.hrv != null)
    .map((p) => ({
      x: p.date,
      y: p.hrv as number,
      ref: hrvBaseline ?? undefined,
    }));

  return {
    key: 'fatigue',
    severity,
    one_line: oneLineFor({ hrvVsBaseline7d, triggerCount: uniqueTriggerCount }),
    body_md: bodyMdFor({
      hrvVsBaseline7d,
      sleepAvg7d,
      triggerCount: uniqueTriggerCount,
      severity,
    }),
    facts: {
      hrv_vs_baseline_pct_7d: hrvVsBaseline7d,
      sleep_hours_avg_7d: sleepAvg7d,
      remi_triggers_fired_14d: uniqueTriggerCount,
      remi_trigger_keys: triggerKeys.join(','),
    },
    sparkline:
      hrvSeries.length > 0
        ? { label: 'HRV vs baseline (28d)', series: hrvSeries }
        : null,
    inputs_used: [
      'recovery_intelligence.derived.hrv_vs_baseline_pct_7d',
      'recovery_intelligence.daily.sleep_hours',
      'recovery_intelligence.baselines.hrv_mean',
      'chat_messages.kind=proactive_nudge speaker=remi',
    ],
  };
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function oneLineFor(x: {
  hrvVsBaseline7d: number | null;
  triggerCount: number;
}): string {
  if (x.hrvVsBaseline7d != null) {
    const pct = fmtNum(x.hrvVsBaseline7d * 100, 0);
    const arrow = x.hrvVsBaseline7d < 0 ? '' : '+';
    return `HRV ${arrow}${pct}% vs baseline · ${x.triggerCount} flags`;
  }
  return `${x.triggerCount} Remi flag${x.triggerCount === 1 ? '' : 's'} in 14d`;
}

function bodyMdFor(x: {
  hrvVsBaseline7d: number | null;
  sleepAvg7d: number | null;
  triggerCount: number;
  severity: ThemePayload['severity'];
}): string {
  if (x.severity === 'ok') {
    return 'Recovery markers steady; no Remi flags in the last 14 days.';
  }
  const parts: string[] = [];
  if (x.hrvVsBaseline7d != null && x.hrvVsBaseline7d <= FATIGUE_HRV_BELOW_BASELINE_PCT_WARN) {
    parts.push(
      `HRV ${fmtNum(Math.abs(x.hrvVsBaseline7d * 100), 0)}% below baseline (7d)`,
    );
  }
  if (x.sleepAvg7d != null && x.sleepAvg7d < 7) {
    parts.push(`sleep averaging ${fmtNum(x.sleepAvg7d, 1)}h`);
  }
  if (x.triggerCount > 0) {
    parts.push(
      `${x.triggerCount} Remi flag${x.triggerCount === 1 ? '' : 's'} in 14d`,
    );
  }
  return parts.length > 0
    ? `${parts.join('; ')}. Recovery is the bottleneck.`
    : 'Recovery off baseline.';
}
