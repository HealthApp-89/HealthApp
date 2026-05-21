// app/profile/library/page.tsx
//
// Manage Library — list of the user's user_food_items rows with inline
// delete. SSR-hydrate per the project's TanStack Query convention.

import { redirect } from "next/navigation";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { makeServerQueryClient } from "@/lib/query/queryClient";
import { fetchUserFoodItemsServer } from "@/lib/query/fetchers/userFoodItems";
import { queryKeys } from "@/lib/query/keys";
import { LibraryClient } from "@/components/profile/LibraryClient";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const queryClient = makeServerQueryClient();
  await queryClient.prefetchQuery({
    queryKey: queryKeys.userFoodItems.all(user.id),
    queryFn: () => fetchUserFoodItemsServer(supabase, user.id),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LibraryClient userId={user.id} />
    </HydrationBoundary>
  );
}
