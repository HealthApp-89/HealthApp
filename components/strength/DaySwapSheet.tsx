"use client";

import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import {
  useSwapTrainingDay,
  type SwapErrorWithPreview,
} from "@/lib/query/hooks/useSwapTrainingDay";
import type {
  SessionPlan,
  SwapAction,
  SwapConflict,
  Weekday,
} from "@/lib/data/types";

const ORDER: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FULL_NAME: Record<Weekday, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

/** Closed list for action='replace' picker. Object.keys(SESSION_PLANS) already
 *  contains "Mobility"; we append "REST" and dedupe via Set so the user can
 *  swap a training day to a rest day even though REST isn't in SESSION_PLANS. */
const REPLACE_TYPES: string[] = [
  ...new Set<string>([...Object.keys(SESSION_PLANS), "Mobility", "REST"]),
];

type SheetStep =
  | { kind: "action" }
  | { kind: "pick_swap_target" }
  | { kind: "pick_replace_type" }
  | {
      kind: "confirm";
      action: SwapAction;
      target_day?: Weekday;
      session_type?: string;
    }
  | {
      kind: "warn";
      action: SwapAction;
      target_day?: Weekday;
      session_type?: string;
      conflicts: SwapConflict[];
    };

export function DaySwapSheet({
  userId,
  weekStart,
  sourceDay,
  plan,
  onClose,
}: {
  userId: string;
  weekStart: string;
  sourceDay: Weekday;
  plan: SessionPlan;
  onClose: () => void;
}) {
  const [step, setStep] = useState<SheetStep>({ kind: "action" });
  const mutation = useSwapTrainingDay(userId, weekStart);

  const currentType =
    readSessionForDay(plan as Record<string, string>, sourceDay) ?? "—";

  function postWithConfirm(
    confirm: boolean,
    action: SwapAction,
    targetDay: Weekday | undefined,
    sessionType: string | undefined,
  ) {
    const body =
      action === "swap"
        ? {
            action: "swap" as const,
            source_day: sourceDay,
            target_day: targetDay as Weekday,
          }
        : {
            action: "replace" as const,
            source_day: sourceDay,
            session_type: sessionType as string,
          };
    mutation.mutate(
      { body, confirm },
      {
        onSuccess: () => onClose(),
        onError: (err: SwapErrorWithPreview) => {
          if (err.status === 409 && err.preview) {
            setStep({
              kind: "warn",
              action,
              target_day: targetDay,
              session_type: sessionType,
              conflicts: err.preview.conflicts,
            });
          }
          // Other errors fall through; the sheet stays open and mutation.error
          // can be surfaced inline if needed.
        },
      },
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="swap-sheet-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "480px",
          background: COLOR.surface,
          borderTopLeftRadius: "16px",
          borderTopRightRadius: "16px",
          padding: "20px 16px 32px",
          color: COLOR.textStrong,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {step.kind === "action" && (
          <ActionStep
            sourceDay={sourceDay}
            currentType={currentType}
            onPickSwap={() => setStep({ kind: "pick_swap_target" })}
            onPickReplace={() => setStep({ kind: "pick_replace_type" })}
            onCancel={onClose}
          />
        )}

        {step.kind === "pick_swap_target" && (
          <PickSwapTargetStep
            sourceDay={sourceDay}
            currentType={currentType}
            plan={plan}
            onPick={(target_day) =>
              setStep({ kind: "confirm", action: "swap", target_day })
            }
            onBack={() => setStep({ kind: "action" })}
          />
        )}

        {step.kind === "pick_replace_type" && (
          <PickReplaceTypeStep
            sourceDay={sourceDay}
            currentType={currentType}
            onPick={(session_type) =>
              setStep({ kind: "confirm", action: "replace", session_type })
            }
            onBack={() => setStep({ kind: "action" })}
          />
        )}

        {step.kind === "confirm" && (
          <ConfirmStep
            sourceDay={sourceDay}
            currentType={currentType}
            action={step.action}
            target_day={step.target_day}
            session_type={step.session_type}
            plan={plan}
            isPending={mutation.isPending}
            error={mutation.error}
            onConfirm={() =>
              postWithConfirm(
                false,
                step.action,
                step.target_day,
                step.session_type,
              )
            }
            onBack={() =>
              setStep(
                step.action === "swap"
                  ? { kind: "pick_swap_target" }
                  : { kind: "pick_replace_type" },
              )
            }
          />
        )}

        {step.kind === "warn" && (
          <WarnStep
            conflicts={step.conflicts}
            isPending={mutation.isPending}
            error={mutation.error}
            onSwapAnyway={() =>
              postWithConfirm(
                true,
                step.action,
                step.target_day,
                step.session_type,
              )
            }
            onPickDifferent={() =>
              setStep(
                step.action === "swap"
                  ? { kind: "pick_swap_target" }
                  : { kind: "pick_replace_type" },
              )
            }
          />
        )}
      </div>
    </div>
  );
}

// ─── Sub-steps ───────────────────────────────────────────────────────────────

function SheetHeader({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      style={{
        fontSize: "16px",
        fontWeight: 600,
        marginBottom: "12px",
        color: COLOR.textStrong,
      }}
    >
      {children}
    </h2>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "block",
        width: "100%",
        padding: "12px 16px",
        borderRadius: "10px",
        border: `1px solid ${COLOR.divider}`,
        background: COLOR.surfaceAlt,
        color: COLOR.textStrong,
        fontSize: "14px",
        fontWeight: 500,
        textAlign: "left",
        marginBottom: "8px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function TextButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 12px",
        background: "transparent",
        border: "none",
        color: COLOR.textMuted,
        fontSize: "13px",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function ActionStep({
  sourceDay,
  currentType,
  onPickSwap,
  onPickReplace,
  onCancel,
}: {
  sourceDay: Weekday;
  currentType: string;
  onPickSwap: () => void;
  onPickReplace: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <SheetHeader id="swap-sheet-title">
        {FULL_NAME[sourceDay]} · {currentType}
      </SheetHeader>
      <PrimaryButton onClick={onPickSwap}>Swap with another day →</PrimaryButton>
      <PrimaryButton onClick={onPickReplace}>Replace this day →</PrimaryButton>
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onCancel}>Cancel</TextButton>
      </div>
    </>
  );
}

function PickSwapTargetStep({
  sourceDay,
  currentType,
  plan,
  onPick,
  onBack,
}: {
  sourceDay: Weekday;
  currentType: string;
  plan: SessionPlan;
  onPick: (target: Weekday) => void;
  onBack: () => void;
}) {
  const others = ORDER.filter((d) => d !== sourceDay);
  return (
    <>
      <SheetHeader id="swap-sheet-title">
        {FULL_NAME[sourceDay]} · {currentType} → which day?
      </SheetHeader>
      {others.map((d) => {
        const t = readSessionForDay(plan as Record<string, string>, d) ?? "—";
        return (
          <PrimaryButton key={d} onClick={() => onPick(d)}>
            {d} · {t}
          </PrimaryButton>
        );
      })}
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onBack}>← Back</TextButton>
      </div>
    </>
  );
}

function PickReplaceTypeStep({
  sourceDay,
  currentType,
  onPick,
  onBack,
}: {
  sourceDay: Weekday;
  currentType: string;
  onPick: (sessionType: string) => void;
  onBack: () => void;
}) {
  // Filter out the *current* session type so the picker doesn't offer a no-op.
  // A prior swap that left current = Mobility hides Mobility; the original
  // session type is still in the list so the user can swap back via identity-restore.
  const options = REPLACE_TYPES.filter((t) => t !== currentType);
  return (
    <>
      <SheetHeader id="swap-sheet-title">{FULL_NAME[sourceDay]} · what should it be?</SheetHeader>
      {options.map((t) => (
        <PrimaryButton key={t} onClick={() => onPick(t)}>
          {t}
        </PrimaryButton>
      ))}
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onBack}>← Back</TextButton>
      </div>
    </>
  );
}

function ConfirmStep({
  sourceDay,
  currentType,
  action,
  target_day,
  session_type,
  plan,
  isPending,
  error,
  onConfirm,
  onBack,
}: {
  sourceDay: Weekday;
  currentType: string;
  action: SwapAction;
  target_day?: Weekday;
  session_type?: string;
  plan: SessionPlan;
  isPending: boolean;
  error: SwapErrorWithPreview | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const targetDayCurrentType =
    action === "swap" && target_day
      ? (readSessionForDay(plan as Record<string, string>, target_day) ?? "—")
      : "—";
  const afterLabel = action === "swap" ? targetDayCurrentType : (session_type ?? "—");
  return (
    <>
      <SheetHeader id="swap-sheet-title">Confirm</SheetHeader>
      <p
        style={{
          fontSize: "14px",
          color: COLOR.textMid,
          marginBottom: "16px",
          lineHeight: 1.5,
        }}
      >
        {FULL_NAME[sourceDay]} · {currentType} → {afterLabel}
        {action === "swap" && target_day && (
          <>
            <br />
            {FULL_NAME[target_day]} · {targetDayCurrentType} → {currentType}
          </>
        )}
      </p>
      <PrimaryButton onClick={onConfirm} disabled={isPending}>
        {isPending ? "Confirming…" : "Confirm"}
      </PrimaryButton>
      {error && error.status !== 409 && (
        <p
          style={{
            marginTop: "10px",
            fontSize: "13px",
            color: COLOR.danger,
            lineHeight: 1.4,
          }}
          role="alert"
        >
          {error.message || `Request failed: ${error.status}`}
        </p>
      )}
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onBack}>← Back</TextButton>
      </div>
    </>
  );
}

function WarnStep({
  conflicts,
  isPending,
  error,
  onSwapAnyway,
  onPickDifferent,
}: {
  conflicts: SwapConflict[];
  isPending: boolean;
  error: SwapErrorWithPreview | null;
  onSwapAnyway: () => void;
  onPickDifferent: () => void;
}) {
  return (
    <>
      <SheetHeader id="swap-sheet-title">⚠ Heads up</SheetHeader>
      <div
        style={{
          fontSize: "14px",
          color: COLOR.textMid,
          marginBottom: "16px",
          lineHeight: 1.5,
        }}
      >
        {conflicts.map((c) => (
          <p key={`${c.day}-${c.neighbor_day}-${c.session_type}`} style={{ marginBottom: "8px" }}>
            {FULL_NAME[c.neighbor_day]} is already {c.session_type}.
            <br />
            {FULL_NAME[c.day]} + {FULL_NAME[c.neighbor_day]} would be
            back-to-back {c.session_type}.
          </p>
        ))}
      </div>
      <PrimaryButton onClick={onSwapAnyway} disabled={isPending}>
        {isPending ? "Confirming…" : "Swap anyway"}
      </PrimaryButton>
      {error && error.status !== 409 && (
        <p
          style={{
            marginTop: "10px",
            fontSize: "13px",
            color: COLOR.danger,
            lineHeight: 1.4,
          }}
          role="alert"
        >
          {error.message || `Request failed: ${error.status}`}
        </p>
      )}
      <div style={{ marginTop: "12px", textAlign: "center" }}>
        <TextButton onClick={onPickDifferent}>Pick a different target</TextButton>
      </div>
    </>
  );
}
