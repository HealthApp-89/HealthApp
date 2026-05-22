// components/chat/ChatMessage.tsx
"use client";

import { useState } from "react";
import type { ChatMessage as ChatMessageType } from "@/lib/chat/types";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { renderMarkdownSubset } from "./markdown";
import { CoachAvatar } from "@/components/coach/CoachAvatar";
import { SpeakerChip } from "./SpeakerChip";
import { isCoachSpeaker } from "@/lib/coach/speakers";
import { WeekPlanProposalCard, type WeekProposal } from "./WeekPlanProposalCard";
import { BlockProposalCard, type BlockProposal } from "./BlockProposalCard";
import { PlanProposalCard } from "./PlanProposalCard";
import { NutritionTargetsProposalCard, type NutritionTargetsProposal } from "./NutritionTargetsProposalCard";
import { SessionTodayProposalCard, type SessionTodayProposal } from "@/components/chat/SessionTodayProposalCard";
import { SessionTemplateProposalCard, type SessionTemplateProposal } from "@/components/chat/SessionTemplateProposalCard";
import { MealLogProposalCard, type MealLogProposal } from "@/components/chat/MealLogProposalCard";
import type { PlanPayload, Speaker } from "@/lib/data/types";

export function ChatMessage({
  message,
  onRetry,
  onSendUserMessage,
  onFocusComposer,
  isFirstInGroup = true,
}: {
  message: ChatMessageType;
  onRetry?: () => void;
  onSendUserMessage?: (text: string) => void;
  onFocusComposer?: (placeholder: string) => void;
  /** When false, suppress the coach avatar so consecutive coach turns indent
   *  the same amount without restating identity on every bubble. Defaults
   *  true so isolated callers (e.g. tests) still see the avatar. */
  isFirstInGroup?: boolean;
}) {
  // Hide approval messages — they're implementation detail, not conversation.
  if (message.role === "user" && message.content.startsWith("[approve:")) {
    return null;
  }

  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const isError = message.status === "error";

  // Determine if a commit tool ran successfully in this message's tool_calls.
  const toolCalls = message.tool_calls ?? [];
  const hasCommittedBlock = toolCalls.some(
    (c) => c.name === "commit_block" && !c.error,
  );
  const hasCommittedWeek = toolCalls.some(
    (c) => c.name === "commit_week_plan" && !c.error,
  );
  const hasCommittedPlan = toolCalls.some(
    (c) => c.name === "commit_plan" && !c.error,
  );
  const hasCommittedNutritionTargets = toolCalls.some(
    (c) => c.name === "commit_nutrition_targets" && !c.error,
  );
  const hasCommittedSessionToday = toolCalls.some(
    (c) => c.name === "commit_session_today" && !c.error,
  );
  const hasCommittedSessionTemplate = toolCalls.some(
    (c) => c.name === "commit_session_template" && !c.error,
  );
  const hasCommittedMealLog = toolCalls.some(
    (c) => c.name === "commit_meal_log" && !c.error,
  );

  if (isUser) {
    return (
      <div style={{ padding: "0 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div
            style={{
              maxWidth: "78%",
              background: COLOR.surfaceAlt,
              color: COLOR.textStrong,
              padding: "10px 14px",
              borderRadius: "16px 16px 4px 16px",
              fontSize: 14,
              lineHeight: 1.42,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {message.images.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    message.images.length === 1 ? "1fr" : "1fr 1fr",
                  gap: 6,
                  marginBottom: message.content ? 8 : 0,
                }}
              >
                {message.images.map((img) => (
                  <ImageThumb key={img.id} url={img.signed_url} />
                ))}
              </div>
            )}
            {message.content && (
              <span
                dangerouslySetInnerHTML={{
                  __html: renderMarkdownSubset(message.content),
                }}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  // Coach turn — avatar (or 26px spacer when not first in group) + bubble.
  return (
    <div style={{ padding: "0 12px", marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ width: 26, flexShrink: 0 }}>
          {isFirstInGroup && <CoachAvatar size={26} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Speaker chip — identifies which coach (Peter/Carter/Nora/Remi)
              owns this turn. Only rendered as the first bubble in a group
              of same-speaker turns; consecutive turns from the same coach
              skip the chip to match the avatar's grouping cadence. */}
          {isFirstInGroup && isCoachSpeaker(message.speaker) && (
            <div style={{ marginBottom: 4 }}>
              <SpeakerChip speaker={message.speaker as Speaker} />
            </div>
          )}
          <div
            style={{
              background: COLOR.surface,
              color: COLOR.textMid,
              padding: "10px 14px",
              borderRadius: 14,
              boxShadow: SHADOW.card,
              fontSize: 14,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {message.images.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    message.images.length === 1 ? "1fr" : "1fr 1fr",
                  gap: 6,
                  marginBottom: message.content ? 8 : 0,
                }}
              >
                {message.images.map((img) => (
                  <ImageThumb key={img.id} url={img.signed_url} />
                ))}
              </div>
            )}

            {message.content && (
              <span
                dangerouslySetInnerHTML={{
                  __html: renderMarkdownSubset(message.content),
                }}
              />
            )}

            {isStreaming && (
              <span
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  gap: 4,
                  alignItems: "center",
                  marginLeft: 4,
                  verticalAlign: "middle",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: COLOR.textMuted,
                    animation:
                      "chat-pulse-dot 1.2s ease-in-out infinite",
                  }}
                />
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: COLOR.textMuted,
                    animation:
                      "chat-pulse-dot 1.2s ease-in-out infinite 0.2s",
                  }}
                />
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: COLOR.textMuted,
                    animation:
                      "chat-pulse-dot 1.2s ease-in-out infinite 0.4s",
                  }}
                />
              </span>
            )}

            {isError && (
              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: COLOR.danger,
                  }}
                >
                  {message.error ?? "error"}
                </span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: COLOR.accent,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      padding: 0,
                      textDecoration: "underline",
                    }}
                  >
                    retry
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Proposal cards — rendered below the text block, assistant-only. */}
          {toolCalls.map((call, i) => {
            if (!call.result) return null;
            // propose_plan uses a different shape: { approval_token, plan_payload }
            // (no `preview` key). Branch on tool name before destructuring.
            if (call.name === "propose_plan") {
              const r = call.result as {
                approval_token?: string;
                plan_payload?: PlanPayload;
              };
              if (!r.approval_token || !r.plan_payload) return null;
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <PlanProposalCard
                    plan={r.plan_payload}
                    approval_token={r.approval_token}
                    committed={hasCommittedPlan}
                    currentBlockWeek={null}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                  />
                </div>
              );
            }

            const result = call.result as {
              preview?: unknown;
              approval_token?: string;
            };
            if (!result.preview || !result.approval_token) return null;

            if (call.name === "propose_week_plan") {
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <WeekPlanProposalCard
                    proposal={result.preview as WeekProposal}
                    approvalToken={result.approval_token}
                    committed={hasCommittedWeek}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                    onTweak={() =>
                      onFocusComposer?.("e.g., 'make Friday Arms instead'")
                    }
                  />
                </div>
              );
            }
            if (call.name === "propose_block") {
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <BlockProposalCard
                    proposal={result.preview as BlockProposal}
                    approvalToken={result.approval_token}
                    committed={hasCommittedBlock}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                    onTweak={() =>
                      onFocusComposer?.(
                        "e.g., 'change the goal to bench instead'",
                      )
                    }
                  />
                </div>
              );
            }
            if (call.name === "propose_nutrition_targets") {
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <NutritionTargetsProposalCard
                    proposal={result.preview as NutritionTargetsProposal}
                    approvalToken={result.approval_token}
                    committed={hasCommittedNutritionTargets}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                    onTweak={() =>
                      onFocusComposer?.("e.g., 'lower kcal to 1800'")
                    }
                  />
                </div>
              );
            }
            if (call.name === "propose_session_today") {
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <SessionTodayProposalCard
                    proposal={result.preview as SessionTodayProposal}
                    approvalToken={result.approval_token}
                    committed={hasCommittedSessionToday}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                    onTweak={() =>
                      onFocusComposer?.("e.g., 'swap the curls for hammer curls'")
                    }
                  />
                </div>
              );
            }
            if (call.name === "propose_session_template") {
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <SessionTemplateProposalCard
                    proposal={result.preview as SessionTemplateProposal}
                    approvalToken={result.approval_token}
                    committed={hasCommittedSessionTemplate}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                    onTweak={() =>
                      onFocusComposer?.("e.g., 'add a triceps finisher'")
                    }
                  />
                </div>
              );
            }
            if (call.name === "propose_meal_log") {
              return (
                <div key={i} style={{ marginTop: 8 }}>
                  <MealLogProposalCard
                    proposal={result.preview as MealLogProposal}
                    approvalToken={result.approval_token}
                    committed={hasCommittedMealLog}
                    onApprove={(token) =>
                      onSendUserMessage?.(`[approve:${token}]`)
                    }
                    onTweak={() =>
                      onFocusComposer?.("e.g., 'change rice to 200g' or 'add a banana'")
                    }
                  />
                </div>
              );
            }
            return null;
          })}

          {/* Inline confirmation chips for library + meal-log writes.
              The full proposal cards above need an approval_token; these
              fire-and-confirm tools just produce a one-line receipt so the
              athlete can see that 8× save_to_library actually ran (vs the
              2026-05-21 silent-save loop).
              Wrapped in try/catch so a single malformed legacy row can't
              tear down the whole chat thread render. */}
          {toolCalls.map((call, i) => {
            let chip: React.ReactNode = null;
            try {
              chip = renderToolReceiptChip(call);
            } catch {
              chip = null;
            }
            if (!chip) return null;
            return (
              <div key={`receipt-${i}`} style={{ marginTop: 6 }}>
                {chip}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function renderToolReceiptChip(call: {
  name: string;
  input: Record<string, unknown>;
  error: string | null;
  result?: unknown;
}): React.ReactNode {
  const RECEIPT_TOOLS = new Set([
    "save_to_library",
    "search_library",
    "pick_library_item",
  ]);
  if (!RECEIPT_TOOLS.has(call.name)) return null;

  const styleBase = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    lineHeight: 1.3,
    background: COLOR.surfaceAlt,
    color: COLOR.textMid,
    border: `1px solid ${COLOR.divider}`,
  } as const;
  const errStyle = {
    ...styleBase,
    background: "rgba(220, 64, 64, 0.08)",
    color: COLOR.danger,
    borderColor: "rgba(220, 64, 64, 0.4)",
  } as const;

  if (call.error) {
    return (
      <span style={errStyle}>
        ✗ {call.name.replace(/_/g, " ")}: {call.error}
      </span>
    );
  }

  if (call.name === "save_to_library") {
    const r = (call.result ?? {}) as {
      name?: string;
      kind?: "item" | "recipe";
      was_duplicate?: boolean;
    };
    const name = r.name ?? (call.input.name as string) ?? "item";
    const label = r.was_duplicate ? "Already in library" : r.kind === "recipe" ? "Saved recipe" : "Saved";
    return (
      <span style={styleBase}>
        <span aria-hidden="true">{r.was_duplicate ? "↻" : "✓"}</span>
        <span>{label}: {name}</span>
      </span>
    );
  }

  if (call.name === "search_library") {
    const r = (call.result ?? {}) as { items?: Array<{ name: string }> };
    const q = (call.input.query as string) ?? "";
    const n = r.items?.length ?? 0;
    return (
      <span style={styleBase}>
        <span aria-hidden="true">🔎</span>
        <span>
          Searched library for &ldquo;{q}&rdquo; — {n} hit{n === 1 ? "" : "s"}
        </span>
      </span>
    );
  }

  if (call.name === "pick_library_item") {
    return (
      <span style={styleBase}>
        <span aria-hidden="true">↳</span>
        <span>Swapped item with library row</span>
      </span>
    );
  }
  return null;
}

function ImageThumb({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: "block",
          width: "100%",
          aspectRatio: "1 / 1",
          overflow: "hidden",
          borderRadius: 8,
          background: COLOR.surfaceAlt,
          border: `1px solid ${COLOR.divider}`,
          padding: 0,
          cursor: "zoom-in",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(0,0,0,0.8)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt=""
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        </div>
      )}
    </>
  );
}
