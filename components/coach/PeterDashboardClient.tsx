'use client';

import { usePeterDashboard } from '@/lib/query/hooks/usePeterDashboard';
import { COLOR } from '@/lib/ui/theme';
import { PeterDashboardHero } from './PeterDashboardHero';
import { PeterDashboardGrid } from './PeterDashboardGrid';
import { PeterDashboardRegenButton } from './PeterDashboardRegenButton';

type Props = { userId: string; today: string };

export function PeterDashboardClient({ userId, today }: Props) {
  const { data, isLoading, isError } = usePeterDashboard(userId, today);

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: COLOR.textMuted, fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  if (isError) {
    return (
      <div style={{ padding: 24, color: COLOR.textMuted, fontSize: 13 }}>
        Failed to load.
      </div>
    );
  }

  if (!data) {
    return (
      <div
        style={{
          padding: 24,
          color: COLOR.textMid,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Peter hasn&apos;t generated today&apos;s read yet — running daily at 04:00 UTC.
        Use the regenerate button below to trigger one now.
        <div style={{ marginTop: 16 }}>
          <PeterDashboardRegenButton />
        </div>
      </div>
    );
  }

  const generatedLabel = new Date(data.payload.generated_at).toLocaleString(
    undefined,
    { hour: '2-digit', minute: '2-digit' },
  );

  return (
    <div
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div style={{ fontSize: 11, color: COLOR.textMuted }}>
          Last refreshed {generatedLabel}
          {data.payload.narrative_failed ? ' · narrative failed' : ''}
        </div>
        <PeterDashboardRegenButton />
      </div>
      <PeterDashboardHero
        narrative={data.payload.narrative}
        fallbackHeadline={`On track · v${data.version}`}
      />
      <PeterDashboardGrid payload={data.payload} />
    </div>
  );
}
