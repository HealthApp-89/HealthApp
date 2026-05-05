import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { RangePills } from "@/components/ui/RangePills";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { COLOR, METRIC_COLOR } from "@/lib/ui/theme";
import { FIELDS, type DailyLogKey } from "@/lib/ui/colors";
import { fmtNum } from "@/lib/ui/score";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";
export const revalidate = 60;

const VALID_KEYS: ReadonlySet<DailyLogKey> = new Set(FIELDS.map((f) => f.k));

type MetricPageProps = {
  params: Promise<{ metric: string }>;
  searchParams: Promise<{ range?: string }>;
};

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

export default async function MetricDetail(props: MetricPageProps) {
  const { metric } = await props.params;
  const sp = await props.searchParams;
  if (!VALID_KEYS.has(metric as DailyLogKey)) notFound();
  const key = metric as DailyLogKey;

  const range = sp.range && RANGE_DAYS[sp.range] ? sp.range : "30d";
  const days = RANGE_DAYS[range];

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Load `days` of daily logs.
  const today = todayInUserTz();
  const startIso = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d - days + 1));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  })();

  const { data: rows } = await supabase
    .from("daily_logs")
    .select(`date, ${key}`)
    .eq("user_id", user.id)
    .gte("date", startIso)
    .lte("date", today)
    .order("date", { ascending: true });

  const field = FIELDS.find((f) => f.k === key)!;
  const data: LinePoint[] = (rows ?? []).map((r) => ({ x: (r as Record<string, unknown>).date as string, y: ((r as Record<string, unknown>)[key] as number | null) ?? null }));
  const present = data.map((d) => d.y).filter((v): v is number => v !== null);

  const min = present.length ? Math.min(...present) : null;
  const max = present.length ? Math.max(...present) : null;
  const avg = present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;

  const rangeOpts = [
    { id: "7d",  label: "7D",  href: `/trends/${metric}?range=7d`  },
    { id: "30d", label: "30D", href: `/trends/${metric}?range=30d` },
    { id: "90d", label: "90D", href: `/trends/${metric}?range=90d` },
    { id: "1y",  label: "1Y",  href: `/trends/${metric}?range=1y`  },
  ];

  // Compute 4 evenly-spaced x-axis date labels.
  const labels: [string, string, string, string] | undefined = data.length >= 4
    ? [
        shortDate(data[0].x ?? ""),
        shortDate(data[Math.floor(data.length / 3)].x ?? ""),
        shortDate(data[Math.floor((2 * data.length) / 3)].x ?? ""),
        shortDate(data[data.length - 1].x ?? ""),
      ]
    : undefined;

  const color = METRIC_COLOR[key];

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "12px 8px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "4px 12px 14px" }}>
        <a href="/trends" style={{ fontSize: "20px", color: COLOR.accent, textDecoration: "none" }}>‹</a>
        <div>
          <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 500 }}>Trends</div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, letterSpacing: "-0.02em" }}>{field.l}</h1>
        </div>
      </div>

      <div style={{ padding: "0 16px 14px" }}>
        <div style={{ fontSize: "12px", color: COLOR.textMuted, fontWeight: 600 }}>{days}-day average</div>
        <div data-tnum style={{ fontSize: "56px", fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1, marginTop: "4px" }}>
          {avg == null ? "—" : fmtNum(avg)}
          {avg != null && <span style={{ fontSize: "22px", fontWeight: 600, color: COLOR.textFaint, marginLeft: "4px" }}>{field.u}</span>}
        </div>
      </div>

      <div style={{ padding: "0 8px 14px" }}>
        <RangePills options={rangeOpts} active={range} />
      </div>

      <div style={{ padding: "0 8px 12px" }}>
        <Card>
          <LineChart data={data} color={color} variant="detail" xAxisLabels={labels} />
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", padding: "0 8px 14px" }}>
        <Card variant="compact">
          <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>MIN</div>
          <div data-tnum style={{ fontSize: "18px", fontWeight: 800, marginTop: "4px" }}>{min == null ? "—" : fmtNum(min)}{min != null && <span style={{ fontSize: "11px", color: COLOR.textFaint, fontWeight: 500, marginLeft: "2px" }}>{field.u}</span>}</div>
        </Card>
        <Card variant="compact">
          <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>AVG</div>
          <div data-tnum style={{ fontSize: "18px", fontWeight: 800, marginTop: "4px" }}>{avg == null ? "—" : fmtNum(avg)}{avg != null && <span style={{ fontSize: "11px", color: COLOR.textFaint, fontWeight: 500, marginLeft: "2px" }}>{field.u}</span>}</div>
        </Card>
        <Card variant="compact">
          <div style={{ fontSize: "10px", color: COLOR.textFaint, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>MAX</div>
          <div data-tnum style={{ fontSize: "18px", fontWeight: 800, marginTop: "4px" }}>{max == null ? "—" : fmtNum(max)}{max != null && <span style={{ fontSize: "11px", color: COLOR.textFaint, fontWeight: 500, marginLeft: "2px" }}>{field.u}</span>}</div>
        </Card>
      </div>
    </div>
  );
}

function shortDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[+m - 1]} ${+d}`;
}
