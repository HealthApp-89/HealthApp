#!/bin/zsh
# Garmin collector trigger for launchd. Called every few minutes; the first
# time the Mac has internet on a given day (not before EARLIEST local time),
# the collector runs ONCE and the day is stamped. A hard failure (rc=1,
# network/login error) does NOT stamp — it retries on the next 5-min tick.
# A clean run counts even if today's overnight block was empty (rc=2, watch
# not synced yet); that gap is covered by tomorrow's BACKFILL_DAYS pull.

DIR="${0:A:h}"
STAMP="$HOME/.garmin-collector-success"  # holds YYYY-MM-DD of last run
EARLIEST="${GARMIN_EARLIEST:-0700}"      # don't arm before this local HHMM

today=$(date +%F)
now=$(date +%H%M)

# Already ran today?
[[ -f "$STAMP" && "$(cat "$STAMP")" == "$today" ]] && exit 0

# Too early? (zero-padded HHMM compares fine as strings)
[[ "$now" < "$EARLIEST" ]] && exit 0

# Online? Any HTTP response counts; DNS/connect failure means offline.
curl -s --max-time 5 -o /dev/null https://connect.garmin.com || exit 0

echo "[$(date '+%F %T')] first online today: running collector" >> "$HOME/garmin-collector.log"
cd "$DIR"
set -a; source .env; set +a
./.venv/bin/python collector.py >> "$HOME/garmin-collector.log" 2>&1
rc=$?

if (( rc == 0 )); then
  echo "$today" > "$STAMP"
  echo "[$(date '+%F %T')] success" >> "$HOME/garmin-collector.log"
elif (( rc == 2 )); then
  echo "$today" > "$STAMP"
  echo "[$(date '+%F %T')] posted, but today's overnight block was empty (watch not synced) — next attempt tomorrow" >> "$HOME/garmin-collector.log"
else
  echo "[$(date '+%F %T')] collector failed (rc=$rc) — not stamped, will retry on next tick" >> "$HOME/garmin-collector.log"
fi
exit 0
