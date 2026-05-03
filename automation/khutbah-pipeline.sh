#!/bin/bash
# คุฏบะฮ์แปลไทย — Weekly Pipeline Runner
# Triggered by launchd every Friday at 18:00 Bangkok time

export HOME="/Users/faizal"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin"
export KMP_DUPLICATE_LIB_OK=TRUE

PROJECT="$HOME/Project/khutbah-thai"
LOG_DIR="$PROJECT/output/logs"
DATE=$(date +%Y-%m-%d)
LOG="$LOG_DIR/pipeline-$DATE.log"

mkdir -p "$LOG_DIR"

echo "$(date): Starting pipeline for $DATE" >> "$LOG"

# Wait for Jumu'ah Khutbah videos (check every 5 min, max 2 hours)
MAX_WAIT=24
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  # Simple check: try fetch and see if it finds videos
  COUNT=$(cd "$PROJECT" && yt-dlp --flat-playlist --print "%(title)s" --playlist-end 20 \
    "https://www.youtube.com/channel/UC37tvO47bp_cKH1f4_VQCOA/videos" 2>/dev/null \
    | grep -c "Jumu'ah Khutbah" || echo "0")

  if [ "$COUNT" -ge "2" ]; then
    echo "$(date): Found $COUNT khutbah videos — starting pipeline" >> "$LOG"
    break
  fi

  echo "$(date): Waiting for videos ($WAITED/$MAX_WAIT, found $COUNT)..." >> "$LOG"
  sleep 300
  WAITED=$((WAITED + 1))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  echo "$(date): Timeout — no videos found after 2 hours" >> "$LOG"
  exit 1
fi

# Run pipeline
cd "$PROJECT"
bun pipeline/run.ts "$DATE" >> "$LOG" 2>&1
EXIT_CODE=$?

echo "$(date): Pipeline finished with exit code $EXIT_CODE" >> "$LOG"
exit $EXIT_CODE
