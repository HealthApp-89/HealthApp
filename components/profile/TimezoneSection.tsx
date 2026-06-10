// components/profile/TimezoneSection.tsx
"use client";
import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { queryKeys } from "@/lib/query/keys";

function listSupportedZones(): string[] {
  try {
    const xs = Intl.supportedValuesOf("timeZone") as string[];
    return xs;
  } catch {
    return ["UTC", "Asia/Dubai", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles"];
  }
}

export function TimezoneSection({ userId }: { userId: string }) {
  const { data: profile } = useProfile(userId);
  const qc = useQueryClient();
  const stored = profile?.timezone ?? "Asia/Dubai";
  const detected = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const zones = useMemo(listSupportedZones, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones.slice(0, 12);
    return zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 30);
  }, [query, zones]);

  async function save(next: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/profile/timezone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timezone: next }),
      });
      if (res.ok) {
        await qc.invalidateQueries({ queryKey: queryKeys.profile.one(userId) });
      }
    } finally {
      setSaving(false);
      setOpen(false);
      setQuery("");
    }
  }

  const mismatch = stored !== detected;

  return (
    <section id="timezone" style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Timezone</h3>
      <div style={{ fontSize: 12, color: "rgb(136 136 136)", marginBottom: 12 }}>
        Authoritative for daily plans, brief, food log, week boundaries, and cron sync.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: "rgb(170 170 170)" }}>Current</span>
          <span style={{ color: "white" }}>{stored}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: "rgb(170 170 170)" }}>Device reports</span>
          <span style={{ color: mismatch ? "rgb(251 146 60)" : "rgb(170 170 170)" }}>
            {detected}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button
          onClick={() => save(detected)}
          disabled={saving || !mismatch}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid rgb(51 51 51)",
            background: mismatch ? "rgb(59 130 246)" : "rgb(34 34 34)",
            color: mismatch ? "white" : "rgb(136 136 136)",
            fontSize: 12,
            cursor: mismatch && !saving ? "pointer" : "default",
          }}
        >
          Use device timezone
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid rgb(51 51 51)",
            background: "transparent",
            color: "white",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Pick another
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a city or zone…"
            autoFocus
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid rgb(51 51 51)",
              background: "rgb(20 20 20)",
              color: "white",
              fontSize: 13,
              marginBottom: 6,
            }}
          />
          <div
            style={{
              maxHeight: 240,
              overflowY: "auto",
              border: "1px solid rgb(34 34 34)",
              borderRadius: 6,
              background: "rgb(15 15 15)",
            }}
          >
            {filtered.map((z) => (
              <button
                key={z}
                onClick={() => save(z)}
                disabled={saving}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  background: z === stored ? "rgb(30 30 30)" : "transparent",
                  border: 0,
                  color: "white",
                  fontSize: 12,
                  fontFamily: "var(--font-dm-mono)",
                  cursor: "pointer",
                }}
              >
                {z}
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: 10, fontSize: 12, color: "rgb(136 136 136)" }}>
                No matches
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
