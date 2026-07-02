// app/profile/coach-prompts/page.tsx
//
// Read-only debug view of what each coach receives per turn. Renders the
// shared layers (snapshot prefix shape, per-turn header shape, SCHEMA_EXPLAINER)
// once, then one collapsible card per coach with its identity, voice summary,
// readable daily_logs columns, available tools, and full BASE prompt.
//
// Pure server component — no client interactivity beyond native <details>.

import { redirect } from "next/navigation";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PETER_BASE,
  CARTER_BASE,
  NORA_BASE,
  REMI_BASE,
  SCHEMA_EXPLAINER,
} from "@/lib/coach/system-prompts";
import {
  PETER_TOOLS,
  CARTER_TOOLS,
  NORA_TOOLS,
  REMI_TOOLS,
  PETER_COLS,
  CARTER_COLS,
  NORA_COLS,
  REMI_COLS,
  type ToolSchema,
} from "@/lib/coach/tools";
import { CHAT_MODEL } from "@/lib/anthropic/models";
import type { Speaker } from "@/lib/data/types";

export const dynamic = "force-dynamic";

type CoachSpec = {
  name: string;
  role: string;
  base: string;
  voiceSummary: string;
  tools: readonly ToolSchema[];
  dailyLogsCols: readonly string[];
  modeOverride?: { mode: string; addendum: string; note: string };
};

const COACHES: Record<Speaker, CoachSpec> = {
  peter: {
    name: "Peter",
    role: "Head Coach — cross-domain synthesis & block-level decisions",
    base: PETER_BASE,
    voiceSummary:
      "Concise (2–5 sentences), numbers-first, plan-aware. Bounces specialist-lane questions back to the specialists.",
    tools: PETER_TOOLS,
    dailyLogsCols: PETER_COLS,
  },
  carter: {
    name: "Carter",
    role: "Strength specialist — sessions, exercise selection, autoregulation",
    base: CARTER_BASE,
    voiceSummary:
      "Direct, technical, no fluff. Numbers, not vibes. Carries an explicit swap policy (pain → swap, stall → deload first, equipment → forced swap).",
    tools: CARTER_TOOLS,
    dailyLogsCols: CARTER_COLS,
  },
  nora: {
    name: "Nora",
    role: "Nutrition specialist — meals, macros, GLP-1 phase awareness",
    base: NORA_BASE,
    voiceSummary:
      "Grams, kcal, ratios. Reads the food log liberally to ground advice in actual items rather than guessing.",
    tools: NORA_TOOLS,
    dailyLogsCols: NORA_COLS,
  },
  remi: {
    name: "Remi",
    role: "Recovery & sleep specialist — HRV, sleep architecture, illness, mobility",
    base: REMI_BASE,
    voiceSummary:
      "HRV in ms, recovery %, sleep hours. Frames everything against personal baseline, not absolutes.",
    tools: REMI_TOOLS,
    dailyLogsCols: REMI_COLS,
  },
};

export default async function CoachPromptsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <main className="px-4 py-6 max-w-3xl mx-auto text-zinc-100">
      <div className="mb-6">
        <Link
          href="/profile"
          className="text-xs text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1"
        >
          <span>←</span> Profile
        </Link>
        <h1 className="text-xl font-semibold mt-2">Coach prompts</h1>
        <p className="text-zinc-500 text-sm mt-1">
          What each coach actually sees per turn — the data they read, the
          tools they can call, and the rules they follow. Read-only.
        </p>
      </div>

      <SharedLayersCard />

      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mt-6 mb-2 px-1">
        Coaches
      </div>
      <div className="space-y-3">
        {(["peter", "carter", "nora", "remi"] as Speaker[]).map((s) => (
          <CoachCard key={s} spec={COACHES[s]} />
        ))}
      </div>

      <div className="mt-8 text-xs text-zinc-600 leading-relaxed">
        Model:{" "}
        <code className="text-zinc-400">{CHAT_MODEL}</code>
        {" · "}
        <code className="text-zinc-400">web_search</code> is available to every
        coach in <code className="text-zinc-400">default</code>,{" "}
        <code className="text-zinc-400">plan_week</code>, and{" "}
        <code className="text-zinc-400">setup_block</code> modes (capped at 5
        searches per turn).
      </div>
    </main>
  );
}

function SharedLayersCard() {
  return (
    <details className="rounded-2xl bg-zinc-900 border border-zinc-800">
      <summary className="cursor-pointer list-none p-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-zinc-100">
            Shared layers
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            Every coach receives these — independent of which coach is speaking
          </div>
        </div>
        <span className="text-zinc-500 text-xs">expand</span>
      </summary>
      <div className="px-4 pb-4 border-t border-zinc-800 pt-4 space-y-4">
        <Layer
          n={1}
          title="Snapshot prefix"
          subtitle="Cached, refreshed ~hourly · ~3–5k tokens"
        >
          Your profile + recovery baselines + active training plan + last 14 days
          of daily_logs (HRV, recovery, sleep, strain, steps, weight, macros) +
          5 most recent workout summaries.
        </Layer>
        <Layer
          n={2}
          title="Per-turn header"
          subtitle="Fresh every turn"
        >
          NOW timestamp, TODAY's row (may be partial), YESTERDAY's row, and
          data freshness (when each source last wrote a row, in hours-ago).
        </Layer>
        <Layer
          n={3}
          title="Schema explainer"
          subtitle="Static reference"
        >
          Column definitions, tool documentation, derived-field caveats.
          <details className="mt-2">
            <summary className="cursor-pointer text-amber-400 text-xs">
              view full text
            </summary>
            <pre className="whitespace-pre-wrap text-[11px] text-zinc-400 font-mono leading-relaxed bg-zinc-950 rounded-lg p-3 mt-2 max-h-96 overflow-auto">
              {SCHEMA_EXPLAINER}
            </pre>
          </details>
        </Layer>
      </div>
    </details>
  );
}

function Layer({
  n,
  title,
  subtitle,
  children,
}: {
  n: number;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="text-2xl font-light text-zinc-700 leading-none w-6 shrink-0">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-100">{title}</div>
        <div className="text-xs text-zinc-500 mb-1">{subtitle}</div>
        <div className="text-sm text-zinc-300">{children}</div>
      </div>
    </div>
  );
}

function CoachCard({ spec }: { spec: CoachSpec }) {
  return (
    <details className="rounded-2xl bg-zinc-900 border border-zinc-800">
      <summary className="cursor-pointer list-none p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-zinc-100">
            {spec.name}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">{spec.role}</div>
        </div>
        <span className="text-zinc-500 text-xs shrink-0">expand</span>
      </summary>

      <div className="px-4 pb-4 border-t border-zinc-800 pt-4 space-y-5">
        <Section title="Voice">
          <p className="text-sm text-zinc-300">{spec.voiceSummary}</p>
        </Section>

        <Section title="Data this coach can read">
          <div className="text-xs text-zinc-500 mb-1.5">
            daily_logs columns ({spec.dailyLogsCols.length}):
          </div>
          <div className="flex flex-wrap gap-1">
            {spec.dailyLogsCols.map((c) => (
              <span
                key={c}
                className="text-[11px] font-mono text-zinc-300 bg-zinc-800 rounded px-1.5 py-0.5"
              >
                {c}
              </span>
            ))}
          </div>
        </Section>

        <Section title={`Tools available (${spec.tools.length + 1})`}>
          <ul className="text-sm space-y-1.5">
            {spec.tools.map((t) => (
              <li key={t.name} className="leading-snug">
                <code className="text-amber-300 text-[13px]">{t.name}</code>
                <span className="text-zinc-500"> — {firstSentence(t.description)}</span>
              </li>
            ))}
            <li className="leading-snug">
              <code className="text-amber-300 text-[13px]">web_search</code>
              <span className="text-zinc-500">
                {" "}
                — Anthropic-managed web search; only in default / plan_week /
                setup_block modes, max 5 uses per turn.
              </span>
            </li>
          </ul>
        </Section>

        <Section title="Rules (full BASE prompt)">
          <pre className="whitespace-pre-wrap text-[12px] text-zinc-400 font-mono leading-relaxed bg-zinc-950 rounded-lg p-3 max-h-96 overflow-auto">
            {spec.base}
          </pre>
        </Section>

        {spec.modeOverride && (
          <Section title={`Mode override · ${spec.modeOverride.mode}`}>
            <p className="text-xs text-zinc-500 mb-2">{spec.modeOverride.note}</p>
            <pre className="whitespace-pre-wrap text-[12px] text-zinc-400 font-mono leading-relaxed bg-zinc-950 rounded-lg p-3 max-h-80 overflow-auto">
              {spec.modeOverride.addendum}
            </pre>
          </Section>
        )}
      </div>
    </details>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

function firstSentence(s: string): string {
  const idx = s.indexOf(". ");
  return idx === -1 ? s : s.slice(0, idx + 1);
}
