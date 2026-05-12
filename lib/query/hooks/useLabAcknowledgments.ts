import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { queryKeys } from "@/lib/query/keys";
import { fetchLabAcknowledgmentsBrowser, type LabAcks } from "@/lib/query/fetchers/labAcknowledgments";

export function useLabAcknowledgments(userId: string) {
  return useQuery({
    queryKey: queryKeys.labAcks.one(userId),
    queryFn: () => fetchLabAcknowledgmentsBrowser(createSupabaseBrowserClient(), userId),
  });
}

export function useAckLabItem(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, ackedOn }: { key: string; ackedOn: string | null }) => {
      const supabase = createSupabaseBrowserClient();
      const { data: existing } = await supabase
        .from("profiles")
        .select("lab_acknowledgments")
        .eq("user_id", userId)
        .maybeSingle();
      const current = (existing?.lab_acknowledgments ?? {}) as LabAcks;
      const next = { ...current, [key]: ackedOn };
      const { error } = await supabase
        .from("profiles")
        .update({ lab_acknowledgments: next })
        .eq("user_id", userId);
      if (error) throw error;
      return next;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.labAcks.one(userId) });
    },
  });
}
