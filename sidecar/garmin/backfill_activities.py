#!/usr/bin/env python3
"""One-shot: dump every activity in a date range to JSON for the app to ingest.

Read-only against Garmin. Writes DUMP_PATH; scripts/backfill-garmin-activities.mjs
loads it and upserts. Kept separate from collector.py so the daily path stays
small and this can be re-run without touching the LaunchAgent.
"""
import json
import os
import sys

from garminconnect import Garmin

import collector

g = collector.login()
start, end = os.environ["RANGE_START"], os.environ["RANGE_END"]

acts = g.get_activities_by_date(start, end)
print(f"{len(acts)} activities {start} → {end}", file=sys.stderr)

# Distinct days, not per-activity: collect_activities re-lists and re-fetches
# every activity for the day it is given, so iterating activities would refetch
# a multi-activity day once per activity — pure redundant API load against an
# unofficial endpoint, and every extra call is another chance to trip the
# transient failure the loop below is trying to detect.
days = sorted({(a.get("startTimeLocal") or "")[:10] for a in acts if a.get("startTimeLocal")})
expected = {}
for a in acts:
    d = (a.get("startTimeLocal") or "")[:10]
    expected[d] = expected.get(d, 0) + 1

out = []
failed_days = []
for day in days:
    recs = collector.collect_activities(g, day)
    for r in recs:
        if not any(x["external_id"] == r["external_id"] for x in out):
            r["local_date"] = day
            out.append(r)
    got, want = len(recs), expected.get(day, 0)
    print(f"  {day}: {got}/{want}", file=sys.stderr)
    if got < want:
        failed_days.append((day, got, want))

json.dump(out, open(os.environ["DUMP_PATH"], "w"))
print(f"wrote {len(out)} activities to {os.environ['DUMP_PATH']}", file=sys.stderr)

# A day whose fetch failed comes back empty, which is indistinguishable in the
# dump from a genuine rest day. Comparing against the range listing is the only
# way to tell, and an operator must not have to go stderr-archaeology hunting
# for a `warn:` line to discover the backfill is short.
activities_incomplete = bool(failed_days)
if failed_days:
    print(f"\nINCOMPLETE — {len(failed_days)} day(s) returned fewer activities than the range listing:",
          file=sys.stderr)
    for day, got, want in failed_days:
        print(f"  {day}: got {got}, expected {want}", file=sys.stderr)
    print("Re-run before upserting; a partial dump looks complete to the upsert script.",
          file=sys.stderr)

# --- All-day HR pass (strain calibration fixture, Task 14) ---
#
# garmin_daily has zero rows before the app's Garmin cutover (2026-06-01), so
# the April-May labelled WHOOP-strain days have no all_day_samples for
# scripts/freeze-strain-calibration.mjs to read — that fixture's baseline TRIMP
# term needs the native 2-minute all-day stream, which lives on Garmin's
# servers independent of when our app started ingesting it. This pass fetches
# it for EVERY calendar day in the range (not just days with activities, since
# rest days feed the baseline term too) and writes a companion dump for
# scripts/backfill-garmin-daily-hr.mjs to upsert — deliberately NOT via
# /api/ingest/garmin, which also recomputes daily_logs.strain and would
# overwrite the WHOOP values this whole exercise exists to preserve.
#
# Opt-in via DAILY_HR_DUMP_PATH so an ordinary activities-only backfill run is
# unaffected.
daily_hr_incomplete = False
daily_hr_path = os.environ.get("DAILY_HR_DUMP_PATH")
if daily_hr_path:
    from datetime import date, timedelta

    start_d, end_d = date.fromisoformat(start), date.fromisoformat(end)
    all_days = []
    d = start_d
    while d <= end_d:
        all_days.append(d.isoformat())
        d += timedelta(days=1)

    hr_out = []
    hr_failed_days = []
    for day in all_days:
        try:
            hr = g.get_heart_rates(day)
        except Exception as e:  # noqa: BLE001 — unofficial API, best-effort
            print(f"  warn: get_heart_rates failed for {day}: {e}", file=sys.stderr)
            hr_failed_days.append(day)
            continue
        samples = [[t, b] for t, b in (hr.get("heartRateValues") or []) if b is not None] if hr else []
        hr_out.append({"date": day, "hr_samples": samples})
        print(f"  {day}: {len(samples)} all-day HR samples", file=sys.stderr)
        if not samples:
            hr_failed_days.append(day)

    json.dump(hr_out, open(daily_hr_path, "w"))
    print(f"wrote {len(hr_out)} days of all-day HR to {daily_hr_path}", file=sys.stderr)

    if hr_failed_days:
        daily_hr_incomplete = True
        print(
            f"\n{len(hr_failed_days)} day(s) came back with zero all-day HR samples "
            "(read error or genuinely no wear):",
            file=sys.stderr,
        )
        for day in hr_failed_days:
            print(f"  {day}", file=sys.stderr)
        print(
            "Investigate before treating the fixture as final — a day silently empty "
            "here is a day the baseline term will silently miss.",
            file=sys.stderr,
        )

if activities_incomplete or daily_hr_incomplete:
    sys.exit(1)
