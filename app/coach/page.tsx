import { redirect } from 'next/navigation';
import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { makeServerQueryClient } from '@/lib/query/queryClient';
import { queryKeys } from '@/lib/query/keys';
import { fetchPeterDashboardServer } from '@/lib/query/fetchers/peterDashboard';
import { PeterDashboardClient } from '@/components/coach/PeterDashboardClient';
import { PeterChatClient } from '@/components/coach/PeterChatClient';
import { ReplaceStateDebug } from '@/components/coach/ReplaceStateDebug';
import { SubPillNav } from '@/components/layout/SubPillNav';
import { todayInUserTz } from '@/lib/time';
import { COLOR } from '@/lib/ui/theme';

export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'chat',      label: 'Chat'      },
];

type SP = {
  searchParams?: Promise<{ tab?: string; context?: string }>;
};

export default async function CoachPage({ searchParams }: SP) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const sp = (await searchParams) ?? {};
  const tab = sp.tab === 'chat' ? 'chat' : 'dashboard';
  const today = todayInUserTz();

  const queryClient = makeServerQueryClient();
  if (tab === 'dashboard') {
    await queryClient.prefetchQuery({
      queryKey: queryKeys.peterDashboard.latest(user.id, today),
      queryFn: () => fetchPeterDashboardServer(supabase, user.id, today),
    });
  }

  return (
    <div style={{ background: COLOR.bg, minHeight: '100dvh' }}>
      <ReplaceStateDebug />
      <SubPillNav pills={TABS} paramName="tab" defaultKey="dashboard" />
      <HydrationBoundary state={dehydrate(queryClient)}>
        {tab === 'dashboard'
          ? <PeterDashboardClient userId={user.id} today={today} />
          : <PeterChatClient userId={user.id} />
        }
      </HydrationBoundary>
    </div>
  );
}
