#!/usr/bin/env bash
# Downloads the supporting reference data (not the incident extract). Run from the repository root:
#   bash scripts/fetch_data.sh
#
# Nothing here is committed to the repository: data/raw/ is gitignored because
# the incident extract alongside these files runs to ~1.9 GB, well past
# GitHub's 100 MB per-file limit. The committed artifacts are the small
# aggregates in data/derived/, which sql/02_findings.sql and sql/03_cubes.sql
# rebuild from the raw data.
#
# Every URL below was verified reachable on 2026-11-20.

set -euo pipefail

RAW="data/raw"
mkdir -p "$RAW"

# A contact address is courteous on public data portals and required by the SEC;
# the Chicago portal does not demand it but will not refuse it either.
UA="chicago-crime-analysis (mattoxknod@gmail.com)"

fetch () {
  local url="$1" out="$2" label="$3"
  if [ -s "$out" ]; then
    printf '  already present, skipping: %s\n' "$label"
    return 0
  fi
  printf '  downloading %s\n' "$label"
  # --fail so an HTML error page never lands in place of the data.
  curl -sSL --fail --max-time 5400 -A "$UA" -o "$out.part" "$url"
  mv "$out.part" "$out"
  printf '    -> %s (%s bytes)\n' "$out" "$(wc -c < "$out")"
}

# The incident extract itself is NOT fetched here. It lives in
# scripts/fetch_crimes.sh, which slices it by year and checks each year's row
# count; the portal's one-click export this script originally used is a
# non-resumable ~1.9 GB stream that reset on us partway through.

echo "1/3  ACS 5-year population and demographics by community area (2023)"
fetch "https://data.cityofchicago.org/resource/t68z-cikk.csv?\$limit=200" \
      "$RAW/acs_community_area.csv" "acs_community_area.csv"

echo "2/3  Selected socioeconomic indicators by community area (2008-2012)"
fetch "https://data.cityofchicago.org/resource/kn9c-c2s2.csv?\$limit=200" \
      "$RAW/socioeconomic.csv" "socioeconomic.csv"

# Note: the older cauq-8yn6 geospatial export now returns an empty
# FeatureCollection. igwz-8jzy is the live boundary layer, and its
# area_numbe property joins to community_area in the incident extract.
echo "3/3  Community area boundaries (GeoJSON, for the map page)"
fetch "https://data.cityofchicago.org/resource/igwz-8jzy.geojson?\$limit=100" \
      "data/derived/community_areas.geojson" "community_areas.geojson"

echo
echo "Done. Next: bash scripts/fetch_crimes.sh for the incident extract."
