"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { COLOR } from "@/lib/ui/theme";
import { Card } from "@/components/ui/Card";
import type { AthleteProfileDocument } from "@/lib/data/types";
import { AthleteProfileViewModal } from "@/components/profile/AthleteProfileViewModal";
import { AthleteProfileHistory } from "@/components/profile/AthleteProfileHistory";
import { useAthleteProfile } from "@/lib/query/hooks/useAthleteProfile";
import { useAthleteProfileHistory } from "@/lib/query/hooks/useAthleteProfileHistory";
import { useAthleteProfileDraft } from "@/lib/query/hooks/useAthleteProfileDraft";
import { startPlanIntake } from "@/app/onboarding/start-plan-intake";

export function AthleteProfilePanel({ userId }: { userId: string }) {
  const { data: active, isLoading: loadingActive } = useAthleteProfile(userId);
  const { data: history = [] } = useAthleteProfileHistory(userId);
  const { data: draft } = useAthleteProfileDraft(userId);
  const [viewing, setViewing] = useState<AthleteProfileDocument | null>(null);

  if (loadingActive) {
    return <Card style={{ height: 80, background: "rgba(255,255,255,0.04)" }}><></></Card>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {draft && draft.id !== active?.id && (
        <Card variant="compact" style={{ borderColor: COLOR.accent }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Draft in progress</div>
              <div style={{ fontSize: 11, color: COLOR.textMuted }}>
                Started {draft.created_at.slice(0, 10)}
              </div>
            </div>
            <Link
              href="/onboarding"
              style={{
                padding: "6px 12px",
                background: COLOR.accent,
                color: "#fff",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Resume
            </Link>
          </div>
        </Card>
      )}

      {!active ? (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Set up your athlete profile</div>
            <div style={{ fontSize: 12, color: COLOR.textMuted }}>
              A 6-step intake captures your medical history, equipment, lifestyle, goals, and baselines.
              The coach uses this as durable context on every reply.
            </div>
            <Link
              href="/onboarding"
              style={{
                marginTop: 4,
                padding: "10px 14px",
                background: COLOR.accent,
                color: "#fff",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                textDecoration: "none",
                textAlign: "center",
              }}
            >
              Get started
            </Link>
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                Athlete profile <span style={{ color: COLOR.textMuted, fontWeight: 500 }}>v{active.version}</span>
              </div>
              <div style={{ fontSize: 11, color: COLOR.textMuted }}>
                Acknowledged {active.acknowledged_at?.slice(0, 10) ?? "—"}
              </div>
            </div>

            <div style={{ fontSize: 12, color: COLOR.textMuted }}>
              {summarizeGoal(active)}
            </div>

            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button type="button" onClick={() => setViewing(active)} style={btn("secondary")}>
                View
              </button>
              <Link href={`/onboarding?revise=${active.id}`} style={btn("primary")}>
                Revise
              </Link>
            </div>
          </div>
        </Card>
      )}

      {active && active.plan_payload === null && <GeneratePlanCta />}

      {history.length > 1 && <AthleteProfileHistory docs={history} />}

      {viewing && viewing.rendered_md && (
        <AthleteProfileViewModal
          rendered_md={viewing.rendered_md}
          title={`Athlete profile v${viewing.version}`}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function summarizeGoal(d: AthleteProfileDocument): string {
  const g = d.intake_payload.goals;
  return `Goal: ${g.primary_metric} → ${g.target_value}${g.target_unit} by ${g.target_date}`;
}

function GeneratePlanCta() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await startPlanIntake();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/coach?mode=intake&doc=${result.doc_id}`);
    });
  }

  return (
    <Card variant="compact" style={{ borderColor: COLOR.accent, background: COLOR.accentSoft }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: COLOR.textStrong }}>
          Your profile is set — now generate the coaching plan
        </div>
        <div style={{ fontSize: 12, color: COLOR.textMid, lineHeight: 1.5 }}>
          A short chat turns the intake into prescribed sleep, nutrition, and
          strength targets the coach references on every reply.
        </div>
        <button
          type="button"
          onClick={handleClick}
          disabled={pending}
          style={{
            marginTop: 4,
            padding: "8px 14px",
            background: COLOR.accent,
            color: "#fff",
            border: "none",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            cursor: pending ? "wait" : "pointer",
            alignSelf: "flex-start",
          }}
        >
          {pending ? "Starting…" : "Generate plan →"}
        </button>
        {error && (
          <div style={{ fontSize: 11, color: "#dc2626" }}>
            Could not start plan intake: {error}
          </div>
        )}
      </div>
    </Card>
  );
}

function btn(variant: "primary" | "secondary"): React.CSSProperties {
  if (variant === "primary") {
    return {
      padding: "8px 12px",
      background: COLOR.accent,
      color: "#fff",
      borderRadius: 8,
      fontSize: 12,
      fontWeight: 700,
      textDecoration: "none",
      border: "none",
      cursor: "pointer",
      display: "inline-block",
    };
  }
  return {
    padding: "8px 12px",
    background: "transparent",
    color: COLOR.textStrong,
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    border: `1px solid ${COLOR.divider}`,
    cursor: "pointer",
    textDecoration: "none",
  };
}
