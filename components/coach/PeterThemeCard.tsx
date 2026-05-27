'use client';

import type { CSSProperties } from 'react';
import Link from 'next/link';
import {
  LineChart,
  Line,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  XAxis,
} from 'recharts';
import type { ThemePayload, Severity } from '@/lib/data/types';
import { THEME_LABEL, THEME_DRILLDOWN } from '@/lib/coach/peter-dashboard/types';
import { COLOR, RADIUS, SHADOW } from '@/lib/ui/theme';
import { fmtNum } from '@/lib/ui/score';

const SEVERITY_COLOR: Record<Severity, string> = {
  ok:     COLOR.success,
  warn:   COLOR.warning,
  urgent: COLOR.danger,
};

type Props = {
  theme: ThemePayload;
  narrative: string | null;
  expanded: boolean;
  onToggle: () => void;
};

export function PeterThemeCard({ theme, narrative, expanded, onToggle }: Props) {
  const panelId = `theme-panel-${theme.key}`;
  return (
    <div
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.cardMid,
        boxShadow: SHADOW.card,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: 10,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: 4,
              background: SEVERITY_COLOR[theme.severity],
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: COLOR.textStrong,
              letterSpacing: 0.2,
            }}
          >
            {THEME_LABEL[theme.key]}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              color: COLOR.textMuted,
              lineHeight: 1,
            }}
          >
            {expanded ? '−' : '+'}
          </span>
        </div>

        <div style={{ fontSize: 11, color: COLOR.textMuted }}>
          {theme.one_line}
        </div>
      </button>

      {expanded && (
        <div
          id={panelId}
          role="region"
          style={{
            padding: '0 10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <p
            style={{
              fontSize: 13,
              color: COLOR.textStrong,
              margin: 0,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}
          >
            {narrative ?? theme.body_md}
          </p>

          {/* Fact chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(theme.facts)
              .filter(([, v]) => v !== null && v !== '')
              .slice(0, 6)
              .map(([k, v]) => (
                <span key={k} style={factChipStyle}>
                  <span style={{ color: COLOR.textMuted, fontWeight: 500 }}>
                    {k.replace(/_/g, ' ')}:
                  </span>{' '}
                  <span style={{ color: COLOR.textStrong, fontWeight: 600 }}>
                    {typeof v === 'number' ? fmtNum(v) : String(v)}
                  </span>
                </span>
              ))}
          </div>

          {theme.sparkline && theme.sparkline.series.length > 0 && (
            <div style={{ height: 100, width: '100%', minWidth: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={theme.sparkline.series}
                  margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
                >
                  {/* Hidden axis exposes the x value to the tooltip so the
                      label resolves to the date (e.g. "2026-05-27") instead
                      of the Recharts default of the data-point index. */}
                  <XAxis dataKey="x" hide />
                  <Line
                    type="monotone"
                    dataKey="y"
                    stroke={COLOR.accent}
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  {theme.sparkline.series[0]?.ref != null && (
                    <ReferenceLine
                      y={theme.sparkline.series[0].ref}
                      stroke={COLOR.textFaint}
                      strokeDasharray="3 3"
                    />
                  )}
                  <Tooltip
                    cursor={{ stroke: COLOR.divider, strokeWidth: 1 }}
                    contentStyle={{
                      background: COLOR.surface,
                      border: `1px solid ${COLOR.divider}`,
                      borderRadius: 8,
                      fontSize: 11,
                      color: COLOR.textStrong,
                      boxShadow: SHADOW.card,
                    }}
                    labelStyle={{ color: COLOR.textMuted }}
                    formatter={(value) => [
                      typeof value === 'number' ? fmtNum(value) : String(value),
                      theme.sparkline?.label ?? '',
                    ]}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Nav chips */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Link
              href={`/coach?tab=chat&context=${theme.key}`}
              style={chipStyle}
            >
              Ask Peter →
            </Link>
            <Link href={THEME_DRILLDOWN[theme.key]} style={chipStyle}>
              Open {drilldownLabel(THEME_DRILLDOWN[theme.key])} →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

const factChipStyle: CSSProperties = {
  fontSize: 10,
  background: COLOR.surfaceAlt,
  border: `1px solid ${COLOR.divider}`,
  borderRadius: RADIUS.chip,
  padding: '2px 6px',
  color: COLOR.textMid,
  lineHeight: 1.4,
};

const chipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  background: COLOR.accentSoft,
  border: `1px solid ${COLOR.accentSoft}`,
  borderRadius: RADIUS.pill,
  padding: '4px 10px',
  color: COLOR.accent,
  textDecoration: 'none',
};

function drilldownLabel(path: string): string {
  if (path.startsWith('/diet')) return 'Diet';
  if (path.startsWith('/strength')) return 'Strength';
  if (path.startsWith('/health')) return 'Health';
  if (path.startsWith('/profile')) return 'Profile';
  if (path.startsWith('/coach')) return 'Coach';
  return 'detail';
}
