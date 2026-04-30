import { priorityColor } from "@/lib/ui/colors";

export function PrioBox({ level }: { level: "high" | "medium" | "low" | string }) {
  const c = priorityColor(level);
  return (
    <span
      className="inline-block flex-shrink-0 rounded-full"
      style={{ width: 7, height: 7, background: c, boxShadow: `0 0 5px ${c}` }}
    />
  );
}
