import Link from "next/link";

const SECTIONS = [
  { id: "body", label: "Body" },
  { id: "sleep", label: "Sleep" },
  { id: "training", label: "Training" },
  { id: "strength", label: "Strength" },
  { id: "compare", label: "W1 vs W2" },
];

export function TrendsNav({ active }: { active: string }) {
  return (
    <div className="flex gap-1 mb-4 overflow-x-auto pb-0.5 scrollbar-none">
      {SECTIONS.map((s) => {
        const isActive = active === s.id;
        return (
          <Link
            key={s.id}
            href={`/trends?section=${s.id}`}
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
