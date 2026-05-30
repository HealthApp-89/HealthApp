"use client";
import { useState } from "react";
import Link from "next/link";
import { CoachCard } from "@/components/coach/CoachCard";
import { SpeakerChip } from "@/components/chat/SpeakerChip";
import { COLOR, RADIUS } from "@/lib/ui/theme";
import type { ProactiveNudgeCard as ProactiveNudgeCardUI } from "@/lib/data/types";

/** Card rendered for chat_messages with kind='proactive_nudge'. Visual
 *  lineage mirrors WeeklyReviewCard.tsx — same CoachCard chrome, same Link
 *  CTA pattern, warn-toned accent bar.
 *
 *  Save-recipe variant (Nora suggestion engine §9): ui.payload.kind === 'save_recipe'
 *  renders an inline name input + Save/Dismiss CTAs instead of the deep-link
 *  CTA. Saves POST /api/coach/save-recipe-from-nudge; Dismiss POSTs
 *  /api/chat/nudge-dismiss. Both endpoints are wired in Task 17. */
const SEVERITY_TO_TONE: Record<string, "default" | "alert" | "ok" | "accent"> = {
  warn:  "alert",
  alert: "alert",
  ok:    "ok",
  info:  "accent",
};

export function ProactiveNudgeCard({ ui }: { ui: ProactiveNudgeCardUI }) {
  const tone = SEVERITY_TO_TONE[ui.severity] ?? "default";
  const accent = "#d97706"; // warn-amber, matches lib/coach/trends/ TrendsHeader

  const isSaveRecipe = ui.payload?.kind === "save_recipe";

  return (
    <div style={{ padding: "6px 12px" }}>
      <CoachCard tone={tone}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <CoachCard.Eyebrow>
            <span style={{ color: accent }}>{ui.severity.toUpperCase()}</span> · COACH
          </CoachCard.Eyebrow>
          {ui.speaker && <SpeakerChip speaker={ui.speaker} size="sm" />}
        </div>
        <CoachCard.Title>{ui.headline}</CoachCard.Title>
        <CoachCard.Body>
          <p
            style={{
              fontSize: 12,
              color: COLOR.textMuted,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {ui.body_md}
          </p>
          {isSaveRecipe && ui.payload?.kind === "save_recipe" && (
            <SaveRecipeBody payload={ui.payload} triggerKey={ui.trigger_key} />
          )}
        </CoachCard.Body>
        {!isSaveRecipe && (
          <CoachCard.Actions>
            <Link
              href={ui.deep_link.href}
              style={{
                display: "inline-block",
                padding: "8px 12px",
                background: COLOR.accent,
                color: "#fff",
                borderRadius: 9999,
                fontWeight: 700,
                fontSize: 12,
                textDecoration: "none",
              }}
            >
              {ui.deep_link.label}
            </Link>
          </CoachCard.Actions>
        )}
      </CoachCard>
    </div>
  );
}

type SaveRecipePayload = Extract<
  NonNullable<ProactiveNudgeCardUI["payload"]>,
  { kind: "save_recipe" }
>;

function SaveRecipeBody({
  payload,
  triggerKey,
}: {
  payload: SaveRecipePayload;
  triggerKey: string;
}) {
  const [name, setName] = useState<string>(payload.suggested_name);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<"saved" | "dismissed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done === "saved") {
    return (
      <p style={{ marginTop: 12, fontSize: 12, color: COLOR.success }}>
        Saved to your library.
      </p>
    );
  }
  if (done === "dismissed") {
    return (
      <p style={{ marginTop: 12, fontSize: 12, color: COLOR.textMuted }}>Dismissed.</p>
    );
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/coach/save-recipe-from-nudge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          composite_of: payload.items.map((i) => ({
            name: i.name,
            qty_g: i.qty_g,
            per_100g: i.per_100g,
          })),
          per_100g: payload.per_100g,
          combo_signature: payload.combo_signature,
        }),
      });
      if (res.ok) {
        setDone("saved");
      } else {
        const detail = await res.text().catch(() => "");
        console.error("[ProactiveNudgeCard] save failed", res.status, detail);
        setError(`Couldn't save — ${res.status === 401 ? "please sign in again" : "try again"}`);
      }
    } catch (err) {
      console.error("[ProactiveNudgeCard] save threw", err);
      setError("Couldn't save — network error");
    } finally {
      setSaving(false);
    }
  };

  const dismiss = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/chat/nudge-dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger_key: triggerKey }),
      });
      if (res.ok) setDone("dismissed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 12, color: COLOR.textMid }}>
        You&apos;ve logged {payload.items.map((i) => i.name).join(" + ")} together{" "}
        {payload.co_occurrence_count}× in the last 30 days. Save as a recipe? One tap to log next time.
      </p>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: COLOR.textMuted }}>Name</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          style={{
            padding: "6px 10px",
            fontSize: 13,
            color: COLOR.textStrong,
            background: COLOR.surfaceAlt,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: RADIUS.input,
            outline: "none",
          }}
        />
      </label>

      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
        {payload.items.map((i) => (
          <li key={i.name} style={{ fontSize: 11, color: COLOR.textMid }}>
            · {i.name} — {Math.round(i.qty_g)}g (median)
          </li>
        ))}
      </ul>
      <p style={{ margin: 0, fontSize: 11, color: COLOR.textFaint }}>
        Per 100g: {Math.round(payload.per_100g.kcal)} kcal ·{" "}
        {Math.round(payload.per_100g.protein_g)}P {Math.round(payload.per_100g.carbs_g)}C{" "}
        {Math.round(payload.per_100g.fat_g)}F
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          type="button"
          disabled={saving || name.trim().length === 0}
          onClick={save}
          style={{
            padding: "8px 12px",
            background: COLOR.accent,
            color: "#fff",
            borderRadius: 9999,
            border: "none",
            fontWeight: 700,
            fontSize: 12,
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving || name.trim().length === 0 ? 0.5 : 1,
          }}
        >
          Save to library
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={dismiss}
          style={{
            padding: "8px 12px",
            background: "transparent",
            color: COLOR.textMid,
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 9999,
            fontWeight: 600,
            fontSize: 12,
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.5 : 1,
          }}
        >
          Not this one
        </button>
      </div>
      {error && (
        <p style={{ margin: 0, fontSize: 11, color: COLOR.danger }}>
          {error}
        </p>
      )}
    </div>
  );
}
