'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { COLOR, RADIUS } from '@/lib/ui/theme';

type Props = { userId: string };

export function PeterDashboardRegenButton({ userId: _userId }: Props) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

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
      // Re-run the Server Component to SSR-prefetch the new row and rehydrate
      // the TanStack Query cache. We CANNOT use qc.invalidateQueries here —
      // that would trigger a refetch via fetchPeterDashboardBrowser which
      // throws by design (SSR-hydrate-only pattern, see useRecoveryIntelligence).
      router.refresh();
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
