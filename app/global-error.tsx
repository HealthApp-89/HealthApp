"use client";

// Surface the underlying error message + stack instead of Next's default
// "Application error: a client-side exception has occurred" wrapper. The
// wrapper is opaque on mobile where DevTools isn't readily available, so
// we render the actual error text in the UI as a fallback debugging
// affordance — see 2026-05-22 /diet client-exception triage.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", padding: 16 }}>
        <div style={{ maxWidth: 720, margin: "40px auto" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            Client error
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
      </body>
    </html>
  );
}
