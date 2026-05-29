// scripts/migrate-exclusions.mjs
//
// One-shot: parse athlete_profile_documents intake.nutrition.restrictions +
// intake.health.allergies free-text into structured exclusion tags. Reports
// per-user diff. Idempotent — skips profiles whose tags array is non-empty.

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const TAG_PATTERNS = [
  { tag: "pork", re: /\b(no |avoid |without )?(pork|bacon|ham|prosciutto|chorizo|halal|muslim)\b/i },
  { tag: "shellfish", re: /\b(no |avoid )?(shellfish|shrimp|prawn|lobster|crab)\b/i },
  { tag: "alcohol", re: /\b(no |without )?(alcohol|wine|beer|spirits?)\b/i },
  { tag: "gluten", re: /\b(gluten[- ]?free|celiac|coeliac|no gluten|no wheat)\b/i },
  { tag: "dairy", re: /\b(lactose intolerant|dairy[- ]?free|no dairy|no milk)\b/i },
  { tag: "eggs", re: /\b(no eggs?|egg allerg|egg-free)\b/i },
  { tag: "peanuts", re: /\b(peanut allerg|no peanuts?)\b/i },
  { tag: "tree_nuts", re: /\b(tree nut allerg|nut allerg|no nuts?)\b/i },
  { tag: "soy", re: /\b(soy allerg|no soy)\b/i },
  { tag: "red_meat", re: /\b(no red meat)\b/i },
  { tag: "all_meat", re: /\b(vegetarian|vegan|no meat)\b/i },
  { tag: "fish", re: /\b(no fish|pescetarian (no )?fish)\b/i },
];

function parse(text) {
  if (!text) return [];
  const hits = new Set();
  for (const { tag, re } of TAG_PATTERNS) {
    if (re.test(text)) hits.add(tag);
  }
  return [...hits];
}

const { data: profiles, error } = await supabase
  .from("profiles")
  .select("user_id, dietary_exclusions");
if (error) { console.error(error); process.exit(1); }

let touched = 0, skipped = 0;
for (const p of profiles ?? []) {
  const existing = p.dietary_exclusions ?? { tags: [], free_text: null, version: 1 };
  if ((existing.tags ?? []).length > 0) { skipped++; continue; }

  // Pull latest acknowledged athlete profile doc.
  const { data: doc } = await supabase
    .from("athlete_profile_documents")
    .select("intake_payload")
    .eq("user_id", p.user_id)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nutritionRestrictions = doc?.intake_payload?.nutrition?.restrictions ?? "";
  const allergies = doc?.intake_payload?.health?.allergies ?? "";
  const tags = parse(`${nutritionRestrictions}\n${allergies}`);
  if (tags.length === 0) { skipped++; continue; }

  const next = { tags, free_text: existing.free_text, version: 1 };
  const { error: upErr } = await supabase
    .from("profiles")
    .update({ dietary_exclusions: next })
    .eq("user_id", p.user_id);
  if (upErr) { console.error(p.user_id, upErr); continue; }

  console.log(`user=${p.user_id} parsed tags:`, tags);
  touched++;
}

console.log(`\n${touched} updated, ${skipped} skipped`);
