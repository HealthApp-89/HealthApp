// lib/charts/circumferenceChartConfig.ts
//
// Field list driving the six headline sparklines on /health → Trend.
// The other 8 raw circumferences are exposed via inline expand on the
// latest-measurement table (MeasurementCard), not here.
import type { BodyMeasurement } from "@/lib/data/types";

export type CircumferenceMetric = {
  /** Stable id used in keys/configs. */
  id: string;
  /** Display label. */
  label: string;
  /** Unit shown next to the value. */
  unit: string;
  /** Color for line + icon chip. */
  color: string;
  /** Pull a numeric value out of a BodyMeasurement row, or null if missing. */
  read: (m: BodyMeasurement) => number | null;
};

export const CIRCUMFERENCE_METRICS: CircumferenceMetric[] = [
  {
    id: "mid_waist",
    label: "Mid waist",
    unit: "cm",
    color: "#ef4444",
    read: (m) => m.mid_waist_cm,
  },
  {
    id: "hips",
    label: "Hips",
    unit: "cm",
    color: "#f59e0b",
    read: (m) => m.hips_cm,
  },
  {
    id: "whr",
    label: "Waist : Hips",
    unit: "",
    color: "#a855f7",
    read: (m) => {
      if (m.mid_waist_cm == null || m.hips_cm == null || m.hips_cm === 0) return null;
      return m.mid_waist_cm / m.hips_cm;
    },
  },
  {
    id: "chest",
    label: "Chest",
    unit: "cm",
    color: "#3b82f6",
    read: (m) => m.chest_cm,
  },
  {
    id: "arm_avg",
    label: "Avg upper arm",
    unit: "cm",
    color: "#14b870",
    read: (m) => {
      if (m.left_upper_arm_cm == null || m.right_upper_arm_cm == null) return null;
      return (m.left_upper_arm_cm + m.right_upper_arm_cm) / 2;
    },
  },
  {
    id: "thigh_avg",
    label: "Avg thigh",
    unit: "cm",
    color: "#06b6d4",
    read: (m) => {
      if (m.left_thigh_cm == null || m.right_thigh_cm == null) return null;
      return (m.left_thigh_cm + m.right_thigh_cm) / 2;
    },
  },
];
