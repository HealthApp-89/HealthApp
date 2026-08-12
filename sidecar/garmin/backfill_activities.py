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
if failed_days:
    print(f"\nINCOMPLETE — {len(failed_days)} day(s) returned fewer activities than the range listing:",
          file=sys.stderr)
    for day, got, want in failed_days:
        print(f"  {day}: got {got}, expected {want}", file=sys.stderr)
    print("Re-run before upserting; a partial dump looks complete to the upsert script.",
          file=sys.stderr)
    sys.exit(1)
