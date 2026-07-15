# Garmin collector sidecar

Pulls Fenix 8 daily metrics via the unofficial `python-garminconnect` and POSTs
them to `/api/ingest/garmin`. All derivation happens app-side; this is a dumb pump.

## Setup
1. `python3 -m venv .venv && source .venv/bin/activate`
2. `pip install -r requirements.txt`
3. `cp .env.example .env` and fill in Garmin creds + the ingest token
   (mint it on the app: Profile → rotate ingest token).
4. First run does an interactive login: `set -a; source .env; set +a; ./.venv/bin/python collector.py`
   — if 2FA is on you'll be asked for a 6-digit code once. The token is saved to
   `~/.garminconnect` and reused after that.

## Daily schedule (macOS launchd — runs once on first internet of the day)

[run-when-online.sh](run-when-online.sh) is invoked by launchd every 5 minutes
and exits instantly unless: it's past 07:00 local (`GARMIN_EARLIEST`
override), the Mac is online, and today hasn't run yet. The first
connectivity after 07:00 triggers one collector run, stamped in
`~/.garmin-collector-success`. A hard failure (rc=1, network/login error)
does NOT stamp and retries on the next tick; a clean run stamps even when
today's overnight block was empty (rc=2, watch not synced) — that gap is
covered by tomorrow's `BACKFILL_DAYS` pull.

- Install: `cp com.apex.garmin-collector.plist ~/Library/LaunchAgents/` (fix
  the two absolute paths inside if the repo lives elsewhere), then
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.apex.garmin-collector.plist`.
- Force a test run: delete the stamp file, then
  `launchctl kickstart gui/$(id -u)/com.apex.garmin-collector`.

## New-Mac migration checklist
1. Clone the repo; `cd sidecar/garmin`.
2. Install Python ≥3.10 (python.org — macOS system Python is too old), then
   `python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt`.
3. Carry over the TWO secret files (not in git): `sidecar/garmin/.env`
   (Garmin creds + ingest token/url) and `~/.garminconnect` (saved token —
   or skip it and do one interactive MFA login per Setup step 4).
4. Install + load the plist as above. Done — first internet after 07:00
   triggers the daily pull.

Linux fallback (plain cron, fixed time):
```
30 8 * * * cd /path/to/sidecar/garmin && set -a && source .env && set +a && ./.venv/bin/python collector.py >> ~/garmin-collector.log 2>&1
```

## Notes
- Unofficial API: expect occasional breakage. Fix with `pip install -U garminconnect`.
- During the parallel month, `daily_logs_upserted` will be 0 (WHOOP still owns
  daily_logs); the route stores everything in `garmin_daily` for comparison.
