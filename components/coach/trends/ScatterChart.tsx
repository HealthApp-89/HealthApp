"use client";

import type { CSSProperties } from "react";
import { COLOR } from "@/lib/ui/theme";

export function ScatterChart({
  points,
  slope,
  intercept,
  width = 280,
  height = 140,
  style,
}: {
  points: Array<{ x: number; y: number }>;
  slope: number;
  intercept: number;
  width?: number;
  height?: number;
  style?: CSSProperties;
}) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padX = (maxX - minX) * 0.05 || 1;
  const padY = (maxY - minY) * 0.1 || 1;
  const sx = (x: number) => 20 + ((x - minX + padX) / (maxX - minX + 2 * padX)) * (width - 30);
  const sy = (y: number) => height - 20 - ((y - minY + padY) / (maxY - minY + 2 * padY)) * (height - 30);

  const xLineMin = minX - padX;
  const xLineMax = maxX + padX;
  const yAt = (x: number) => slope * x + intercept;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      <line x1={20} y1={height - 20} x2={width - 10} y2={height - 20} stroke={COLOR.divider} strokeWidth="1" />
      <line x1={20} y1={10} x2={20} y2={height - 20} stroke={COLOR.divider} strokeWidth="1" />
      <line
        x1={sx(xLineMin)}
        y1={sy(yAt(xLineMin))}
        x2={sx(xLineMax)}
        y2={sy(yAt(xLineMax))}
        stroke={COLOR.accent}
        strokeWidth="1.5"
        strokeDasharray="4 2"
      />
      {points.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="3" fill={COLOR.textStrong} />
      ))}
    </svg>
  );
}
