#!/usr/bin/env python3
"""Garmin Fenix 8 → Apex Health OS collector (the "pump").

Pulls raw daily metrics via python-garminconnect and POSTs them to the app's
/api/ingest/garmin route. No derivation here — all strain/recovery logic lives
in the TypeScript app. Run once daily via cron.
"""
import os
import sys
from datetime import date, timedelta

import requests
from garminconnect import Garmin

TOKENSTORE = os.path.expanduser("~/.garminconnect")

# Overnight-complete metrics: available on wake, so they can be fetched for
# *today* (Garmin keys last night's sleep to the wake-day). All-day metrics
# (movement/strain/body battery/stress) are excluded — they stay complete-days-only.
OVERNIGHT_KEYS = {
    "hrv", "resting_hr", "sleep_hours", "sleep_score",
    "deep_sleep_hours", "rem_sleep_hours", "respiratory_rate",
    "training_readiness",
}


def overnight_only(day: dict) -> dict:
    """Filter a full day payload down to overnight-complete metrics (+ date)."""
    return {k: v for k, v in day.items() if k == "date" or k in OVERNIGHT_KEYS}


def login() -> Garmin:
    """Log in, reusing the persisted token; fall back to full login + MFA.

    garminconnect >=0.3 handles the whole flow inside ``login(tokenstore)``:
    it loads saved tokens from that path when present (and refreshes them),
    otherwise performs a full credential login — calling ``prompt_mfa`` if 2FA
    is enabled — and then dumps the fresh tokens back to the path automatically.
    """
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    g = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: "))
    g.login(TOKENSTORE)
    return g


def collect_day(g: Garmin, d: str) -> dict:
    """Assemble one day's raw payload. Each getter is wrapped so a single
    missing metric never aborts the day."""
    def safe(fn, *a):
        try:
            return fn(*a)
        except Exception as e:  # noqa: BLE001 — unofficial API, best-effort
            print(f"  warn: {fn.__name__} failed for {d}: {e}", file=sys.stderr)
            return None

    day = {"date": d}

    hrv = safe(g.get_hrv_data, d)
    if hrv and hrv.get("hrvSummary"):
        day["hrv"] = hrv["hrvSummary"].get("lastNightAvg")

    rhr = safe(g.get_rhr_day, d)
    if rhr and rhr.get("allMetrics"):
        # shape: allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE[0].value
        try:
            m = rhr["allMetrics"]["metricsMap"]["WELLNESS_RESTING_HEART_RATE"]
            day["resting_hr"] = m[0]["value"]
        except (KeyError, IndexError, TypeError):
            pass

    tr = safe(g.get_training_readiness, d)
    if isinstance(tr, list) and tr:
        day["training_readiness"] = tr[0].get("score")
    elif isinstance(tr, dict):
        day["training_readiness"] = tr.get("score")

    bb = safe(g.get_body_battery, d, d)
    if isinstance(bb, list) and bb:
        vals = [x for x in (bb[0].get("bodyBatteryValuesArray") or []) if len(x) > 1]
        # Some time-points have no reading (v[1] is None); drop them before min/max.
        levels = [v[1] for v in vals if v[1] is not None]
        if levels:
            day["body_battery_low"] = min(levels)
            day["body_battery_peak"] = max(levels)

    sleep = safe(g.get_sleep_data, d)
    if sleep and sleep.get("dailySleepDTO"):
        dto = sleep["dailySleepDTO"]
        secs = dto.get("sleepTimeSeconds")
        if secs:
            day["sleep_hours"] = round(secs / 3600, 2)
        if dto.get("deepSleepSeconds") is not None:
            day["deep_sleep_hours"] = round(dto["deepSleepSeconds"] / 3600, 2)
        if dto.get("remSleepSeconds") is not None:
            day["rem_sleep_hours"] = round(dto["remSleepSeconds"] / 3600, 2)
        overall = ((dto.get("sleepScores") or {}).get("overall") or {})
        if overall.get("value") is not None:
            day["sleep_score"] = overall["value"]
        # Sleep-average respiration, to match WHOOP's sleep-based respiratory_rate
        # (NOT stats.avgWakingRespirationValue — that's waking, a different metric).
        if dto.get("averageRespirationValue") is not None:
            day["respiratory_rate"] = dto["averageRespirationValue"]

    stats = safe(g.get_stats, d)
    if stats:
        if stats.get("totalSteps") is not None:
            day["steps"] = stats["totalSteps"]
        if stats.get("totalDistanceMeters") is not None:
            day["distance_km"] = round(stats["totalDistanceMeters"] / 1000, 2)
        if stats.get("totalKilocalories") is not None:
            day["calories"] = stats["totalKilocalories"]
        if stats.get("activeKilocalories") is not None:
            day["active_calories"] = stats["activeKilocalories"]
        # Garmin uses -1/-2 for "no data"; store only real (>=0) stress values.
        sa = stats.get("averageStressLevel")
        if sa is not None and sa >= 0:
            day["stress_avg"] = sa
        sm = stats.get("maxStressLevel")
        if sm is not None and sm >= 0:
            day["stress_max"] = sm
        if stats.get("stressQualifier"):
            day["stress_qualifier"] = stats["stressQualifier"]

    spo2 = safe(g.get_spo2_data, d)
    if isinstance(spo2, dict):
        # Garmin uses -1/None sentinels for "no reading"; keep only real avg.
        avg = spo2.get("averageSpo2") if spo2.get("averageSpo2") is not None else spo2.get("averageSpO2")
        if isinstance(avg, (int, float)) and avg > 0:
            day["spo2"] = avg

    ts = safe(g.get_training_status, d)
    if isinstance(ts, dict):
        # acute/chronic load live under mostRecentTrainingLoadBalance; shape
        # varies by firmware — best-effort extraction.
        try:
            # Nested Garmin fields are frequently null; `... or {}` guards each hop.
            bal = ts.get("mostRecentTrainingLoadBalance") or {}
            metrics = list((bal.get("metricsTrainingLoadBalanceDTOMap") or {}).values())
            if metrics:
                # Best-effort: dict order is undocumented; this may not always be the acute value. Verify against a real response.
                day["acute_load"] = metrics[0].get("acwrPercent")
        except (KeyError, IndexError, TypeError, AttributeError):
            pass

    hr = safe(g.get_heart_rates, d)
    if hr and hr.get("heartRateValues"):
        # [[ts_ms, bpm], ...]; drop nulls (off-wrist)
        day["hr_samples"] = [[t, b] for t, b in hr["heartRateValues"] if b is not None]

    return day


def main() -> int:
    n = int(os.environ.get("BACKFILL_DAYS", "4"))
    g = login()
    days = []
    for i in range(1, n + 1):
        d = (date.today() - timedelta(days=i)).isoformat()
        print(f"collecting {d} ...")
        days.append(collect_day(g, d))

    today = date.today().isoformat()
    print(f"collecting {today} (overnight-only) ...")
    today_overnight = overnight_only(collect_day(g, today))
    days.append(today_overnight)

    resp = requests.post(
        os.environ["INGEST_URL"],
        headers={"Authorization": f"Bearer {os.environ['INGEST_TOKEN']}"},
        json={"days": days},
        timeout=30,
    )
    print(f"ingest → {resp.status_code}: {resp.text}")
    if not resp.ok:
        return 1
    # Exit 2 = posted, but today's overnight block carried no metrics — the
    # Fenix likely hasn't synced to the phone yet. The launchd wrapper treats
    # this as retryable so the pull re-fires later in the morning window.
    if len(today_overnight) <= 1:  # only the "date" key
        print(f"today ({today}) overnight block empty — watch not synced yet?")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
