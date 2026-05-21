// Quick audit: inspect today's chat_messages on the nora thread to see
// what speaker/kind/mode is actually stamped. Diagnoses "Peter is replying
// in the Diet tab" bug.
//
// Usage: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --env-file=.env.local scripts/audit-nora-chat.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.AUDIT_USER_ID;
if (!url || !key) throw new Error("Missing Supabase env vars");
if (!userId) throw new Error("Missing AUDIT_USER_ID");

const sb = createClient(url, key, { auth: { persistSession: false } });

const since = new Date();
since.setUTCHours(0, 0, 0, 0);
since.setUTCDate(since.getUTCDate() - 2); // last 48h

const { data: rows, error } = await sb
  .from("chat_messages")
  .select("id, role, speaker, thread, kind, mode, status, created_at, content")
  .eq("user_id", userId)
  .gte("created_at", since.toISOString())
  .order("created_at", { ascending: true });

if (error) throw error;

console.log(`\nLast 48h: ${rows.length} chat_messages rows\n`);
for (const r of rows) {
  const snip = (r.content ?? "").slice(0, 80).replace(/\n/g, " ");
  console.log(
    `${r.created_at.slice(11, 19)} ${r.role.padEnd(10)} speaker=${(r.speaker ?? "null").padEnd(7)} thread=${(r.thread ?? "null").padEnd(7)} kind=${(r.kind ?? "null").padEnd(15)} mode=${(r.mode ?? "null").padEnd(10)} | ${snip}`,
  );
}

// Group by (kind, thread, speaker) to spot patterns
const groups = {};
for (const r of rows) {
  const k = `${r.kind}|${r.thread}|${r.speaker}`;
  groups[k] = (groups[k] ?? 0) + 1;
}
console.log("\nGroupings (kind|thread|speaker → count):");
for (const [k, n] of Object.entries(groups).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(40)} ${n}`);
}
