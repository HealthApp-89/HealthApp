// lib/coach/endurance/types.ts — shared types for the endurance pillar.

export type EnduranceDiscipline = "cycling" | "running" | "triathlon";

export type EndurancePhase =
  | "aerobic_base"
  | "build"
  | "race_prep"
  | "taper"
  | "off_season";

export type EnduranceSport = "cycling" | "running" | "swimming" | "other";

export type HrZoneRanges = {
  z1: [number, number];
  z2: [number, number];
  z3: [number, number];
  z4: [number, number];
  z5: [number, number];
};

export type EnduranceProfile = {
  discipline: EnduranceDiscipline;
  phase: EndurancePhase;
  threshold_hr: number | null;
  hr_max: number | null;
  hr_zones: HrZoneRanges | null;
  ftp_watts: number | null;
  threshold_pace_s_per_km: number | null;
  weekly_volume_target_hours: number;
  current_race: { date: string; distance: string } | null;
  set_at: string;
};

export type EnduranceSessionType =
  | "rest"
  | "z2_ride"
  | "z2_run"
  | "tempo"
  | "intervals"
  | "long"
  | "brick";

export type EnduranceSessionEntry = {
  type: EnduranceSessionType;
  sport: EnduranceSport;
  duration_min: number;
  hr_cap?: number;
  hr_target_range?: [number, number];
  description: string;
};

// Keys are weekday numbers 0=Sun .. 6=Sat to match Date#getDay().
export type EnduranceSessionPlan = Partial<Record<0|1|2|3|4|5|6, EnduranceSessionEntry>>;

export type EnduranceFocus = {
  weekly_volume_target_hours: number;
  intensity_distribution: "100_z2" | "80_20" | "polarized" | "pyramidal";
  expected_adaptations: string[];
  notes?: string;
};
