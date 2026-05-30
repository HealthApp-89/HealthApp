// lib/query/fetchers/athleteProfile.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AthleteProfileDocument } from "@/lib/data/types";

const COLS =
  "id, user_id, version, status, intake_payload, plan_payload, rendered_md, acknowledged_at, superseded_at, superseded_by, endurance_profile, created_at, updated_at";

// ── Active doc ──────────────────────────────────────────────────────────────

export async function fetchActiveProfileServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

export async function fetchActiveProfileBrowser(
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

// ── History (all non-discarded versions, version desc) ──────────────────────

export async function fetchProfileHistoryServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<AthleteProfileDocument[]> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .neq("status", "discarded")
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AthleteProfileDocument[];
}

export async function fetchProfileHistoryBrowser(
  userId: string,
): Promise<AthleteProfileDocument[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .neq("status", "discarded")
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AthleteProfileDocument[];
}

// ── Draft ───────────────────────────────────────────────────────────────────

export async function fetchDraftProfileServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

export async function fetchDraftProfileBrowser(
  userId: string,
): Promise<AthleteProfileDocument | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

// ── Single doc by id (used by ViewModal for any version) ────────────────────

export async function fetchProfileByIdServer(
  supabase: SupabaseClient,
  userId: string,
  id: string,
): Promise<AthleteProfileDocument | null> {
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}

export async function fetchProfileByIdBrowser(
  userId: string,
  id: string,
): Promise<AthleteProfileDocument | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("athlete_profile_documents")
    .select(COLS)
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as AthleteProfileDocument | null) ?? null;
}
