type Props = {
  data: (number | null)[];
};

export function RecoveryBars({ data }: Props) {
  return (
    <div className="flex gap-[3px] items-end" style={{ height: 50 }}>
      {data.map((v, i) => {
        if (!v) {
          return (
            <div
              key={i}
              className="flex-1 rounded-[2px]"
              style={{ height: 4, background: "rgba(255,255,255,0.05)" }}
            />
          );
        }
        const col = v >= 67 ? "#4ade80" : v >= 34 ? "#fbbf24" : "#f87171";
        const h = Math.max(8, (v / 100) * 50);
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
            <div className="text-[7px] font-bold" style={{ color: col }}>
              {v}
            </div>
            <div className="w-full rounded-[2px]" style={{ height: h, background: col, opacity: 0.85 }} />
          </div>
        );
      })}
    </div>
  );
}
