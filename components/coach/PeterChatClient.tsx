'use client';

import ChatPanel from '@/components/chat/ChatPanel';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMarkThreadSeen } from '@/lib/chat/use-mark-thread-seen';
import { THEME_LABEL, type ThemeKey } from '@/lib/coach/peter-dashboard/types';
import { COLOR, RADIUS } from '@/lib/ui/theme';

const VALID_THEME_KEYS: ThemeKey[] = [
  'recomp',
  'energy',
  'fatigue',
  'performance',
  'plan_adherence',
  'goal_distance',
];

type Props = {
  userId: string;
};

export function PeterChatClient({ userId }: Props) {
  useMarkThreadSeen('peter');
  const searchParams = useSearchParams();
  const contextRaw = searchParams.get('context');
  const contextTheme = (VALID_THEME_KEYS as string[]).includes(contextRaw ?? '')
    ? (contextRaw as ThemeKey)
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 88px)' }}>
      {contextTheme && (
        <div
          style={{
            margin: '8px 14px 0',
            padding: '6px 10px',
            background: COLOR.accentSoft,
            border: `1px solid ${COLOR.accent}`,
            borderRadius: RADIUS.pill,
            fontSize: 12,
            color: COLOR.accentDeep,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>
            Asking about: <strong>{THEME_LABEL[contextTheme]}</strong>
          </span>
          <Link
            href="/coach?tab=chat"
            style={{ color: COLOR.accentDeep, textDecoration: 'underline', fontSize: 11 }}
          >
            clear
          </Link>
        </div>
      )}
      <ChatPanel userId={userId} embedded={true} initialKind="coach" thread="peter" />
    </div>
  );
}
