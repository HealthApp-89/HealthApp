// components/chat/markdown.ts
//
// Minimal markdown subset → safe HTML string.
// Supported:
//   **bold**   → <strong>
//   *italic*   → <em>
//   `code`     → <code>
//   line breaks (\n) → <br/>
// Everything else is escaped. No links, lists, headers — kept intentionally
// small to avoid pulling in a markdown library.

const escapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => escapeMap[c]);
}

export function renderMarkdownSubset(input: string): string {
  let s = escapeHtml(input);
  // Inline code first (so its contents aren't further parsed).
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic (single *) — match only when not adjacent to another *
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  // Line breaks
  s = s.replace(/\n/g, "<br/>");
  return s;
}
