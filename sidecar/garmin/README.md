# Garmin collector sidecar

Pulls Fenix 8 daily metrics via the unofficial `python-garminconnect` and POSTs
them to `/api/ingest/garmin`. All derivation happens app-side; this is a dumb pump.

## Setup
1. `python3 -m venv .venv && source .venv/bin/activate`
2. `pip install -r requirements.txt`
3. `cp .env.example .env` and fill in Garmin creds + the ingest token
   (mint it on the app: Profile → rotate ingest token).
4. First run does an interactive login: `set -a; source .env; set +a; python collector.py`
   — if 2FA is on you'll be asked for a 6-digit code once. The token is saved to
   `~/.garminconnect` and reused after that.

## Daily schedule (Mac/Linux cron, 08:30 local)
```
30 8 * * * cd /path/to/sidecar/garmin && set -a && source .env && set +a && ./.venv/bin/python collector.py >> ~/garmin-collector.log 2>&1
```

## Notes
- Unofficial API: expect occasional breakage. Fix with `pip install -U garminconnect`.
- During the parallel month, `daily_logs_upserted` will be 0 (WHOOP still owns
  daily_logs); the route stores everything in `garmin_daily` for comparison.
