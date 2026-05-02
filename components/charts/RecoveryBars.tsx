"use client";

import { useState } from "react";

type Props = {
  data: (number | null)[];
  /** Optional ISO dates parallel to data — enables tap/hover tooltip. */
  dates?: string[];
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateShort(iso: string): string {
  const [, m, d] = iso.split("-");
  if (!m || !d) return iso;
  const monthIdx = parseInt(m, 10) - 1;
  return `${parseInt(d, 10)} ${MONTHS_SHORT[monthIdx] ?? m}`;
}

export function RecoveryBars({ data, dates }: Props) {
  const [active, setActive] = useState<number | null>(null);
  const activeValue = active !== null ? data[active] : null;
  const activeDate = active !== null && dates ? dates[active] : null;

  return (
    <div className="relative" style={{ paddingTop: 22 }}>
      <div className="flex gap-[3px] items-end" style={{ height: 50 }}>
        {data.map((v, i) => {
          const isActive = active === i;
          if (!v) {
            return (
              <div
                key={i}
                className="flex-1 rounded-[2px] cursor-pointer"
                style={{ height: 4, background: "rgba(255,255,255,0.05)" }}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive((cur) => (cur === i ? null : cur))}
                onClick={() => setActive((cur) => (cur === i ? null : i))}
              />
            );
          }
          const col = v >= 67 ? "#30d158" : v >= 34 ? "#ffd60a" : "#ff453a";
          const h = Math.max(8, (v / 100) * 50);
          return (
            <div
              key={i}
              className="flex-1 flex flex-col items-center gap-0.5 cursor-pointer"
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((cur) => (cur === i ? null : cur))}
              onClick={() => setActive((cur) => (cur === i ? null : i))}
            >
              <div className="text-[7px] font-bold" style={{ color: col }}>
                {v}
              </div>
              <div
                className="w-full rounded-[2px]"
                style={{
                  height: h,
                  background: col,
                  opacity: active === null || isActive ? 0.85 : 0.4,
                }}
              />
            </div>
          );
        })}
      </div>

      {active !== null && activeValue !== null && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: `${((active + 0.5) / data.length) * 100}%`,
            top: 0,
            transform: "translateX(-50%)",
          }}
        >
          <div
            className="rounded-md px-2 py-1 text-[10px] font-mono whitespace-nowrap"
            style={{
              background: "rgba(13, 22, 40, 0.95)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "white",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            {activeDate && (
              <span className="text-white/50 mr-1.5">{formatDateShort(activeDate)}</span>
            )}
            <span
              style={{
                color: activeValue >= 67 ? "#30d158" : activeValue >= 34 ? "#ffd60a" : "#ff453a",
              }}
            >
              {activeValue}
              <span className="text-white/40 ml-0.5">%</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
