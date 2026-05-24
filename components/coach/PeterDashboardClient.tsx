'use client';

type Props = { userId: string; today: string };

export function PeterDashboardClient({ userId, today }: Props) {
  // Placeholder — Task 15 replaces this with the full hero + grid + accordion UI.
  // userId/today consumed downstream; void here to satisfy strict mode.
  void userId; void today;
  return <div style={{ padding: 24 }}>Loading dashboard…</div>;
}
