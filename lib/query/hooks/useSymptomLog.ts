// lib/query/hooks/useSymptomLog.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import {
  fetchSymptomLogBrowser,
  type SymptomLogEntry,
} from "@/lib/query/fetchers/symptomLog";

/** Recent symptom-log entries (last 30 by default). Surfaced by Health/Log. */
export function useSymptomLog(userId: string, limit = 30) {
  return useQuery<SymptomLogEntry[]>({
    queryKey: queryKeys.symptomLog.list(userId, limit),
    queryFn: () => fetchSymptomLogBrowser(userId, limit),
  });
}
