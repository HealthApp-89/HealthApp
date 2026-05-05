import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { StatusRow } from "@/components/ui/StatusRow";
import { RangePills } from "@/components/ui/RangePills";
import { MetricCard } from "@/components/charts/MetricCard";
import { LineChart } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";

export default function TokensPage() {
  const sample = [55, 58, 62, 51, 49, 53, 60, 65, 68, 62, 70, 67].map((y, i) => ({
    x: `D${i + 1}`,
    y,
  }));

  return (
    <main style={{ padding: "24px", maxWidth: "640px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "28px", fontWeight: 800, marginBottom: "16px" }}>Token preview</h1>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>Cards</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <Card>Standard card</Card>
        <Card variant="compact">Compact card</Card>
        <Card variant="nested">Nested card</Card>
      </div>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>Pills</h2>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <Pill tone="accent">Accent</Pill>
        <Pill tone="success" leading="▲">Primed</Pill>
        <Pill tone="warning">Moderate</Pill>
        <Pill tone="danger">Recover</Pill>
        <Pill tone="neutral">Neutral</Pill>
      </div>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>StatusRow</h2>
      <Card variant="compact" style={{ padding: 0 }}>
        <StatusRow label="HRV baseline" value="58 ms" href="#" />
        <StatusRow label="Target weight" value="80 kg" href="#" />
        <StatusRow label="Sign out" danger href="#" />
      </Card>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>RangePills</h2>
      <RangePills
        active="30d"
        options={[
          { id: "7d",  label: "7D",  href: "#7d" },
          { id: "30d", label: "30D", href: "#30d" },
          { id: "90d", label: "90D", href: "#90d" },
          { id: "1y",  label: "1Y",  href: "#1y" },
        ]}
      />

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>MetricCard</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <MetricCard color={METRIC_COLOR.hrv}        icon="♥"  label="HRV"        value={68}  unit="ms"  delta={12}   deltaUnit="ms" />
        <MetricCard color={METRIC_COLOR.resting_hr} icon="♥"  label="Resting HR" value={52}  unit="bpm" delta={-3}   deltaUnit="bpm" inverted />
        <MetricCard color={METRIC_COLOR.sleep_hours} icon="☾" label="Sleep"     value={7.8} unit="h"   delta={0.4}  deltaUnit="h" compact trend={sample} />
        <MetricCard color={METRIC_COLOR.strain}     icon="⚡" label="Strain"    value={14.2}            delta={2.1} compact />
      </div>

      <h2 style={{ fontSize: "14px", color: COLOR.textMuted, margin: "16px 0 8px" }}>LineChart detail</h2>
      <Card>
        <LineChart
          data={sample}
          color={METRIC_COLOR.hrv}
          variant="detail"
          xAxisLabels={["Apr 5", "Apr 15", "Apr 25", "May 5"]}
        />
      </Card>
    </main>
  );
}
