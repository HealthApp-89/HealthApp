"use client";

import { COLOR } from "@/lib/ui/theme";

/** Renders the AI-generated advice prose. The output is constrained to
 *  bold/italic markdown by the prompt — we render it as plain text with
 *  CSS-only emphasis interpretation. Keep this simple: no full markdown
 *  parser, no link rendering. If the prose contains malformed markdown
 *  the user just sees the raw chars — acceptable for v1 since the prompt
 *  caps complexity. */
export function BriefAdvice({ md }: { md: string }) {
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
          fontSize: 11,
          color: COLOR.accentDeep,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        Coach
      </div>
      <div
        style={{
          fontSize: 14,
          color: COLOR.textStrong,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
        }}
        dangerouslySetInnerHTML={{ __html: lightMarkdown(md) }}
      />
    </div>
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
