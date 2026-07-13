// scripts/backfill-block-narratives.mjs
// One-shot: writes narrative_md for existing block_outcomes rows where NULL.
// Run: node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/backfill-block-narratives.mjs
//
// generateOutcomeNarrative transitively imports lib/supabase/server.ts which
// top-level-imports `next/headers` (ESM hoists imports; Outside the Next bundler
// this explodes). Register a tiny loader hook that maps `next/headers` to an
// empty stub — same pattern as scripts/smoke-food-lookup.mjs.
import { register } from "node:module";

const stubLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/headers") {
    return {
      url: "data:text/javascript,export%20const%20cookies%20%3D%20()%20%3D%3E%20(%7B%20getAll%3A%20()%20%3D%3E%20%5B%5D%2C%20set%3A%20()%20%3D%3E%20%7B%7D%20%7D)%3Bexport%20const%20headers%20%3D%20()%20%3D%3E%20new%20Headers()%3Bexport%20const%20draftMode%20%3D%20()%20%3D%3E%20(%7B%20isEnabled%3A%20false%2C%20enable%3A%20()%20%3D%3E%20%7B%7D%2C%20disable%3A%20()%20%3D%3E%20%7B%7D%20%7D)%3B",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(stubLoader), import.meta.url);

import { createClient } from "@supabase/supabase-js";
const { generateOutcomeNarrative } = await import("@/lib/coach/block-outcomes/narrative");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: rows, error } = await sb
  .from("block_outcomes")
  .select("*, training_blocks!inner(start_date, end_date)")
  .is("narrative_md", null);
if (error) { console.error(error); process.exit(1); }
for (const row of rows ?? []) {
  const { training_blocks: tb, ...payload } = row;
  const { narrative, source } = await generateOutcomeNarrative({
    payload,
    blockWindow: { start_date: tb.start_date, end_date: tb.end_date },
  });
  const { error: upErr } = await sb.from("block_outcomes")
    .update({ narrative_md: narrative }).eq("id", row.id);
  console.log(`${row.primary_lift} (${tb.end_date}): ${source}${upErr ? " WRITE FAILED " + upErr.message : ""}`);
}
console.log(`done — ${rows?.length ?? 0} rows`);
