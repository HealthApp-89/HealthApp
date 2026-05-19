// lib/food/scoring.ts
//
// Token-overlap scoring used to rank USDA / OpenFoodFacts text-search
// candidates against a query. Returns a 0..1 score; callers compare against
// an accept threshold (typically 0.5) to decide whether to use the match
// or fall through to the next source.
//
// Pure functions; no I/O.

const STOPWORDS = new Set(["of", "the", "and", "a", "or", "with", "in"]);

/** Tokenize a name/query: lowercase, split on punctuation/whitespace,
 *  drop empty tokens and stopwords. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,.\-/()]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Score a candidate name against a query.
 *  recall    = |query ∩ candidate| / |query|
 *  precision = |query ∩ candidate| / |candidate|
 *  score     = recall * 0.7 + precision * 0.3
 *
 *  Recall weights higher: if the candidate covers every token in the user's
 *  query, that's a strong signal. Precision is a tiebreaker that penalises
 *  candidates with lots of extra noise (e.g. "Oil, corn, peanut, and olive"
 *  vs. "Oil, olive, salad or cooking" for query "olive oil"). */
export function scoreOverlap(query: string, candidate: string): number {
  const q = new Set(tokenize(query));
  const c = new Set(tokenize(candidate));
  if (q.size === 0 || c.size === 0) return 0;
  let overlap = 0;
  for (const t of q) if (c.has(t)) overlap++;
  const recall = overlap / q.size;
  const precision = overlap / c.size;
  return recall * 0.7 + precision * 0.3;
}

/** Score all candidates and return the best one (above threshold), or null.
 *  Tiebreaker: shorter candidate name by character count wins (proxy for
 *  "more focused match"). */
export function pickBestCandidate<T extends { name: string }>(
  query: string,
  candidates: T[],
  threshold = 0.5,
): { candidate: T; score: number } | null {
  let best: { candidate: T; score: number } | null = null;
  for (const c of candidates) {
    const score = scoreOverlap(query, c.name);
    if (score < threshold) continue;
    if (!best || score > best.score || (score === best.score && c.name.length < best.candidate.name.length)) {
      best = { candidate: c, score };
    }
  }
  return best;
}
