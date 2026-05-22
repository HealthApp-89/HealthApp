import { COLOR } from "@/lib/ui/theme";
import type { WorkoutDebriefPayload } from "@/lib/data/types";
import { fmtNum } from "@/lib/ui/score";

function statusBadge(status: WorkoutDebriefPayload["volume"][number]["status"]) {
  const map = {
    below_mev: { label: "Below MEV", color: COLOR.textMuted },
    in_mav: { label: "In MAV", color: COLOR.success },
    approaching_mrv: { label: "Approaching MRV", color: COLOR.warning },
    over_mrv: { label: "Over MRV", color: COLOR.danger },
  } as const;
  return map[status];
}

function liftTag(tag: WorkoutDebriefPayload["lifts"][number]["tag"]) {
  if (tag === "PR") return { label: "PR", color: COLOR.success };
  if (tag === "stall") return { label: "Stall", color: COLOR.warning };
  if (tag === "regression") return { label: "Regression", color: COLOR.danger };
  return null;
}

export function SessionDebriefView({ payload }: { payload: WorkoutDebriefPayload }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "16px 16px 80px" }}>
      <header>
        <div style={{ fontSize: 10, color: COLOR.textMuted, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {payload.date} · Session debrief
        </div>
        <h1 style={{ margin: "2px 0 0 0", fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {payload.session_type}
        </h1>
        {payload.block.week_num != null && payload.block.total_weeks != null && (
          <div style={{ fontSize: 12, color: COLOR.textMuted, marginTop: 4 }}>
            Mesocycle week {payload.block.week_num} of {payload.block.total_weeks}
            {payload.block.phase && ` · ${payload.block.phase}`}
            {payload.block.rir_target != null && ` · RIR ${payload.block.rir_target}`}
          </div>
        )}
      </header>

      {/* Per-lift table */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Lifts</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {payload.lifts.map((lift) => {
            const tag = liftTag(lift.tag);
            return (
              <div
                key={lift.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 4,
                  padding: "8px 10px",
                  background: COLOR.surface,
                  borderRadius: 10,
                  border: `1px solid ${COLOR.divider}`,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>{lift.name}</div>
                {tag && (
                  <div style={{ fontSize: 11, fontWeight: 700, color: tag.color }}>{tag.label}</div>
                )}
                <div style={{ fontSize: 12, color: COLOR.textMuted, gridColumn: "1 / -1" }}>
                  Today: {lift.top_set_today.kg != null ? `${fmtNum(lift.top_set_today.kg)}kg` : "—"}
                  {lift.top_set_today.reps != null && ` × ${lift.top_set_today.reps}`}
                  {lift.top_set_today.e1rm != null && ` (e1RM ${fmtNum(lift.top_set_today.e1rm)}kg)`}
                  {lift.top_set_last.date && (
                    <>
                      {" · Last ("}
                      {lift.top_set_last.date}
                      {"): "}
                      {lift.top_set_last.kg != null ? `${fmtNum(lift.top_set_last.kg)}kg` : "—"}
                      {lift.top_set_last.e1rm != null && ` (e1RM ${fmtNum(lift.top_set_last.e1rm)}kg)`}
                    </>
                  )}
                  {lift.delta_e1rm != null && (
                    <>
                      {" · Δe1RM "}
                      <span style={{ color: lift.delta_e1rm >= 0 ? COLOR.success : COLOR.danger }}>
                        {lift.delta_e1rm >= 0 ? "+" : ""}
                        {fmtNum(lift.delta_e1rm)}kg
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Volume vs landmarks */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Volume vs MEV / MAV / MRV</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {payload.volume.map((v) => {
            const badge = statusBadge(v.status);
            const pct = Math.min(100, (v.sets_this_week / v.band.mrv) * 100);
            return (
              <div
                key={v.muscle}
                style={{
                  padding: "8px 10px",
                  background: COLOR.surface,
                  borderRadius: 10,
                  border: `1px solid ${COLOR.divider}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: COLOR.textStrong }}>{v.muscle}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: badge.color }}>{badge.label}</span>
                </div>
                <div style={{ fontSize: 11, color: COLOR.textMuted, marginTop: 2 }}>
                  {fmtNum(v.sets_this_week)} sets this week (today {fmtNum(v.sets_today)}) · band MEV {v.band.mev} · MAV {v.band.mav_low}–{v.band.mav_high} · MRV {v.band.mrv}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    height: 4,
                    background: COLOR.divider,
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div style={{ width: `${pct}%`, height: "100%", background: badge.color }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Autoregulation */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Autoregulation</h2>
        <p style={{ fontSize: 13, color: COLOR.textStrong, lineHeight: 1.5, margin: 0 }}>
          {payload.autoregulation.interpretation}
        </p>
      </section>

      {/* Narrative */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Coach Carter</h2>
        <div
          style={{ fontSize: 13, lineHeight: 1.55, color: COLOR.textStrong, whiteSpace: "pre-wrap" }}
          dangerouslySetInnerHTML={{ __html: simpleMarkdown(payload.narrative_md) }}
        />
      </section>

      {/* Prescription */}
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>Prescription for next session</h2>
        {payload.prescription.weight_changes.length === 0 && payload.prescription.notes.length === 0 && (
          <p style={{ fontSize: 13, color: COLOR.textMuted }}>No changes — repeat the session as written.</p>
        )}
        {payload.prescription.weight_changes.length > 0 && (
          <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, color: COLOR.textStrong, lineHeight: 1.5 }}>
            {payload.prescription.weight_changes.map((w) => (
              <li key={w.exercise}>
                <strong>{w.exercise}</strong> → {fmtNum(w.new_kg)}kg — {w.rationale}
              </li>
            ))}
          </ul>
        )}
        {payload.prescription.notes.length > 0 && (
          <ul style={{ paddingLeft: 18, margin: "6px 0 0 0", fontSize: 13, color: COLOR.textMuted, lineHeight: 1.5 }}>
            {payload.prescription.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function simpleMarkdown(md: string): string {
  // Tiny renderer: paragraphs + bold/italic only. No links, no headings.
  const escaped = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const withBold = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return withItalic
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin: 0 0 8px 0">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}
