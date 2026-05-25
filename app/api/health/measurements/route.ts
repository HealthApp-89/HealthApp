// app/api/health/measurements/route.ts
//
// POST: upsert one body_measurements row keyed on (user_id, measured_on).
// Re-saving the same date overwrites — used both for "fix a typo" and for
// the explicit Edit flow. Empty/non-numeric circumference fields are stored
// as null. Negative values are rejected (hard validation per spec); values
// > 300 cm are accepted (soft warn lives in the form UI).
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  BODY_MEASUREMENT_FIELDS,
  type BodyMeasurementField,
} from "@/lib/data/types";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Body = {
  measured_on?: string;
  photo_path?: string | null;
  notes?: string | null;
} & Partial<Record<BodyMeasurementField, number | null>>;

function asNumOrNull(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number") return "invalid";
  if (!Number.isFinite(v)) return "invalid";
  if (v < 0) return "invalid";
  return v;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const measured_on = body.measured_on;
  if (!measured_on || !ISO_DATE.test(measured_on)) {
    return NextResponse.json({ ok: false, reason: "bad_date" }, { status: 400 });
  }

  // Validate + project the 14 numeric fields.
  const fields: Record<BodyMeasurementField, number | null> = {} as Record<
    BodyMeasurementField,
    number | null
  >;
  let anyValue = false;
  for (const k of BODY_MEASUREMENT_FIELDS) {
    const parsed = asNumOrNull(body[k]);
    if (parsed === "invalid") {
      return NextResponse.json(
        { ok: false, reason: "bad_value", field: k },
        { status: 400 },
      );
    }
    fields[k] = parsed;
    if (parsed !== null) anyValue = true;
  }
  if (!anyValue) {
    return NextResponse.json(
      { ok: false, reason: "empty_measurement" },
      { status: 400 },
    );
  }

  const photo_path =
    typeof body.photo_path === "string" && body.photo_path.length > 0
      ? body.photo_path
      : null;
  const notes =
    typeof body.notes === "string" && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;

  const { data: row, error } = await supabase
    .from("body_measurements")
    .upsert(
      {
        user_id: user.id,
        measured_on,
        ...fields,
        photo_path,
        notes,
      },
      { onConflict: "user_id,measured_on" },
    )
    .select("*")
    .single();
  if (error || !row) {
    return NextResponse.json(
      { ok: false, reason: "db_error", error: error?.message },
      { status: 500 },
    );
  }

  revalidatePath("/coach");
  return NextResponse.json({ ok: true, row });
}
