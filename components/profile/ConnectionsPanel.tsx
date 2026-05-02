"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel } from "@/components/ui/Card";

type Props = {
  whoopConnected: boolean;
  whoopUpdatedAt: string | null;
  withingsConnected: boolean;
  withingsUpdatedAt: string | null;
};

export function ConnectionsPanel({
  whoopConnected,
  whoopUpdatedAt,
  withingsConnected,
  withingsUpdatedAt,
}: Props) {
  return (
    <Card tint="steps">
      <SectionLabel>🔗 CONNECTIONS</SectionLabel>
      <div className="flex flex-col gap-2.5">
        <ProviderRow
          name="WHOOP"
          desc="Recovery, sleep, strain"
          connected={whoopConnected}
          updatedAt={whoopUpdatedAt}
          authUrl="/api/whoop/auth"
          syncUrl="/api/whoop/sync"
          backfillUrl="/api/whoop/backfill"
          color="#00f5c4"
        />
        <ProviderRow
          name="Withings"
          desc="Weight, body fat, steps"
          connected={withingsConnected}
          updatedAt={withingsUpdatedAt}
          authUrl="/api/withings/auth"
          syncUrl="/api/withings/sync"
          backfillUrl="/api/withings/backfill"
          disconnectUrl="/api/withings/disconnect"
          color="#4fc3f7"
        />
      </div>
    </Card>
  );
}

function ProviderRow({
  name,
  desc,
  connected,
  updatedAt,
  authUrl,
  syncUrl,
  backfillUrl,
  disconnectUrl,
  color,
}: {
  name: string;
  desc: string;
  connected: boolean;
  updatedAt: string | null;
  authUrl: string;
  syncUrl: string;
  backfillUrl?: string;
  disconnectUrl?: string;
  color: string;
}) {
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState<string | null>(null);
  const router = useRouter();

  function callJson(url: string, method: "GET" | "POST", label: string) {
    setFlash(null);
    startTransition(async () => {
      const res = await fetch(url, { method });
      const j = await res.json();
      if (!j.ok) setFlash(`✗ ${label}: ${j.error ?? j.reason ?? "failed"}`);
      else if (j.upserted != null) setFlash(`✓ ${label}: ${j.upserted} days`);
      else setFlash(`✓ ${label}`);
      router.refresh();
    });
  }

  return (
    <div
      className="rounded-[12px] px-3.5 py-3 flex flex-col gap-2"
      style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${color}1c` }}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-bold" style={{ color }}>{name}</div>
          <div className="text-[10px] text-white/40 mt-0.5">{desc}</div>
          {connected && updatedAt && (
            <div className="text-[10px] font-mono text-white/30 mt-1">
              Last sync · {new Date(updatedAt).toLocaleString()}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {!connected ? (
            <a
              href={authUrl}
              className="rounded-[10px] px-3 py-1.5 text-[11px] font-bold"
              style={{ background: `${color}22`, border: `1px solid ${color}55`, color }}
            >
              Connect
            </a>
          ) : (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => callJson(syncUrl, "GET", "Sync")}
                className="rounded-[10px] px-2.5 py-1.5 text-[11px] disabled:opacity-50"
                style={{ background: `${color}18`, border: `1px solid ${color}44`, color }}
              >
                {pending ? "…" : "Sync"}
              </button>
              {backfillUrl && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => callJson(backfillUrl, "POST", "Backfill")}
                  className="rounded-[10px] px-2.5 py-1.5 text-[11px] disabled:opacity-50"
                  style={{ background: `${color}10`, border: `1px solid ${color}33`, color }}
                >
                  Backfill
                </button>
              )}
              {disconnectUrl && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (confirm(`Disconnect ${name}?`)) callJson(disconnectUrl, "POST", "Disconnected");
                  }}
                  className="rounded-[10px] px-2.5 py-1.5 text-[11px] text-white/40 hover:text-white/70"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  ✕
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {flash && (
        <div
          className="text-[11px] font-mono"
          style={{ color: flash.startsWith("✗") ? "#ff6b6b" : color }}
        >
          {flash}
        </div>
      )}
    </div>
  );
}
