#!/usr/bin/env bash
# Downloads every raw input this project uses. Run from the repository root:
#   bash scripts/fetch_data.sh
#
# Nothing here is committed to the repository: data/raw/ is gitignored because
# the crime extract is ~1.8 GB, well past GitHub's 100 MB per-file limit. The
# committed artifacts are the small aggregates in data/derived/, which
# sql/build_cubes.sql rebuilds from these files.
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

echo "1/4  Crimes, 2001 to present (one row per reported incident)"
fetch "https://data.cityofchicago.org/api/views/ijzp-q8t2/rows.csv?accessType=DOWNLOAD" \
      "$RAW/crimes.csv" "crimes.csv"

echo "2/4  ACS 5-year population and demographics by community area (2023)"
fetch "https://data.cityofchicago.org/resource/t68z-cikk.csv?\$limit=200" \
      "$RAW/acs_community_area.csv" "acs_community_area.csv"

echo "3/4  Selected socioeconomic indicators by community area (2008-2012)"
fetch "https://data.cityofchicago.org/resource/kn9c-c2s2.csv?\$limit=200" \
      "$RAW/socioeconomic.csv" "socioeconomic.csv"

# Note: the older cauq-8yn6 geospatial export now returns an empty
# FeatureCollection. igwz-8jzy is the live boundary layer, and its
# area_numbe property joins to community_area in crimes.csv.
echo "4/4  Community area boundaries (GeoJSON, for the map page)"
fetch "https://data.cityofchicago.org/resource/igwz-8jzy.geojson?\$limit=100" \
      "$RAW/community_areas.geojson" "community_areas.geojson"

echo
echo "Done. Next: duckdb -c \".read sql/build_cubes.sql\" to rebuild data/derived/."
