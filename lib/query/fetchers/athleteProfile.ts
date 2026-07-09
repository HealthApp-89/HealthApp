// lib/query/fetchers/athleteProfile.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AthleteProfileDocument } from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const COLS =
  "id, user_id, version, status, intake_payload, plan_payload, rendered_md, acknowledged_at, superseded_at, superseded_by, endurance_profile, created_at, updated_at";

// ── Active doc ──────────────────────────────────────────────────────────────

const activeProfile = createFetcher(
  async (supabase: SupabaseClient, userId: string): Promise<AthleteProfileDocument | null> => {
    const { data, error } = await supabase
      .from("athlete_profile_documents")
      .select(COLS)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    return (data as AthleteProfileDocument | null) ?? null;
  },
);

export const fetchActiveProfileServer = activeProfile.server;
export const fetchActiveProfileBrowser = activeProfile.browser;

// ── History (all non-discarded versions, version desc) ──────────────────────

const profileHistory = createFetcher(
  async (supabase: SupabaseClient, userId: string): Promise<AthleteProfileDocument[]> => {
    const { data, error } = await supabase
      .from("athlete_profile_documents")
      .select(COLS)
      .eq("user_id", userId)
      .neq("status", "discarded")
      .order("version", { ascending: false });
    if (error) throw error;
    return (data ?? []) as AthleteProfileDocument[];
  },
);

export const fetchProfileHistoryServer = profileHistory.server;
export const fetchProfileHistoryBrowser = profileHistory.browser;

// ── Draft ───────────────────────────────────────────────────────────────────

const draftProfile = createFetcher(
  async (supabase: SupabaseClient, userId: string): Promise<AthleteProfileDocument | null> => {
    const { data, error } = await supabase
      .from("athlete_profile_documents")
      .select(COLS)
      .eq("user_id", userId)
      .eq("status", "draft")
      .maybeSingle();
    if (error) throw error;
    return (data as AthleteProfileDocument | null) ?? null;
  },
);

export const fetchDraftProfileServer = draftProfile.server;
export const fetchDraftProfileBrowser = draftProfile.browser;

// ── Single doc by id (used by ViewModal for any version) ────────────────────

const profileById = createFetcher(
  async (supabase: SupabaseClient, userId: string, id: string): Promise<AthleteProfileDocument | null> => {
    const { data, error } = await supabase
      .from("athlete_profile_documents")
      .select(COLS)
      .eq("user_id", userId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as AthleteProfileDocument | null) ?? null;
  },
);

export const fetchProfileByIdServer = profileById.server;
export const fetchProfileByIdBrowser = profileById.browser;
