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

out = []
for a in acts:
    day = (a.get("startTimeLocal") or "")[:10]
    recs = collector.collect_activities(g, day)
    for r in recs:
        if not any(x["external_id"] == r["external_id"] for x in out):
            r["local_date"] = day
            out.append(r)
    print(f"  {day}: {len(recs)}", file=sys.stderr)

json.dump(out, open(os.environ["DUMP_PATH"], "w"))
print(f"wrote {len(out)} activities to {os.environ['DUMP_PATH']}", file=sys.stderr)
