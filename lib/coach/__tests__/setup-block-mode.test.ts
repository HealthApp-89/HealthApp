// Regression tests for the 2026-07-12 "Setup new block does nothing" bug.
//
// Root cause was twofold:
//   1. runChatStream discarded the route-built system prompt (which carries
//      SETUP_BLOCK_PROMPT + block-outcome context) for non-Peter speakers,
//      and speakerSystemPromptForMode ignored the mode — so Carter ran
//      setup_block turns with his bare base prompt and behaved like plan_week.
//   2. PROPOSE_BLOCK_TOOL / COMMIT_BLOCK_TOOL lived only in PETER_TOOLS, so
//      Carter (the speaker on /strength?tab=coach where the setup_block
//      surfaces live) could not propose a block at all.

import { describe, expect, test } from "vitest";
import { CARTER_TOOLS } from "@/lib/coach/tools";
import { buildModeSections } from "@/lib/coach/planning-prompts";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Chainable supabase stub — every query resolves to empty data. */
function emptySupabaseStub(): SupabaseClient {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ["from", "select", "eq", "is", "in", "gte", "lte", "order", "limit"]) {
    chain[m] = self;
  }
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.single = () => Promise.resolve({ data: null, error: null });
  // Thenable so `await query` (no terminal call) resolves to empty rows.
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return chain as unknown as SupabaseClient;
}

describe("setup_block mode reaches Carter", () => {
  test("CARTER_TOOLS exposes propose_block and commit_block", () => {
    const names = CARTER_TOOLS.map((t) => t.name);
    expect(names).toContain("propose_block");
    expect(names).toContain("commit_block");
  });

  test("buildModeSections returns SETUP_BLOCK_PROMPT for setup_block mode", async () => {
    const sections = await buildModeSections({
      supabase: emptySupabaseStub(),
      userId: "00000000-0000-0000-0000-000000000000",
      mode: "setup_block",
    });
    expect(sections.join("\n")).toContain("You are running a training block setup");
  });

  test("buildModeSections is empty for default mode", async () => {
    const sections = await buildModeSections({
      supabase: emptySupabaseStub(),
      userId: "00000000-0000-0000-0000-000000000000",
      mode: "default",
    });
    expect(sections).toEqual([]);
  });
});
