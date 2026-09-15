#!/usr/bin/env bash
# Backfill/refresh screener.in company pages for the Nifty 200 universe.
#
#   ./fetch.sh                 # all symbols, skips ones already fetched today
#   ./fetch.sh --only A,B,C    # just these symbols
#   ./fetch.sh --limit 20      # first N pending symbols
#
# Sequential only, randomised 4-9s gap, cookie jar persisted, and a circuit
# breaker that halts the whole run on the first sign of rate limiting.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DATE=$(date +%F)
RAW=data/raw
STATE=data/state
LOG="$STATE/runs/fetch-$DATE.jsonl"
JAR="$STATE/screener.jar"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
MIN_GAP=4
MAX_GAP=9
ONLY=""; LIMIT=0; STANDALONE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --only)  ONLY="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --standalone) STANDALONE=1; shift ;;   # companies with no consolidated filing
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$RAW" "$STATE/runs"

if [ -n "$ONLY" ]; then
  SYMBOLS=$(echo "$ONLY" | tr ',' ' ')
else
  SYMBOLS=$(node -e "console.log(require('./symbols.json').join(' '))")
fi

# percent-encode the few symbols carrying '&' (M&M, M&MFIN)
urlenc() { echo "$1" | sed 's/&/%26/g'; }

ok=0; skip=0; err=0; n=0
echo "run start $DATE  gap ${MIN_GAP}-${MAX_GAP}s"

for S in $SYMBOLS; do
  OUT="$RAW/$S/$DATE.html.gz"
  if [ -f "$OUT" ] && [ "$STANDALONE" = "0" ]; then skip=$((skip+1)); continue; fi
  if [ "$LIMIT" -gt 0 ] && [ "$n" -ge "$LIMIT" ]; then break; fi
  n=$((n+1))

  mkdir -p "$RAW/$S"
  if [ "$STANDALONE" = "1" ]; then SUFFIX=""; else SUFFIX="consolidated/"; fi
  TMP=$(mktemp)
  read -r CODE FINAL BYTES <<<"$(curl -sL --max-time 45 --compressed \
      -b "$JAR" -c "$JAR" \
      -A "$UA" \
      -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
      -H "Accept-Language: en-US,en;q=0.9" \
      -H "Referer: https://www.screener.in/" \
      "https://www.screener.in/company/$(urlenc "$S")/$SUFFIX" \
      -o "$TMP" -w "%{http_code} %{url_effective} %{size_download}")"

  # circuit breaker - stop the entire run, do not retry
  case "$CODE" in
    403|429|503)
      printf '{"ts":"%s","symbol":"%s","status":%s,"event":"circuit_break"}\n' \
        "$(date -Iseconds)" "$S" "$CODE" >> "$LOG"
      rm -f "$TMP"
      echo ""
      echo "!! HTTP $CODE on $S - halting run (fetched $ok this session)"
      echo "!! resume later with the same command; completed symbols are skipped"
      exit 3 ;;
  esac

  RAWSIZE=$(stat -c%s "$TMP" 2>/dev/null || echo 0)
  if [ "$CODE" = "404" ]; then
    err=$((err+1))
    printf '{"ts":"%s","symbol":"%s","status":404,"event":"not_found"}
' \n      "$(date -Iseconds)" "$S" >> "$LOG"
    echo "$S" >> "$STATE/unresolved.txt"
    printf '  %-14s NOT FOUND on screener (needs slug mapping)
' "$S"
  elif [ "$CODE" = "200" ] && [ "$RAWSIZE" -gt 50000 ]; then
    gzip -9 -c "$TMP" > "$OUT"
    case "$FINAL" in
      *"/consolidated/") VARIANT=consolidated ;;
      *)                 VARIANT=standalone ;;
    esac
    ok=$((ok+1))
    printf '{"ts":"%s","symbol":"%s","status":200,"variant":"%s","bytes":%s,"gz":%s}\n' \
      "$(date -Iseconds)" "$S" "$VARIANT" "$RAWSIZE" "$(stat -c%s "$OUT")" >> "$LOG"
    printf '  %-14s %s  %6s KB -> %4s KB gz\n' "$S" "$VARIANT" "$((RAWSIZE/1024))" "$(( $(stat -c%s "$OUT") /1024))"
  else
    err=$((err+1))
    printf '{"ts":"%s","symbol":"%s","status":%s,"bytes":%s,"event":"bad_response"}\n' \
      "$(date -Iseconds)" "$S" "$CODE" "$RAWSIZE" >> "$LOG"
    printf '  %-14s FAILED http=%s bytes=%s\n' "$S" "$CODE" "$RAWSIZE"
  fi
  rm -f "$TMP"

  GAP=$(( MIN_GAP + RANDOM % (MAX_GAP - MIN_GAP + 1) ))
  sleep "$GAP"
done

echo ""
echo "done: $ok fetched, $skip already present, $err failed"
