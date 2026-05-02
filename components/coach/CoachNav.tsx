import Link from "next/link";

export type CoachView = "today" | "last-week" | "next-week";

const TABS: { id: CoachView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "last-week", label: "Last week" },
  { id: "next-week", label: "Next week" },
];

export function CoachNav({ active }: { active: CoachView }) {
  return (
    <div
      className="inline-flex rounded-full p-1 gap-1"
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      {TABS.map((t) => {
        const is = t.id === active;
        return (
          <Link
            key={t.id}
            href={`/coach?view=${t.id}`}
            className="px-3.5 py-1.5 rounded-full text-[11px] font-semibold transition-colors"
            style={
              is
                ? { background: "rgba(0,245,196,0.18)", color: "#00f5c4", border: "1px solid #00f5c455" }
                : { color: "rgba(255,255,255,0.55)", border: "1px solid transparent" }
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
