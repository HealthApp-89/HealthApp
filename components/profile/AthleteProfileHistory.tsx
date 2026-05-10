"use client";
import { useState } from "react";
import { COLOR } from "@/lib/ui/theme";
import type { AthleteProfileDocument } from "@/lib/data/types";
import { AthleteProfileViewModal } from "@/components/profile/AthleteProfileViewModal";

export function AthleteProfileHistory({ docs }: { docs: AthleteProfileDocument[] }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<AthleteProfileDocument | null>(null);

  // Show only superseded versions (active is shown in the main panel).
  const superseded = docs.filter((d) => d.status === "superseded");

  if (superseded.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: `1px solid ${COLOR.divider}`,
          borderRadius: 8,
          padding: "8px 12px",
          color: COLOR.textMuted,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
      >
        {open ? "▾" : "▸"} Version history ({superseded.length})
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {superseded.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setViewing(d)}
              style={{
                background: "transparent",
                border: `1px solid ${COLOR.divider}`,
                borderRadius: 8,
                padding: "10px 12px",
                color: COLOR.textStrong,
                fontSize: 13,
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>v{d.version}</span>
              <span style={{ color: COLOR.textMuted, fontSize: 12 }}>
                {d.acknowledged_at?.slice(0, 10) ?? "—"}
              </span>
            </button>
          ))}
        </div>
      )}

      {viewing && viewing.rendered_md && (
        <AthleteProfileViewModal
          rendered_md={viewing.rendered_md}
          title={`Athlete profile v${viewing.version}`}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
