import { fmtNum } from "@/lib/ui/score";

type Status = "ok" | "watch" | "alert" | "muted";

type MonitorTileProps = {
  label: string;
  value: number | null;
  unit?: string;
  /** Optional secondary line, e.g. "vs 7d avg 32" */
  detail?: string | null;
  /** ok = green, watch = amber, alert = red, muted = grey/no-data */
  status?: Status;
  /** Decorative left accent color override; defaults from status. */
  accent?: string;
};

const STATUS_TOKENS: Record<Status, { dot: string; label: string; tint: string }> = {
  ok: { dot: "#30d158", label: "In range", tint: "rgba(48,209,88,0.10)" },
  watch: { dot: "#ffd60a", label: "Watch", tint: "rgba(255,214,10,0.10)" },
  alert: { dot: "#ff453a", label: "Out of range", tint: "rgba(255,69,58,0.10)" },
  muted: { dot: "rgba(255,255,255,0.25)", label: "No data", tint: "rgba(255,255,255,0.03)" },
};

/** Compact status tile — vibe-inspired by mobile health apps' "monitor" rows. */
export function MonitorTile({
  label,
  value,
  unit,
  detail,
  status = "muted",
  accent,
}: MonitorTileProps) {
  const tok = STATUS_TOKENS[status];
  const dotColor = accent ?? tok.dot;
  return (
    <div
      className="rounded-[14px] border border-white/[0.06] px-4 py-3 flex flex-col gap-2 min-h-[96px]"
      style={{
        background: `linear-gradient(135deg, ${tok.tint}, rgba(255,255,255,0.015))`,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-medium">
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}88` }}
          />
          <span className="text-[9px] uppercase tracking-[0.08em] text-white/40">{tok.label}</span>
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[26px] font-mono font-bold leading-none tabular-nums text-white/90">
          {fmtNum(value)}
        </span>
        {unit && <span className="text-[10px] text-white/40 uppercase tracking-[0.08em]">{unit}</span>}
      </div>
      {detail && <div className="text-[10px] text-white/35 leading-tight">{detail}</div>}
    </div>
  );
}
