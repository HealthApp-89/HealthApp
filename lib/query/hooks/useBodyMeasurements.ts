// lib/query/hooks/useBodyMeasurements.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchBodyMeasurementsBrowser } from "@/lib/query/fetchers/bodyMeasurements";

export function useBodyMeasurements(userId: string) {
  return useQuery({
    queryKey: queryKeys.bodyMeasurements.all(userId),
    queryFn: () => fetchBodyMeasurementsBrowser(userId),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}
