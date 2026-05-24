// components/health/HealthTrendsClient.tsx
"use client";
import { useRecoveryIntelligence } from "@/lib/query/hooks/useRecoveryIntelligence";
import { useMarkThreadSeen } from "@/lib/chat/use-mark-thread-seen";
import { HrvAutonomicSection } from "@/components/health/trends/HrvAutonomicSection";
import { SleepSection } from "@/components/health/trends/SleepSection";
import { StrainRecoverySection } from "@/components/health/trends/StrainRecoverySection";
import { BodySignalsSection } from "@/components/health/trends/BodySignalsSection";
import { SubjectiveSection } from "@/components/health/trends/SubjectiveSection";
import { MobilityCard } from "@/components/health/trends/MobilityCard";
import { COLOR } from "@/lib/ui/theme";

type Props = { userId: string };

export function HealthTrendsClient({ userId }: Props) {
  useMarkThreadSeen("remi");
  const { data, isLoading, isError, error } = useRecoveryIntelligence(userId);

  if (isLoading || !data) {
    return (
      <div style={{ padding: 24, color: COLOR.textMid, fontSize: 13 }}>
        Loading recovery trends…
      </div>
    );
  }
  if (isError) {
    return (
      <div style={{ padding: 24, color: COLOR.danger, fontSize: 13 }}>
        Couldn't load recovery trends: {(error as Error).message}
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 100 }}>
      <HrvAutonomicSection payload={data} />
      <SleepSection         payload={data} />
      <StrainRecoverySection payload={data} />
      <BodySignalsSection   payload={data} />
      <SubjectiveSection    payload={data} />
      <MobilityCard         payload={data} />
    </div>
  );
}
