"use client";

import { COLOR } from "@/lib/ui/theme";
import { SpeakerChip } from "@/components/chat/SpeakerChip";

/** Renders the AI-generated advice prose. The output is constrained to
 *  bold/italic markdown by the prompt — we render it as plain text with
 *  CSS-only emphasis interpretation. Keep this simple: no full markdown
 *  parser, no link rendering. If the prose contains malformed markdown
 *  the user just sees the raw chars — acceptable for v1 since the prompt
 *  caps complexity. */
export function BriefAdvice({ md }: { md: string }) {
  const empty = md.trim().length === 0;
  return (
    <div
      style={{
        background: COLOR.accentSoft,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: COLOR.accentDeep,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Coach
        </div>
        <SpeakerChip speaker="peter" size="sm" />
      </div>
      {empty ? (
        <div
          style={{
            fontSize: 14,
            color: COLOR.textMid,
            lineHeight: 1.6,
            fontStyle: "italic",
          }}
        >
          Writing your advice
          <PulseDots />
        </div>
      ) : (
        <div
          style={{
            fontSize: 14,
            color: COLOR.textStrong,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
          }}
          dangerouslySetInnerHTML={{ __html: lightMarkdown(md) }}
        />
      )}
    </div>
  );
}

function PulseDots() {
  return (
    <span style={{ display: "inline-block", marginLeft: 4 }}>
      <span className="brief-pulse-dot" />
      <span className="brief-pulse-dot" style={{ animationDelay: "0.15s" }} />
      <span className="brief-pulse-dot" style={{ animationDelay: "0.3s" }} />
    </span>
  );
}

/** Minimal markdown subset: **bold** and *italic*. Everything else is
 *  passed through as plain text. HTML-escapes the input first so
 *  user-supplied content cannot inject markup. */
function lightMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}
