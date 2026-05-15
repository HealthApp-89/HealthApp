// components/chat/ChatMessage.tsx
"use client";

import { useState } from "react";
import type { ChatMessage as ChatMessageType } from "@/lib/chat/types";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import { renderMarkdownSubset } from "./markdown";
import { WeekPlanProposalCard, type WeekProposal } from "./WeekPlanProposalCard";
import { BlockProposalCard, type BlockProposal } from "./BlockProposalCard";
import { PlanProposalCard } from "./PlanProposalCard";
import type { PlanPayload } from "@/lib/data/types";

export function ChatMessage({
  message,
  onRetry,
  onSendUserMessage,
  onFocusComposer,
}: {
  message: ChatMessageType;
  onRetry?: () => void;
  onSendUserMessage?: (text: string) => void;
  onFocusComposer?: (placeholder: string) => void;
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

  // Meta row: time · author · optional kind tag
  const timeStr = new Date(message.created_at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const author = isUser ? "You" : "Coach";
  const kindTag =
    message.kind === "morning_intake"
      ? " · Morning check-in"
      : message.kind === "morning_brief"
        ? " · Morning brief"
        : message.kind === "weekly_review"
          ? " · Weekly review"
          : "";
  const metaText = `${timeStr} · ${author}${kindTag}`;

  return (
    <div style={{ padding: "6px 12px" }}>
      <div
        style={{
          fontSize: 9,
          color: COLOR.textMuted,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          marginBottom: 4,
          textAlign: isUser ? "right" : "left",
        }}
      >
        {metaText}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: isUser ? "flex-end" : "flex-start",
        }}
      >
        <div
          style={{
            maxWidth: "85%",
            background: isUser ? COLOR.accentSoft : "transparent",
            color: isUser ? COLOR.textStrong : COLOR.textMid,
            borderRadius: isUser ? RADIUS.cardSmall : 0,
            padding: isUser ? "10px 12px" : "0",
            fontSize: 13,
            lineHeight: 1.5,
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
              style={{
                display: "inline-block",
                width: 6,
                height: 16,
                marginLeft: 2,
                background: COLOR.textMid,
                verticalAlign: "middle",
                opacity: 0.7,
                animation: "pulse 1s infinite",
              }}
            />
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
      </div>

      {/* Proposal cards — rendered below the text block, assistant-only. */}
      {!isUser &&
        toolCalls.map((call, i) => {
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
