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


def login() -> Garmin:
    """Log in, reusing the persisted token; fall back to full login + MFA."""
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    try:
        g = Garmin()
        g.login(TOKENSTORE)  # reuse saved tokens
        return g
    except Exception:
        # Any failure (no saved token, expired token, auth error) → full re-login.
        # First run or expired token: full login. prompt_mfa is called if 2FA
        # is enabled — you type the 6-digit code once; the token is then saved.
        g = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: "))
        g.login()
        g.garth.dump(TOKENSTORE)
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
        if vals:
            levels = [v[1] for v in vals]
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
        if dto.get("sleepScores", {}).get("overall", {}).get("value") is not None:
            day["sleep_score"] = dto["sleepScores"]["overall"]["value"]

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
        if stats.get("avgWakingRespirationValue") is not None:
            day["respiratory_rate"] = stats["avgWakingRespirationValue"]

    ts = safe(g.get_training_status, d)
    if isinstance(ts, dict):
        # acute/chronic load live under mostRecentTrainingLoadBalance; shape
        # varies by firmware — best-effort extraction.
        try:
            bal = ts.get("mostRecentTrainingLoadBalance", {})
            metrics = list(bal.get("metricsTrainingLoadBalanceDTOMap", {}).values())
            if metrics:
                # Best-effort: dict order is undocumented; this may not always be the acute value. Verify against a real response.
                day["acute_load"] = metrics[0].get("acwrPercent")
        except (KeyError, IndexError, TypeError):
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

    resp = requests.post(
        os.environ["INGEST_URL"],
        headers={"Authorization": f"Bearer {os.environ['INGEST_TOKEN']}"},
        json={"days": days},
        timeout=30,
    )
    print(f"ingest → {resp.status_code}: {resp.text}")
    return 0 if resp.ok else 1


if __name__ == "__main__":
    sys.exit(main())
