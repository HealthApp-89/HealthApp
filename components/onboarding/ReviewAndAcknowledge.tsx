"use client";

import { useEffect, useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { COLOR } from "@/lib/ui/theme";
import type { IntakePayload } from "@/lib/data/types";
import { renderProfileMarkdown } from "@/lib/coach/profile-renderer";
import { acknowledgeDraft, discardDraft } from "@/app/onboarding/actions";

export function ReviewAndAcknowledge({
  intake,
  draftId,
  version,
  supersedesVersion,
  onBack,
  onAcknowledged,
}: {
  intake: IntakePayload;
  draftId: string;
  version: number;
  supersedesVersion: number | null;
  onBack: () => void;
  onAcknowledged: () => void;
}) {
  const queryClient = useQueryClient();
  const [editMode, setEditMode] = useState(false);
  const [autoMd, setAutoMd] = useState("");
  const [editedMd, setEditedMd] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Auto-render whenever the intake changes (deterministic, runs in browser).
  useEffect(() => {
    const md = renderProfileMarkdown(intake, version, null, supersedesVersion);
    setAutoMd(md);
    if (!editMode) setEditedMd(md); // keep edited in sync until user enters edit mode
  }, [intake, version, supersedesVersion, editMode]);

  function resetToAuto() {
    setEditedMd(autoMd);
  }

  function handleAcknowledge() {
    setError(null);
    const finalMd = editMode ? editedMd : autoMd;
    startTransition(async () => {
      const r = await acknowledgeDraft(draftId, finalMd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Invalidate all athleteProfile cache for this user-scope.
      queryClient.invalidateQueries({ queryKey: ["athlete-profile"] });
      onAcknowledged();
    });
  }

  function handleDiscard() {
    if (!confirm("Discard this draft? You can start over from /profile.")) return;
    startTransition(async () => {
      const r = await discardDraft(draftId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["athlete-profile"] });
      onAcknowledged();
    });
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "16px 0 4px" }}>Review & acknowledge</h2>
      <p style={{ fontSize: 12, color: COLOR.textMuted, marginBottom: 12 }}>
        This is what your athlete profile v{version} will look like. The text below is what gets frozen
        — once you acknowledge, this version is byte-stable forever and visible in /profile. You can
        edit the markdown directly if anything reads off.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          style={toggleBtnStyle(editMode)}
        >
          {editMode ? "Hide editor" : "Edit draft"}
        </button>
        {editMode && (
          <button type="button" onClick={resetToAuto} style={toggleBtnStyle(false)}>
            Reset to auto-rendered
          </button>
        )}
      </div>

      {!editMode ? (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "rgba(255, 255, 255, 0.03)",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            padding: 14,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: "DM Mono, ui-monospace, monospace",
            color: COLOR.textStrong,
            maxHeight: 400,
            overflowY: "auto",
          }}
        >{autoMd}</pre>
      ) : (
        <textarea
          value={editedMd}
          onChange={(e) => setEditedMd(e.target.value)}
          rows={20}
          style={{
            width: "100%",
            background: "rgba(255, 255, 255, 0.03)",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 10,
            padding: 14,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: "DM Mono, ui-monospace, monospace",
            color: COLOR.textStrong,
            resize: "vertical",
          }}
        />
      )}

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "rgba(220, 60, 60, 0.1)",
            border: `1px solid ${COLOR.danger}`,
            borderRadius: 8,
            color: COLOR.danger,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 24, flexWrap: "wrap" }}>
        <button type="button" onClick={onBack} disabled={isPending} style={secondaryBtnStyle()}>
          Back
        </button>
        <button type="button" onClick={handleDiscard} disabled={isPending} style={dangerBtnStyle()}>
          Discard draft
        </button>
        <button
          type="button"
          onClick={handleAcknowledge}
          disabled={isPending}
          style={primaryBtnStyle(isPending)}
        >
          {isPending ? "Acknowledging…" : "Acknowledge profile"}
        </button>
      </div>
    </section>
  );
}

function toggleBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    background: active ? COLOR.accent : "transparent",
    border: `1px solid ${active ? COLOR.accent : COLOR.divider}`,
    borderRadius: 8,
    color: active ? "#fff" : COLOR.textStrong,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function primaryBtnStyle(isPending: boolean): React.CSSProperties {
  return {
    flex: 2,
    minWidth: 200,
    padding: "12px 16px",
    background: isPending ? COLOR.divider : COLOR.accent,
    border: "none",
    borderRadius: 10,
    color: "#fff",
    fontWeight: 700,
    cursor: isPending ? "not-allowed" : "pointer",
  };
}

function secondaryBtnStyle(): React.CSSProperties {
  return {
    padding: "12px 16px",
    background: "transparent",
    border: `1px solid ${COLOR.divider}`,
    borderRadius: 10,
    color: COLOR.textMuted,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function dangerBtnStyle(): React.CSSProperties {
  return {
    padding: "12px 16px",
    background: "transparent",
    border: `1px solid ${COLOR.danger}`,
    borderRadius: 10,
    color: COLOR.danger,
    fontWeight: 600,
    cursor: "pointer",
  };
}
