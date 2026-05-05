import { fmtNum } from "@/lib/ui/score";
import { COLOR } from "@/lib/ui/theme";

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
  ok: { dot: COLOR.success, label: "In range", tint: COLOR.successSoft },
  watch: { dot: COLOR.warning, label: "Watch", tint: COLOR.warningSoft },
  alert: { dot: COLOR.danger, label: "Out of range", tint: COLOR.dangerSoft },
  muted: { dot: COLOR.textFaint, label: "No data", tint: COLOR.surfaceAlt },
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
        background: COLOR.surfaceAlt,
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[10px] uppercase tracking-[0.14em] font-medium"
          style={{ color: COLOR.textMuted }}
        >
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}88` }}
          />
          <span className="text-[9px] uppercase tracking-[0.08em]" style={{ color: COLOR.textMuted }}>
            {tok.label}
          </span>
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-[26px] font-mono font-bold leading-none tabular-nums"
          style={{ color: COLOR.textStrong }}
        >
          {fmtNum(value)}
        </span>
        {unit && (
          <span className="text-[10px] uppercase tracking-[0.08em]" style={{ color: COLOR.textMuted }}>
            {unit}
          </span>
        )}
      </div>
      {detail && (
        <div className="text-[10px] leading-tight" style={{ color: COLOR.textFaint }}>
          {detail}
        </div>
      )}
    </div>
  );
}
