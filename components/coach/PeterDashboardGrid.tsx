'use client';

import { useState } from 'react';
import type { PeterDashboardPayload, ThemeKey } from '@/lib/data/types';
import { ALL_THEME_KEYS } from '@/lib/coach/peter-dashboard/types';
import { PeterThemeCard } from './PeterThemeCard';

type Props = { payload: PeterDashboardPayload };

export function PeterDashboardGrid({ payload }: Props) {
  const [expanded, setExpanded] = useState<ThemeKey | null>(null);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 8,
      }}
    >
      {ALL_THEME_KEYS.map((k) => {
        const isOpen = expanded === k;
        return (
          <div key={k} style={{ gridColumn: isOpen ? '1 / -1' : 'auto' }}>
            <PeterThemeCard
              theme={payload.facts.themes[k]}
              narrative={payload.narrative?.cards[k]?.narrative_md ?? null}
              expanded={isOpen}
              onToggle={() => setExpanded(isOpen ? null : k)}
            />
          </div>
        );
      })}
    </div>
  );
}
