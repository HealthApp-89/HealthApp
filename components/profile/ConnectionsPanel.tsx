"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel } from "@/components/ui/Card";
import { IntegrationRow } from "./IntegrationRow";
import { COLOR } from "@/lib/ui/theme";

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
  function syncedText(updatedAt: string | null): string {
    if (!updatedAt) return "Not synced yet";
    const diff = Date.now() - new Date(updatedAt).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "Synced just now";
    if (mins < 60) return `Synced ${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Synced ${hrs} hr ago`;
    return `Synced ${new Date(updatedAt).toLocaleDateString()}`;
  }

  const whoopStatus = whoopConnected
    ? `Connected · ${syncedText(whoopUpdatedAt)}`
    : "Not connected";

  const withingsStatus = withingsConnected
    ? `Connected · ${syncedText(withingsUpdatedAt)}`
    : "Not connected";

  return (
    <Card>
      <SectionLabel>CONNECTIONS</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <IntegrationRow
          brandColor="#1a1a1a"
          brandFg="#16ff7a"
          chip="W"
          name="WHOOP"
          status={whoopStatus}
          statusTone={whoopConnected ? "success" : "muted"}
          ctaLabel={whoopConnected ? "Manage" : "Connect"}
          ctaHref="/api/whoop/auth"
        />
        {whoopConnected && (
          <ProviderActions
            syncUrl="/api/whoop/sync"
            backfillUrl="/api/whoop/backfill"
            color={COLOR.accent}
          />
        )}

        <IntegrationRow
          brandColor="#00aef0"
          brandFg="#fff"
          chip="W"
          name="Withings"
          status={withingsStatus}
          statusTone={withingsConnected ? "success" : "muted"}
          ctaLabel={withingsConnected ? "Manage" : "Connect"}
          ctaHref="/api/withings/auth"
        />
        {withingsConnected && (
          <ProviderActions
            syncUrl="/api/withings/sync"
            backfillUrl="/api/withings/backfill"
            disconnectUrl="/api/withings/disconnect"
            disconnectName="Withings"
            color={COLOR.accent}
          />
        )}
      </div>
    </Card>
  );
}

function ProviderActions({
  syncUrl,
  backfillUrl,
  disconnectUrl,
  disconnectName,
  color,
}: {
  syncUrl: string;
  backfillUrl?: string;
  disconnectUrl?: string;
  disconnectName?: string;
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
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        paddingLeft: "4px",
      }}
    >
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={pending}
          onClick={() => callJson(syncUrl, "GET", "Sync")}
          style={{
            background: COLOR.accentSoft,
            border: "none",
            borderRadius: "8px",
            padding: "6px 12px",
            fontSize: "11px",
            fontWeight: 700,
            color: COLOR.accent,
            cursor: "pointer",
            opacity: pending ? 0.5 : 1,
          }}
        >
          {pending ? "…" : "Sync"}
        </button>
        {backfillUrl && (
          <button
            type="button"
            disabled={pending}
            onClick={() => callJson(backfillUrl, "POST", "Backfill")}
            style={{
              background: COLOR.surfaceAlt,
              border: `1px solid ${COLOR.divider}`,
              borderRadius: "8px",
              padding: "6px 12px",
              fontSize: "11px",
              fontWeight: 700,
              color: COLOR.textMid,
              cursor: "pointer",
              opacity: pending ? 0.5 : 1,
            }}
          >
            Backfill
          </button>
        )}
        {disconnectUrl && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (confirm(`Disconnect ${disconnectName ?? ""}?`))
                callJson(disconnectUrl, "POST", "Disconnected");
            }}
            style={{
              background: COLOR.dangerSoft,
              border: "none",
              borderRadius: "8px",
              padding: "6px 12px",
              fontSize: "11px",
              fontWeight: 700,
              color: COLOR.danger,
              cursor: "pointer",
              opacity: pending ? 0.5 : 1,
            }}
          >
            Disconnect
          </button>
        )}
      </div>
      {flash && (
        <div
          style={{
            fontSize: "11px",
            fontFamily: "monospace",
            color: flash.startsWith("✗") ? COLOR.danger : color,
          }}
        >
          {flash}
        </div>
      )}
    </div>
  );
}
