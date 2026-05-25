'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { COLOR, RADIUS } from '@/lib/ui/theme';
import { queryKeys } from '@/lib/query/keys';

type Props = { userId: string };

export function PeterDashboardRegenButton({ userId }: Props) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();

  async function onClick() {
    setPending(true);
    setErr(null);
    try {
      const res = await fetch('/api/coach/dashboard/regenerate', {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setErr('Daily regen limit reached — try tomorrow.');
        } else {
          setErr(
            (body as { detail?: string; error?: string })?.detail ??
              (body as { detail?: string; error?: string })?.error ??
              'Regenerate failed.',
          );
        }
        return;
      }
      // Wide-prefix invalidation — evicts every (userId, date) key.
      await qc.invalidateQueries({ queryKey: queryKeys.peterDashboard.all(userId) });
    } catch (e) {
      setErr(String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '6px 12px',
          background: pending ? COLOR.surfaceAlt : COLOR.accentSoft,
          border: `1px solid ${COLOR.accentSoft}`,
          borderRadius: RADIUS.pill,
          color: COLOR.accent,
          cursor: pending ? 'wait' : 'pointer',
          opacity: pending ? 0.7 : 1,
        }}
      >
        {pending ? 'Regenerating…' : 'Regenerate'}
      </button>
      {err && (
        <span style={{ fontSize: 10, color: COLOR.danger }}>{err}</span>
      )}
    </div>
  );
}
