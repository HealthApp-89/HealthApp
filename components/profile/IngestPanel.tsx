"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel } from "@/components/ui/Card";

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
      <SectionLabel>📲 APPLE HEALTH / STRONG / YAZIO</SectionLabel>
      <p className="text-xs text-white/40 leading-relaxed mb-3">
        Generate a personal ingest token, then point an iOS Shortcut at the
        endpoint below. Strong and Yazio data flow through Apple Health (HealthKit)
        — one Shortcut covers all three.
      </p>

      {tokenPrefix ? (
        <div
          className="rounded-[12px] px-3.5 py-3 mb-3"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-mono text-white/70">
                {tokenPrefix}…{" "}
                <span className="text-white/30">(hashed in DB)</span>
              </div>
              <div className="text-[10px] text-white/30 mt-1">
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
              className="rounded-[10px] px-3 py-1.5 text-[11px] disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)" }}
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
          className="rounded-[12px] px-4 py-2.5 text-xs font-bold mb-3 disabled:opacity-50"
          style={{ background: "rgba(0,245,196,0.15)", border: "1px solid #00f5c455", color: "#00f5c4" }}
        >
          {pending ? "Generating…" : "🔑 Generate ingest token"}
        </button>
      )}

      {rawToken && (
        <div
          className="rounded-[12px] px-3.5 py-3 mb-3"
          style={{ background: "rgba(0,245,196,0.08)", border: "1px solid #00f5c455" }}
        >
          <div className="text-[10px] uppercase tracking-[0.12em] text-[#00f5c4] mb-1.5">
            Copy this now — won&apos;t be shown again
          </div>
          <code className="text-[11px] break-all text-white/85 font-mono">{rawToken}</code>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(rawToken)}
            className="mt-2 rounded-[8px] px-2.5 py-1 text-[10px]"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)" }}
          >
            Copy
          </button>
        </div>
      )}

      {error && (
        <div className="text-[11px] font-mono mb-3" style={{ color: "#ff6b6b" }}>
          ✗ {error}
        </div>
      )}

      <div className="text-[10px] uppercase tracking-[0.12em] text-white/40 mt-2 mb-1.5">
        Endpoint
      </div>
      <code className="text-[11px] break-all text-white/70 font-mono block mb-3">
        POST {ingestUrl}
      </code>

      <div className="text-[10px] uppercase tracking-[0.12em] text-white/40 mt-2 mb-1.5">
        Strong CSV import
      </div>
      <p className="text-[11px] text-white/40 mb-2">
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
        className="text-[11px] text-white/60 file:mr-2 file:rounded-md file:border-0 file:bg-white/10 file:px-2.5 file:py-1.5 file:text-[11px] file:text-white/80 file:cursor-pointer"
      />
      {strongResult && (
        <div
          className="text-[11px] font-mono mt-2"
          style={{ color: strongResult.startsWith("✗") ? "#ff6b6b" : "#00f5c4" }}
        >
          {strongResult}
        </div>
      )}
    </Card>
  );
}
