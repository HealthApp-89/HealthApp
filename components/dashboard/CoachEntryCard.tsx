import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

type CoachEntryCardProps = {
  /** Today's plan headline (e.g. "Lift heavy — squat day, RPE ≤ 8"). */
  headline: string;
  /** Background color of the thumbnail (mode color or accent). */
  thumbnailColor: string;
  /** Glyph rendered in the thumbnail. */
  thumbnailGlyph: string;
  /** Read-time label or context (e.g. "Coach · 2 min read"). */
  meta: string;
};

export function CoachEntryCard({ headline, thumbnailColor, thumbnailGlyph, meta }: CoachEntryCardProps) {
  return (
    <Link href="/coach" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "14px",
              background: `linear-gradient(135deg, ${thumbnailColor} 0%, ${darken(thumbnailColor)} 100%)`,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: "22px",
            }}
          >
            {thumbnailGlyph}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "11px", color: COLOR.textMuted, fontWeight: 600 }}>Today's plan</div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: COLOR.textStrong,
                marginTop: "2px",
                lineHeight: 1.3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {headline}
            </div>
            <div style={{ fontSize: "11px", color: COLOR.textFaint, marginTop: "4px" }}>{meta}</div>
          </div>
          <span style={{ color: COLOR.textFaint, fontSize: "20px" }}>›</span>
        </div>
      </Card>
    </Link>
  );
}

/** Crude darken — drops each channel by 30. Sufficient for a 2-stop gradient. */
function darken(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = (h: string) => Math.max(0, parseInt(h, 16) - 30).toString(16).padStart(2, "0");
  return `#${c(m[1])}${c(m[2])}${c(m[3])}`;
}
