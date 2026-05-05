"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR, RADIUS } from "@/lib/ui/theme";

type Props = {
  tokenPrefix: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  lastUsedSource: string | null;
  appUrl: string;
};

export function IngestPanel({
  tokenPrefix,
  createdAt,
  lastUsedAt,
  lastUsedSource,
  appUrl,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [strongResult, setStrongResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function rotate() {
    setError(null);
    setRawToken(null);
    startTransition(async () => {
      const res = await fetch("/api/ingest/token", { method: "POST" });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error ?? "rotate_failed");
        return;
      }
      setRawToken(j.token);
      router.refresh();
    });
  }

  function uploadStrong(file: File) {
    setStrongResult(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.append("file", file);
      // Strong import uses the user session — server-side helper supports both
      // bearer token and signed-in user via this same route. We POST as the
      // signed-in user with the file form data.
      const res = await fetch("/api/ingest/strong", { method: "POST", body: fd });
      const j = await res.json();
      if (!j.ok) setStrongResult(`✗ ${j.error ?? j.reason ?? "failed"}`);
      else setStrongResult(`✓ ${j.workouts} workouts · ${j.sets} sets`);
      router.refresh();
    });
  }

  const ingestUrl = `${appUrl}/api/ingest/health`;

  return (
    <Card>
      <SectionLabel>APPLE HEALTH / STRONG / YAZIO</SectionLabel>
      <p
        style={{
          fontSize: "12px",
          color: COLOR.textMuted,
          lineHeight: "1.6",
          marginBottom: "14px",
          marginTop: 0,
        }}
      >
        Generate a personal ingest token, then point an iOS Shortcut at the
        endpoint below. Strong and Yazio data flow through Apple Health (HealthKit)
        — one Shortcut covers all three.
      </p>

      {tokenPrefix ? (
        <div
          style={{
            borderRadius: "12px",
            padding: "12px 14px",
            marginBottom: "12px",
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div>
              <div style={{ fontSize: "11px", fontFamily: "monospace", color: COLOR.textMid }}>
                {tokenPrefix}…{" "}
                <span style={{ color: COLOR.textFaint }}>(hashed in DB)</span>
              </div>
              <div style={{ fontSize: "10px", color: COLOR.textFaint, marginTop: "4px" }}>
                Created · {createdAt ? new Date(createdAt).toLocaleDateString() : "—"}
                {lastUsedAt && (
                  <>
                    {" · Last used · "}
                    {new Date(lastUsedAt).toLocaleString()}
                    {lastUsedSource && ` (${lastUsedSource})`}
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (confirm("Rotate token? The old one stops working immediately.")) rotate();
              }}
              style={{
                background: COLOR.surface,
                border: `1px solid ${COLOR.divider}`,
                borderRadius: RADIUS.input,
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 700,
                color: COLOR.textMid,
                cursor: "pointer",
                opacity: pending ? 0.5 : 1,
                flexShrink: 0,
              }}
            >
              Rotate
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={rotate}
          style={{
            background: COLOR.accent,
            border: "none",
            borderRadius: "12px",
            padding: "10px 16px",
            fontSize: "12px",
            fontWeight: 700,
            color: "#fff",
            cursor: "pointer",
            opacity: pending ? 0.5 : 1,
            marginBottom: "12px",
            display: "block",
          }}
        >
          {pending ? "Generating…" : "Generate ingest token"}
        </button>
      )}

      {rawToken && (
        <div
          style={{
            borderRadius: "12px",
            padding: "12px 14px",
            marginBottom: "12px",
            background: COLOR.accentSoft,
            border: `1px solid ${COLOR.accent}33`,
          }}
        >
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: COLOR.accent,
              marginBottom: "6px",
              fontWeight: 700,
            }}
          >
            Copy this now — won&apos;t be shown again
          </div>
          <code
            style={{
              fontSize: "11px",
              wordBreak: "break-all",
              color: COLOR.textStrong,
              fontFamily: "monospace",
            }}
          >
            {rawToken}
          </code>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(rawToken)}
            style={{
              marginTop: "8px",
              display: "block",
              background: COLOR.surface,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: "8px",
              padding: "4px 10px",
              fontSize: "10px",
              fontWeight: 700,
              color: COLOR.textMid,
              cursor: "pointer",
            }}
          >
            Copy
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            fontSize: "11px",
            fontFamily: "monospace",
            color: COLOR.danger,
            marginBottom: "12px",
          }}
        >
          ✗ {error}
        </div>
      )}

      <div
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: COLOR.textFaint,
          marginTop: "8px",
          marginBottom: "6px",
          fontWeight: 600,
        }}
      >
        Endpoint
      </div>
      <code
        style={{
          fontSize: "11px",
          wordBreak: "break-all",
          color: COLOR.textMid,
          fontFamily: "monospace",
          display: "block",
          marginBottom: "12px",
        }}
      >
        POST {ingestUrl}
      </code>

      <div
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: COLOR.textFaint,
          marginTop: "8px",
          marginBottom: "6px",
          fontWeight: 600,
        }}
      >
        Strong CSV import
      </div>
      <p
        style={{
          fontSize: "11px",
          color: COLOR.textMuted,
          marginBottom: "8px",
          marginTop: 0,
        }}
      >
        Strong → Settings → Export Data → Export to CSV. Upload here:
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadStrong(f);
          if (fileRef.current) fileRef.current.value = "";
        }}
        style={{ fontSize: "11px", color: COLOR.textMuted }}
        className="file:mr-2 file:rounded-md file:border-0 file:px-2.5 file:py-1.5 file:text-[11px] file:cursor-pointer"
      />
      {strongResult && (
        <div
          style={{
            fontSize: "11px",
            fontFamily: "monospace",
            marginTop: "8px",
            color: strongResult.startsWith("✗") ? COLOR.danger : COLOR.accent,
          }}
        >
          {strongResult}
        </div>
      )}
    </Card>
  );
}
