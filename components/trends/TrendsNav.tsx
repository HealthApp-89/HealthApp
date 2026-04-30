import Link from "next/link";

const SECTIONS = [
  { id: "body", label: "Body" },
  { id: "sleep", label: "Sleep" },
  { id: "training", label: "Training" },
  { id: "strength", label: "Strength" },
  { id: "compare", label: "Compare" },
];

type Props = {
  active: string;
  /** Other querystring keys to preserve when switching section. */
  preserve?: Record<string, string | undefined>;
};

export function TrendsNav({ active, preserve = {} }: Props) {
  return (
    <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
      {SECTIONS.map((s) => {
        const isActive = active === s.id;
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(preserve)) {
          if (v) params.set(k, v);
        }
        params.set("section", s.id);
        return (
          <Link
            key={s.id}
            href={`/trends?${params.toString()}`}
            scroll={false}
            className="flex-none px-3.5 py-1.5 rounded-full text-xs whitespace-nowrap transition-colors"
            style={{
              background: isActive ? "rgba(0,245,196,0.15)" : "transparent",
              border: `1px solid ${isActive ? "rgba(0,245,196,0.5)" : "rgba(255,255,255,0.1)"}`,
              color: isActive ? "#00f5c4" : "rgba(255,255,255,0.4)",
              fontWeight: isActive ? 700 : 400,
            }}
          >
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}
