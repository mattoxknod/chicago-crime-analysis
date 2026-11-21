#!/usr/bin/env bash
# Downloads the Chicago crime extract one year per file.
#
#   bash scripts/fetch_crimes.sh
#
# Why a year per request, rather than the two more obvious approaches:
#
#   * The portal's one-click CSV export (api/views/ijzp-q8t2/rows.csv) streams
#     ~1.8 GB, advertises no Accept-Ranges, and answers a range request with
#     the whole body, so a dropped connection means starting from zero. It
#     reset on us at 902 MB.
#   * Paginating with $limit/$offset works but degrades badly with depth: the
#     server re-scans from the top for every window, so early chunks landed in
#     ~40 s while offset 4,500,000 produced no bytes at all in three minutes.
#
# Slicing on `year` keeps every request bounded and independent — each one
# returned in roughly 20 seconds in testing, regardless of which year it was.
# The largest year in the series is just under 490,000 rows, comfortably inside
# one request. Each year's row count is checked against the portal's own count
# for that year, so a truncated response fails here rather than becoming a
# quietly wrong number on a chart.

set -euo pipefail

RAW="data/raw/crimes_years"
UA="chicago-crime-analysis (mattoxknod@gmail.com)"
BASE="https://data.cityofchicago.org/resource/ijzp-q8t2.csv"
# The .csv form of the same endpoint: the index is parsed with awk, so asking
# for CSV avoids needing any JSON tooling here.
COUNT_URL="https://data.cityofchicago.org/resource/ijzp-q8t2.csv"

# Only the columns the analysis uses. Dropping case_number, block, the x/y
# state-plane coordinates and the redundant location struct roughly halves the
# transfer.
COLS='id,date,primary_type,description,location_description,arrest,domestic,beat,district,ward,community_area,fbi_code,iucr,year,updated_on,latitude,longitude'

mkdir -p "$RAW"

echo "Reading the year index..."
# One request gives every year and its row count: the download plan and the
# integrity check in a single call. Requested as CSV rather than JSON so it
# parses with awk and needs no JSON tooling.
curl -sS --fail --max-time 300 -A "$UA" \
  "$COUNT_URL?\$select=year,count(1)%20as%20n&\$group=year&\$order=year" \
  > "$RAW/_index.csv"

# Strip the header and the quotes, then split on the comma, leaving
# "year count" pairs. Kept as two plain awk stages: setting FS on the first
# stage makes gsub rebuild $0 with spaces, and the comma the second stage needs
# is gone.
INDEX=$(awk 'NR>1 { gsub(/"/, ""); print $0 }' "$RAW/_index.csv" \
        | awk -F, 'NF >= 2 { print $1, $2 }')
YEARS=$(echo "$INDEX" | awk '{ print $1 }')
TOTAL_EXPECTED=$(echo "$INDEX" | awk '{ s += $2 } END { print s+0 }')
echo "  $(echo "$YEARS" | wc -w) years, $TOTAL_EXPECTED rows expected in total"

if [ "$TOTAL_EXPECTED" -le 0 ]; then
  echo "Could not read the year index — refusing to download blind" >&2
  exit 1
fi

for y in $YEARS; do
  expected=$(echo "$INDEX" | awk -v y="$y" '$1 == y { print $2 }')
  out="$RAW/crimes_$y.csv"

  if [ -s "$out" ]; then
    have=$(( $(wc -l < "$out") - 1 ))
    if [ "$have" -eq "$expected" ]; then
      echo "  $y  present and complete ($have rows), skipping"
      continue
    fi
    echo "  $y  present but $have of $expected rows — refetching"
  fi

  ok=0
  for attempt in 1 2 3 4 5; do
    if curl -sS --fail --max-time 900 -A "$UA" -o "$out.part" \
         "$BASE?\$select=$COLS&\$where=year=$y&\$limit=600000"
    then
      have=$(( $(wc -l < "$out.part") - 1 ))
      if [ "$have" -eq "$expected" ]; then
        mv "$out.part" "$out"
        echo "  $y  ok ($have rows)"
        ok=1
        break
      fi
      echo "  $y  attempt $attempt returned $have of $expected rows, retrying"
    else
      echo "  $y  attempt $attempt failed, retrying"
    fi
    rm -f "$out.part"
    sleep $((attempt * 10))
  done

  if [ "$ok" -ne 1 ]; then
    echo "  $y  GAVE UP after 5 attempts — rerun to retry just this year" >&2
    exit 1
  fi
done

echo
DOWNLOADED=$(awk 'FNR>1' "$RAW"/crimes_*.csv | wc -l)
echo "Downloaded $DOWNLOADED rows across $(ls "$RAW"/crimes_*.csv | wc -l) files"
echo "Portal reported $TOTAL_EXPECTED"
if [ "$DOWNLOADED" -ne "$TOTAL_EXPECTED" ]; then
  echo "ROW COUNT MISMATCH — do not build on this data" >&2
  exit 1
fi
echo "Row counts agree. Next: duckdb data/derived/crimes.duckdb -c \".read sql/01_load.sql\""
