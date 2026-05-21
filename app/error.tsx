"use client";

// Page-level error boundary. Catches errors thrown by any page inside the
// root layout (global-error.tsx only catches root-layout failures, hence
// the original "Application error" wrapper that was hiding the actual
// /diet exception on 2026-05-22). Surfaces the raw error message + stack
// so we can diagnose without browser DevTools.

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: 16,
        maxWidth: 720,
        margin: "40px auto",
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        Page error
      </h1>
      <p style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
        {error.digest ? `digest: ${error.digest}` : "(no digest)"}
      </p>
      <pre
        style={{
          background: "#f6f7fa",
          border: "1px solid #e3e5ed",
          borderRadius: 8,
          padding: 12,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "#b91c1c",
        }}
      >
        {error.message}
        {error.stack ? `\n\n${error.stack}` : ""}
      </pre>
      <button
        type="button"
        onClick={reset}
        style={{
          marginTop: 16,
          padding: "8px 14px",
          background: "#111",
          color: "white",
          border: "none",
          borderRadius: 8,
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
