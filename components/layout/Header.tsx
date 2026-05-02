import Link from "next/link";
import { TabNav } from "./TabNav";
import { scoreColor, scoreLabel } from "@/lib/ui/colors";

type HeaderProps = {
  email: string | null;
  name: string | null;
  score: number | null;
  whoopSyncedAt: string | null;
};

export function Header({ email, name, score, whoopSyncedAt }: HeaderProps) {
  const sc = scoreColor(score);
  const sl = scoreLabel(score);
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const display = name?.trim() || email?.split("@")[0] || "Athlete";
  return (
    <header
      className="sticky top-0 z-20 px-4 pt-4"
      style={{
        background: "rgba(0,0,0,0.25)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div className="flex justify-between items-center mb-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.2em] text-white/20">APEX HEALTH OS</div>
          <div className="text-lg font-semibold tracking-[-0.02em] mt-px">
            {display}&apos;s Dashboard
          </div>
          <div className="text-[10px] text-white/30 mt-px">{dateStr}</div>
          <div className="mt-1 flex items-center gap-1.5">
            {whoopSyncedAt ? (
              <span className="text-[9px] tracking-[0.05em]" style={{ color: "#0a84ff" }}>
                ● WHOOP synced {formatRelative(whoopSyncedAt)}
              </span>
            ) : (
              <Link href="/api/whoop/auth" className="text-[9px] tracking-[0.05em] text-white/30 hover:text-white">
                ● WHOOP not connected →
              </Link>
            )}
          </div>
        </div>
        {score ? (
          <div className="text-right">
            <div className="text-4xl font-bold font-mono leading-none" style={{ color: sc }}>
              {score}
            </div>
            <div className="text-[9px] uppercase tracking-[0.1em] text-white/30 mt-1">{sl}</div>
          </div>
        ) : (
          <div className="text-[10px] text-white/20 text-right leading-tight">
            No data
            <br />→ Log
          </div>
        )}
      </div>
      <TabNav />
    </header>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - t) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}
