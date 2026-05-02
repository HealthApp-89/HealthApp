/** Generic placeholder used while a Suspense-bound child fetches data.
 *  Matches the height of the WeeklyRollups block so we don't shift layout
 *  when the real content streams in. */
export function SkeletonCard({ height = 320, label }: { height?: number; label?: string }) {
  return (
    <div
      aria-busy
      className="rounded-[14px] border border-white/[0.06] bg-white/[0.025] flex flex-col gap-2.5 p-4"
      style={{ height }}
    >
      {label && (
        <div className="text-[10px] uppercase tracking-[0.12em] text-white/25">{label}</div>
      )}
      <div className="flex-1 flex flex-col gap-2 animate-pulse">
        <div className="h-6 w-1/3 rounded bg-white/[0.05]" />
        <div className="h-2 w-full rounded bg-white/[0.04]" />
        <div className="h-2 w-5/6 rounded bg-white/[0.04]" />
        <div className="h-2 w-4/6 rounded bg-white/[0.04]" />
      </div>
    </div>
  );
}
