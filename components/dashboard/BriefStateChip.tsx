"use client";

import Link from "next/link";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { useIntakeState } from "@/lib/query/hooks/useIntakeState";

/**
 * Compact pill between WeekStrip and ReadinessHero on /, reflecting today's
 * `checkins.intake_state`. Hidden in default cases (no extra vertical space).
 *
 * State mapping (IntakeState union → pill variant):
 *   brief_delivered                                                       → accentSoft "Today's brief is ready"  → /coach
 *   pending | awaiting_feel | awaiting_sickness_notes |                  →
 *     awaiting_whoop                                                      → warningSoft "Continue check-in"      → /coach
 *   brief_failed                                                          → dangerSoft "Brief retry available"   → /coach?retry=brief
 *   assembling_brief | delivered                                          → hidden (transient — intake complete,
 *                                                                            brief assembling async; no CTA target)
 *   null (no row yet)                                                     → hidden
 */
export function BriefStateChip({
  userId,
  todayIso,
}: {
  userId: string;
  todayIso: string;
}) {
  const { data: state } = useIntakeState(userId, todayIso);

  if (!state) return null;
  // Both "assembling_brief" and "delivered" mean the intake questionnaire is
  // finished and the brief is being assembled. Routing the user to /coach
  // with a "Resume morning check-in" CTA in these states is a dead-end —
  // there are no more questions to answer and the brief isn't ready yet.
  if (state === "assembling_brief" || state === "delivered") return null;

  const config = (() => {
    switch (state) {
      case "brief_delivered":
        return {
          bg: COLOR.accentSoft,
          fg: COLOR.accentDeep,
          label: "✓ Today's brief is ready",
          cta: "Open in chat →",
          href: "/coach",
        };
      case "pending":
      case "awaiting_feel":
      case "awaiting_sickness_notes":
      case "awaiting_whoop":
        return {
          bg: COLOR.warningSoft,
          fg: COLOR.warningDeep,
          label: "Continue morning check-in",
          cta: "Resume →",
          href: "/coach",
        };
      case "brief_failed":
        return {
          bg: COLOR.dangerSoft,
          fg: COLOR.dangerDeep,
          label: "Brief retry available",
          cta: "Retry →",
          href: "/coach?retry=brief",
        };
      default:
        return null;
    }
  })();

  if (!config) return null;

  return (
    <Link
      href={config.href}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: config.bg,
        color: config.fg,
        padding: "10px 14px",
        borderRadius: RADIUS.pill,
        textDecoration: "none",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <span>{config.label}</span>
      <span>{config.cta}</span>
    </Link>
  );
}
