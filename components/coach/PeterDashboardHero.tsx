import type { PeterDashboardNarrative } from '@/lib/data/types';
import { COLOR, RADIUS, SHADOW } from '@/lib/ui/theme';

type Props = {
  narrative: PeterDashboardNarrative | null;
  fallbackHeadline: string;
};

export function PeterDashboardHero({ narrative, fallbackHeadline }: Props) {
  return (
    <div
      style={{
        background: COLOR.surface,
        border: `1px solid ${COLOR.divider}`,
        borderRadius: RADIUS.card,
        boxShadow: SHADOW.card,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: COLOR.textMuted,
        }}
      >
        Peter&apos;s read
      </div>
      <h2
        style={{
          fontSize: 18,
          margin: '6px 0 0',
          color: COLOR.textStrong,
          fontWeight: 700,
          lineHeight: 1.25,
        }}
      >
        {narrative?.hero.headline ?? fallbackHeadline}
      </h2>
      {narrative?.hero.body_md && (
        <p
          style={{
            fontSize: 13,
            color: COLOR.textMid,
            margin: '8px 0 0',
            lineHeight: 1.5,
          }}
        >
          {narrative.hero.body_md}
        </p>
      )}
    </div>
  );
}
