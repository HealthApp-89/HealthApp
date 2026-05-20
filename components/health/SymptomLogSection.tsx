"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSymptomLog } from "@/lib/query/hooks/useSymptomLog";
import { queryKeys } from "@/lib/query/keys";
import type { SymptomKind } from "@/lib/query/fetchers/symptomLog";
import { COLOR } from "@/lib/ui/theme";

const KINDS: { key: SymptomKind; label: string }[] = [
  { key: "sickness", label: "Sickness" },
  { key: "injury", label: "Injury" },
  { key: "soreness", label: "Soreness" },
  { key: "other", label: "Other" },
];

type Props = { userId: string };

/** Manual symptom journal on /health?tab=log. Free-text notes + a kind
 *  tag (sickness | injury | soreness | other). Distinct from the
 *  structured morning intake — entries are timestamp-granular and can
 *  be added any time the user notices something off. */
export function SymptomLogSection({ userId }: Props) {
  const queryClient = useQueryClient();
  const { data: entries, isLoading } = useSymptomLog(userId);
  const [kind, setKind] = useState<SymptomKind>("soreness");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (notes.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/symptom-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, notes: notes.trim() }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "save failed");
        return;
      }
      setNotes("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.symptomLog.list(userId, 30) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/symptom-log?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.symptomLog.list(userId, 30) });
    }
  }

  return (
    <section style={{ padding: "12px 16px" }}>
      <h2
        style={{
          fontSize: 13,
          color: COLOR.textMid,
          margin: "12px 0 8px 0",
          fontWeight: 600,
        }}
      >
        Symptom journal
      </h2>

      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKind(k.key)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: `1px solid ${k.key === kind ? COLOR.accent : COLOR.divider}`,
                background: k.key === kind ? COLOR.accentSoft : COLOR.surface,
                color: k.key === kind ? COLOR.accentDeep : COLOR.textMid,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={`Note about ${kind}…`}
          rows={2}
          maxLength={2000}
          style={{
            width: "100%",
            padding: "8px 10px",
            border: `1px solid ${COLOR.divider}`,
            borderRadius: 6,
            fontSize: 13,
            color: COLOR.textStrong,
            background: COLOR.surface,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        {error && (
          <div style={{ fontSize: 11, color: COLOR.danger }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={submitting || notes.trim().length === 0}
          style={{
            alignSelf: "flex-start",
            padding: "8px 14px",
            border: "none",
            borderRadius: 6,
            background:
              submitting || notes.trim().length === 0
                ? COLOR.surfaceAlt
                : COLOR.accent,
            color:
              submitting || notes.trim().length === 0
                ? COLOR.textMuted
                : "white",
            fontSize: 13,
            fontWeight: 600,
            cursor:
              submitting || notes.trim().length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Saving…" : "Save entry"}
        </button>
      </form>

      <div style={{ marginTop: 16 }}>
        {isLoading ? (
          <div style={{ fontSize: 12, color: COLOR.textMuted }}>Loading…</div>
        ) : !entries || entries.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: COLOR.textMuted,
              fontStyle: "italic",
            }}
          >
            No symptom entries yet. Add one above when you notice something.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {entries.map((e) => (
              <li
                key={e.id}
                style={{
                  background: COLOR.surfaceAlt,
                  padding: "8px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  color: COLOR.textMid,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      color: COLOR.textStrong,
                      textTransform: "capitalize",
                    }}
                  >
                    {e.kind}
                  </span>
                  <span style={{ fontSize: 10, color: COLOR.textMuted }}>
                    {formatTimestamp(e.created_at)}
                    <button
                      type="button"
                      onClick={() => handleDelete(e.id)}
                      aria-label="Delete entry"
                      style={{
                        marginLeft: 10,
                        background: "transparent",
                        border: "none",
                        color: COLOR.danger,
                        fontSize: 11,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
                  {e.notes}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function formatTimestamp(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
