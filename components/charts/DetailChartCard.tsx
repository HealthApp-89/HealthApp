// components/charts/DetailChartCard.tsx
import { Card } from "@/components/ui/Card";
import { RangePills } from "@/components/ui/RangePills";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { COLOR } from "@/lib/ui/theme";
import type { DailyLogKey } from "@/lib/ui/colors";

type RangeOption = { id: string; label: string; href: string };

type Props = {
  /** Title in the top-left of the card chrome. */
  title: string;
  data: LinePoint[];
  comparison: LinePoint[] | null;
  color: string;
  metricKey: DailyLogKey;
  rangeOptions: RangeOption[];
  activeRange: string;
  /** Period descriptor for the legend chip text — e.g. "30 days". */
  periodLabel: string;
  xAxisLabels?: [string, string, string, string];
};

/**
 * Detail chart card chrome. Two rows:
 *   row 1: title + inline legend chips (current / prior period)
 *   row 2: range pills (right-aligned)
 * Two rows because the combined width overflows at 360px viewports.
 */
export function DetailChartCard({
  title,
  data,
  comparison,
  color,
  metricKey,
  rangeOptions,
  activeRange,
  periodLabel,
  xAxisLabels,
}: Props) {
  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "10px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: COLOR.textStrong,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {title}
          </span>
          <div style={{ display: "flex", gap: "12px", fontSize: "10px", color: COLOR.textMid, fontWeight: 600 }}>
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: color,
                  marginRight: "5px",
                  verticalAlign: "middle",
                }}
              />
              This {periodLabel}
            </span>
            {comparison && (
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#cdd1de",
                    marginRight: "5px",
                    verticalAlign: "middle",
                  }}
                />
                Prior {periodLabel}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <RangePills options={rangeOptions} active={activeRange} />
        </div>
      </div>
      <LineChart
        data={data}
        comparison={comparison}
        color={color}
        variant="detail"
        metricKey={metricKey}
        xAxisLabels={xAxisLabels}
      />
    </Card>
  );
}
