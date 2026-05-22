import { openDB, type IDBPDatabase } from "idb";
import type { LoggerDraft } from "@/lib/logger/types";

const DB_NAME = "apex-logger";
const DB_VERSION = 1;
const STORE = "drafts";
const MAX_AGE_HOURS = 12;

interface Schema {
  drafts: { key: string; value: LoggerDraft };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

function key(userId: string, sessionType: string) {
  return `${userId}:${sessionType}`;
}

export async function saveDraft(draft: LoggerDraft): Promise<void> {
  const db = await getDB();
  await db.put(STORE, draft, key(draft.user_id, draft.session_type));
}

/**
 * Note on the draft's `date` field across midnight: if a user starts a session
 * on Monday at 11pm, abandons mid-session, and resumes Tuesday morning before
 * the 12h TTL expires, the commit will write `workouts.date = Monday` (the
 * draft's stored date wins over the caller's "today"). This is the intended
 * behavior — they're finishing Monday's session. To start a fresh Tuesday
 * session, the user discards via the resume prompt.
 */
export async function loadDraft(
  userId: string,
  sessionType: string,
): Promise<LoggerDraft | null> {
  const db = await getDB();
  const raw = (await db.get(STORE, key(userId, sessionType))) as LoggerDraft | undefined;
  if (!raw) return null;

  // Discard if older than MAX_AGE_HOURS.
  const ageMs = Date.now() - new Date(raw.updated_at).getTime();
  if (ageMs > MAX_AGE_HOURS * 3600 * 1000) {
    await db.delete(STORE, key(userId, sessionType));
    return null;
  }

  // Backfill pause fields for drafts written before the pause/resume feature.
  const draft: LoggerDraft = {
    ...raw,
    paused_at: raw.paused_at ?? null,
    paused_ms_total: raw.paused_ms_total ?? 0,
  };
  return draft;
}

export async function hasExistingDraft(
  userId: string,
  sessionType: string,
): Promise<boolean> {
  const draft = await loadDraft(userId, sessionType);
  return !!draft;
}

export async function clearDraft(userId: string, sessionType: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, key(userId, sessionType));
}

export async function listDrafts(userId: string): Promise<LoggerDraft[]> {
  const db = await getDB();
  const all = (await db.getAll(STORE)) as LoggerDraft[];
  return all.filter((d) => d.user_id === userId);
}
