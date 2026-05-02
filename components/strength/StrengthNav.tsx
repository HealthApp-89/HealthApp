import Link from "next/link";

const VIEWS = [
  { id: "recent", label: "Recent" },
  { id: "date", label: "By date" },
] as const;

type Props = {
  active: "recent" | "date";
};

/** Top-of-page sub-tab nav for the Strength page. Mirrors TrendsNav styling. */
export function StrengthNav({ active }: Props) {
  return (
    <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
      {VIEWS.map((v) => {
        const isActive = active === v.id;
        const href = v.id === "recent" ? "/strength" : `/strength?view=${v.id}`;
        return (
          <Link
            key={v.id}
            href={href}
            scroll={false}
            className="flex-none px-3.5 py-1.5 rounded-full text-xs whitespace-nowrap transition-colors"
            style={{
              background: isActive ? "rgba(0,245,196,0.15)" : "transparent",
              border: `1px solid ${isActive ? "rgba(0,245,196,0.5)" : "rgba(255,255,255,0.1)"}`,
              color: isActive ? "#00f5c4" : "rgba(255,255,255,0.4)",
              fontWeight: isActive ? 700 : 400,
            }}
          >
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}
