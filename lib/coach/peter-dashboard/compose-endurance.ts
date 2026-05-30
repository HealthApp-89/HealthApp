// lib/coach/peter-dashboard/compose-endurance.ts
//
// Endurance theme — Phase 1 binary signal (ok / warn). 'urgent' reserved
// for Phase 2 (volume spikes, repeated over-cap, missed taper, etc.).
//
// Rules:
//   ok    — prescribed Z2 happened this week within HR cap, OR no prescription
//   warn  — prescribed Z2 didn't happen yet this week, OR went over HR cap,
//           OR endurance pillar not configured (setup CTA)
//
// All deterministic. Reads three sources: the latest acknowledged
// athlete_profile_documents row for endurance_profile, this week's
// training_weeks.endurance_session_plan, and endurance_activities for the
// current ISO week (Monday-anchored, matching the weekly-planning convention).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThemePayload } from './types';
import type { EnduranceActivity } from '@/lib/data/types';
import type {
  EnduranceProfile,
  EnduranceSessionPlan,
} from '@/lib/coach/endurance/types';
import { defaultZ2Cap } from '@/lib/coach/endurance/hr-zones';
import { weekStart as isoWeekStart } from '@/lib/coach/derived';

type Inputs = {
  profile: EnduranceProfile | null;
  weekPlan: EnduranceSessionPlan | null;
  weekActivities: ReadonlyArray<EnduranceActivity>;
};

/** Pure compose function — exposed for unit tests and audit scripts. */
export function composeEnduranceFromInputs(args: Inputs): ThemePayload {
  const { profile, weekPlan, weekActivities } = args;

  // Not configured → surface as setup CTA.
  if (!profile) {
    return {
      key: 'endurance',
      severity: 'warn',
      one_line: 'Setup pending',
      body_md: 'Endurance pillar not configured. Connect Strava and set threshold HR on /profile to start tracking Z2 rides.',
      facts: {
        configured: 0,
      },
      sparkline: null,
      inputs_used: [
        'athlete_profile_documents.endurance_profile',
      ],
    };
  }

  const prescribed = !!weekPlan && Object.keys(weekPlan).some((d) => {
    const e = weekPlan[Number(d) as 0 | 1 | 2 | 3 | 4 | 5 | 6];
    return e != null && e.type !== 'rest';
  });
  const hrCap = profile.threshold_hr ? defaultZ2Cap(profile.threshold_hr) : null;

  // Phase 1 supports a single prescribed Z2 session/week — any matching
  // cycling activity this week counts as "did it happen".
  const completedActivity = weekActivities.find((a) => a.sport === 'cycling') ?? null;
  const overCap = !!(
    hrCap &&
    completedActivity?.avg_hr != null &&
    completedActivity.avg_hr > hrCap
  );
  const didIt = completedActivity != null;
  const lastAct = weekActivities[0] ?? null;

  let severity: ThemePayload['severity'] = 'ok';
  let oneLine = 'On track';
  let bodyMd = 'Endurance work on plan.';
  if (prescribed && !didIt) {
    severity = 'warn';
    oneLine = 'Prescribed Z2 not yet done';
    bodyMd = 'A Z2 ride is prescribed this week but no cycling activity has been recorded yet. Get it on the calendar.';
  } else if (overCap && completedActivity) {
    severity = 'warn';
    const avg = completedActivity.avg_hr ?? 0;
    oneLine = `Z2 over cap (${avg} vs ${hrCap})`;
    bodyMd = `Last Z2 ride averaged ${avg} bpm, above the ${hrCap} bpm cap. Aerobic-base work needs to stay sub-threshold — slow down next time.`;
  } else if (didIt && completedActivity) {
    const dur = Math.round(completedActivity.duration_s / 60);
    const hrLabel = completedActivity.avg_hr != null ? `${completedActivity.avg_hr} bpm` : 'HR not recorded';
    oneLine = `Z2 done · ${dur}min`;
    bodyMd = `Z2 ride completed: ${dur} minutes at avg ${hrLabel}. Inside HR cap — aerobic base work paying in.`;
  } else if (!prescribed) {
    oneLine = 'No prescription';
    bodyMd = 'No endurance prescription this week. Carter or Peter will schedule the next Z2 session.';
  }

  // Facts: keep keys snake_case and values numeric where possible —
  // fabrication check rounds to 0/1/2 decimals, so raw integers are safe.
  const facts: ThemePayload['facts'] = {
    configured: 1,
    prescribed_this_week: prescribed ? 1 : 0,
    did_it_happen: didIt ? 1 : 0,
    hr_cap_bpm: hrCap,
    phase: profile.phase,
    weekly_volume_target_hours: profile.weekly_volume_target_hours,
  };
  if (completedActivity) {
    facts.last_avg_hr_bpm = completedActivity.avg_hr;
    facts.last_duration_min = Math.round(completedActivity.duration_s / 60);
    facts.last_tss = completedActivity.tss;
    // PeterThemeCard renders "View on Strava" nav chip when this fact is a non-empty string.
    if (completedActivity.source === 'strava' && completedActivity.external_id) {
      facts.strava_activity_url = `https://www.strava.com/activities/${completedActivity.external_id}`;
    }
  }
  if (lastAct && lastAct !== completedActivity) {
    // Fall back to most recent activity when no cycling activity this week.
    facts.last_activity_date = lastAct.local_date;
  }

  return {
    key: 'endurance',
    severity,
    one_line: oneLine,
    body_md: bodyMd,
    facts,
    sparkline: null,
    inputs_used: [
      'athlete_profile_documents.endurance_profile',
      'training_weeks.endurance_session_plan',
      'endurance_activities (this week, cycling)',
    ],
  };
}

export async function composeEndurance(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<ThemePayload> {
  const { supabase, userId, today } = args;
  const weekStart = isoWeekStart(today);

  const [profileR, weekR, actsR] = await Promise.all([
    supabase
      .from('athlete_profile_documents')
      .select('endurance_profile')
      .eq('user_id', userId)
      .not('acknowledged_at', 'is', null)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('training_weeks')
      .select('endurance_session_plan')
      .eq('user_id', userId)
      .eq('week_start', weekStart)
      .maybeSingle(),
    supabase
      .from('endurance_activities')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .gte('local_date', weekStart)
      .lte('local_date', today)
      .order('started_at', { ascending: false }),
  ]);

  const profile = (profileR.data?.endurance_profile as EnduranceProfile | null) ?? null;
  const weekPlan = (weekR.data?.endurance_session_plan as EnduranceSessionPlan | null) ?? null;
  const weekActivities = (actsR.data as EnduranceActivity[] | null) ?? [];

  return composeEnduranceFromInputs({ profile, weekPlan, weekActivities });
}
