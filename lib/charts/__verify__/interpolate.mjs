// lib/charts/__verify__/interpolate.mjs
//
// Quick smoke check for interpolateGaps. Run with:
//   node lib/charts/__verify__/interpolate.mjs
//
// Lives in __verify__ so it's clearly a one-off and not picked up by any
// future test runner. Uses runtime-equivalent JS so we can run it without
// a TypeScript build step.

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const parseIso = (iso) => new Date(iso + "T00:00:00Z").getTime();

function interpolateGaps(series, cfg) {
  if (!cfg.enabled || series.length === 0) return series;
  if (series.some((p) => !p.x || !ISO_DATE.test(p.x))) return series;
  const out = series.map((p) => ({ ...p }));
  let i = 0;
  while (i < out.length) {
    if (out[i].y !== null) { i++; continue; }
    let left = i - 1;
    while (left >= 0 && out[left].y === null) left--;
    let right = i;
    while (right < out.length && out[right].y === null) right++;
    if (left < 0 || right >= out.length) { i = right; continue; }
    const leftDate = parseIso(out[left].x);
    const rightDate = parseIso(out[right].x);
    const gapDays = Math.round((rightDate - leftDate) / DAY_MS);
    if (gapDays > cfg.maxGapDays) { i = right; continue; }
    const leftY = out[left].y;
    const rightY = out[right].y;
    for (let k = left + 1; k < right; k++) {
      const t = (parseIso(out[k].x) - leftDate) / (rightDate - leftDate);
      out[k] = { ...out[k], y: leftY + t * (rightY - leftY), estimated: true };
    }
    i = right;
  }
  return out;
}

// ----- Cases -----
const cases = [
  {
    name: "fills 2-day gap with linear interp",
    input: [
      { x: "2026-04-25", y: 60 },
      { x: "2026-04-26", y: null },
      { x: "2026-04-27", y: null },
      { x: "2026-04-28", y: 66 },
    ],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) =>
      out[1].y === 62 && out[1].estimated === true &&
      out[2].y === 64 && out[2].estimated === true &&
      out[0].estimated === undefined && out[3].estimated === undefined,
  },
  {
    name: "leaves >maxGapDays untouched",
    input: [
      { x: "2026-04-25", y: 60 },
      { x: "2026-04-26", y: null },
      { x: "2026-04-27", y: null },
      { x: "2026-04-28", y: null },
      { x: "2026-04-29", y: null },
      { x: "2026-04-30", y: 66 },
    ],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) =>
      out[1].y === null && out[2].y === null && out[3].y === null && out[4].y === null,
  },
  {
    name: "leaves leading/trailing nulls alone",
    input: [
      { x: "2026-04-25", y: null },
      { x: "2026-04-26", y: 60 },
      { x: "2026-04-27", y: 62 },
      { x: "2026-04-28", y: null },
    ],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) => out[0].y === null && out[3].y === null,
  },
  {
    name: "no-op when disabled",
    input: [
      { x: "2026-04-25", y: 60 },
      { x: "2026-04-26", y: null },
      { x: "2026-04-27", y: 66 },
    ],
    cfg: { enabled: false, maxGapDays: 3 },
    expect: (out) => out[1].y === null,
  },
  {
    name: "no-op when x is missing",
    input: [{ y: 60 }, { y: null }, { y: 66 }],
    cfg: { enabled: true, maxGapDays: 3 },
    expect: (out) => out[1].y === null,
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const out = interpolateGaps(c.input, c.cfg);
  const ok = c.expect(out);
  if (ok) {
    console.log(`✓ ${c.name}`);
    passed++;
  } else {
    console.log(`✗ ${c.name}`);
    console.log("  input:  ", JSON.stringify(c.input));
    console.log("  output: ", JSON.stringify(out));
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
