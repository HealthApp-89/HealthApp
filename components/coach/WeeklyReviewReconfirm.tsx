"use client";
import { Card, SectionLabel } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";
import type {
  WeeklyReviewPayload,
  ReconfirmResponses,
} from "@/lib/data/types";

export function WeeklyReviewReconfirm({
  reviewId: _reviewId,
  reconfirm,
  responses,
}: {
  reviewId: string;
  reconfirm: WeeklyReviewPayload["reconfirm"];
  responses: ReconfirmResponses;
}) {
  if (reconfirm.length === 0) return null;
  return (
    <Card>
      <SectionLabel>RECONFIRM ({reconfirm.length})</SectionLabel>
      <div style={{ opacity: 0.55 }}>
        {reconfirm.map((r) => {
          const selected = responses[r.id]?.chip_value;
          return (
            <div key={r.id} style={{ marginTop: 8, fontSize: 11 }}>
              <div style={{ color: COLOR.textStrong, fontWeight: 600 }}>
                {r.question}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  marginTop: 4,
                  flexWrap: "wrap",
                }}
              >
                {r.chips.map((c) => {
                  const isSelected = selected === c.value;
                  return (
                    <span
                      key={c.value}
                      style={{
                        background: isSelected ? COLOR.accent : COLOR.surfaceAlt,
                        color: isSelected ? "#fff" : COLOR.textStrong,
                        borderRadius: 4,
                        padding: "2px 8px",
                        fontSize: 11,
                        cursor: "default",
                      }}
                    >
                      {c.label}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          fontSize: 10,
          color: COLOR.warning,
          marginTop: 8,
        }}
      >
        (Interactive chips wire up in Slice 5.)
      </div>
    </Card>
  );
}
