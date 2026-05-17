// components/chat/ChatMessage.tsx
"use client";

import { useState } from "react";
import type { ChatMessage as ChatMessageType } from "@/lib/chat/types";
import { COLOR, SHADOW } from "@/lib/ui/theme";
import { renderMarkdownSubset } from "./markdown";
import { CoachAvatar } from "@/components/coach/CoachAvatar";
import { WeekPlanProposalCard, type WeekProposal } from "./WeekPlanProposalCard";
import { BlockProposalCard, type BlockProposal } from "./BlockProposalCard";
import { PlanProposalCard } from "./PlanProposalCard";
import type { PlanPayload } from "@/lib/data/types";

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
            return null;
          })}
        </div>
      </div>
    </div>
  );
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
