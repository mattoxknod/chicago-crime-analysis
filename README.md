# Chicago, Reported

A two-page website built on the City of Chicago's **Crimes — 2001 to Present**
dataset: 8,682,885 reported incidents across 26 years and 77 community areas.

- **Report** — `index.html`. Fourteen plates and a colophon, each stating a
  finding, the numbers behind it, and a chart.
- **Dashboard** — `dashboard.html`. Filters, switchable measures and
  breakdowns, four charts and a table, all recomputed in the browser.
- **Map** — `map.html`. The 77 community areas, shaded by a switchable measure,
  with a profile for each.

Live site: https://mattoxknod.github.io/chicago-crime-analysis/

## The argument

Reported incidents in Chicago fell 56.9% between 2002 and 2021. Over the same
period the share of incidents ending in an arrest fell further still, from
31.1% in 2005 to 11.8% in 2022.

There is a tidy explanation available for that second number, and the middle of
the report is spent establishing that it accounts for about a quarter of it.

The tidy explanation: arrest rates by offence do not form a spectrum of how
hard crimes are to solve, they form two clusters. Narcotics, prostitution,
gambling and liquor violations sit near 100%, because an officer's arrest is
*how those offences enter the dataset at all* — nobody reports a possession
offence by an unknown offender. Burglary sits at 6%. Narcotics incidents fell
92% between 2004 and 2022, so losing them drags the citywide average down with
no change in clearance required.

Holding the offence mix at its 2001 composition and applying each year's own
within-group rates, the 2022 arrest rate would have been 16.5% rather than
11.8%. Of the 17.5-point fall, 4.8 points is composition — about 27%.

**The other three quarters is real.** The arrest rate fell within the
citizen-reported group too, from 16.7% to 7.1%, and even within the
police-initiated group, from 92.9% to 64.4%. FBI Part I clearance settles it,
since no composition argument touches a fixed category: violent Part I
clearance fell 42% and property Part I fell 73%, to the point where by 2022
roughly 28 reported burglaries, thefts, vehicle thefts and arsons were recorded
for every one that ended in an arrest.

This was not the conclusion the project set out to reach. The original
hypothesis was that composition explained most of the decline; it survived
contact with a 500,000-row sample and died against the full extract. The
decomposition is still the spine of the report — it just reaches a smaller and
better-supported claim.

## Reproducing every number

```bash
bash scripts/fetch_data.sh      # boundaries, ACS population, socioeconomics
bash scripts/fetch_crimes.sh    # the incident extract, one year per file

duckdb data/derived/crimes.duckdb -c ".read sql/01_load.sql"
duckdb data/derived/crimes.duckdb -c ".read sql/02_findings.sql"
duckdb data/derived/crimes.duckdb -c ".read sql/03_cubes.sql"
duckdb data/derived/crimes.duckdb -c ".read sql/04_verify.sql"

python3 -m http.server 8000     # then open http://localhost:8000
```

Requires the [DuckDB CLI](https://duckdb.org/docs/installation/) and `curl`. The
extract is ~1.6 GB across 26 files and takes roughly half an hour to fetch. The
pages need to be served over HTTP rather than opened as `file://`, because they
fetch their data.

No figure on either page is typed by hand. The prose in the report reads its
numbers from the same JSON files the charts do, so a sentence cannot drift away
from the chart beside it, and `sql/04_verify.sql` recomputes the report's
headline numbers from the dashboard's aggregates and fails the build if the two
disagree.

## Files

### Pages

| File | What it does |
|---|---|
| `index.html` | The report. Structure only — every heading, paragraph, figure and caption is written by `js/report.js`. |
| `dashboard.html` | The dashboard: filter controls, switches, chart panels, table. |
| `map.html` | The community area map and its profile panel. |

### Scripts and stylesheets

| File | What it does |
|---|---|
| `css/atlas.css` | The whole design system: tokens, typography, masthead, plates, figures, tables, controls. Shared by all three pages. |
| `css/PALETTE.md` | Why each colour is the value it is, with the validator scores. |
| `js/atlas-charts.js` | The chart library. Dependency-free: line, bar, stacked area, heatmap, sparkline, scatter, slope chart, choropleth, plus legends, tooltips and table twins. |
| `js/atlas-data.js` | Data loading, number and date helpers, the shared masthead. |
| `js/report.js` | Computes the report's derived figures and writes every plate. |
| `js/dashboard.js` | Parses the cubes into typed arrays, holds filter state, aggregates and renders. |
| `js/map.js` | The map page. |
| `scripts/fetch_crimes.sh` | Downloads the incident extract, one year per request, checking each year's row count against the portal's own count. |
| `scripts/fetch_data.sh` | Downloads boundaries, ACS population and socioeconomic indicators. |

### SQL

| File | What it does |
|---|---|
| `sql/01_load.sql` | Builds the incident table from the raw files: deduplicates, merges a relabelled offence, flags FBI Part I membership, classifies police-initiated against citizen-reported, flags geographic coding. Asserts its joins. |
| `sql/02_findings.sql` | Computes every number the report quotes and writes `data/derived/*.json`. |
| `sql/03_cubes.sql` | Builds the dashboard's three pre-aggregated cubes and exports them as CSV. |
| `sql/04_verify.sql` | Recomputes the report's headline numbers from the cubes and fails on any disagreement. |

### Data

`data/raw/` is **not committed**: the incident extract is about 1.9 GB across 26
files, far past GitHub's 100 MB per-file limit. `scripts/` rebuilds it from the
city's portal and `sql/` rebuilds everything downstream, so the pipeline is
reproducible from a clean clone.

`data/derived/` **is** committed — the small aggregates the pages actually
fetch, so the published site works without running anything:

| File | Contents |
|---|---|
| `headline.json` | The report's six headline figures. |
| `annual.json` | Per year: incidents, arrests, arrest rate, Part I counts and clearance, domestic share. |
| `decomposition.json` | Per year: the police-initiated/citizen-reported split and arrest rates within each. |
| `counterfactual.json` | Per year: the arrest rate with the offence mix held at its 2001 composition. |
| `type_year.json`, `type_totals.json` | Every offence type by year, and totals with first-to-last change. |
| `mvt_monthly.json` | Motor vehicle theft per month. |
| `seasonality.json` | Each month against its own year's mean. |
| `clock.json` | Hour-of-day profile for the twelve commonest offences. |
| `concentration.json` | Community areas ranked by violent incidents, with cumulative share. |
| `community_areas.json` | Per area: counts, per-100k rates, both rankings, population, income, hardship index. |
| `domestic.json`, `domestic_monthly.json` | Domestic share and arrest rates, annually and monthly. |
| `settings.json` | Share of incidents by setting, per year. |
| `quality.json`, `quality_by_year.json` | Everything the colophon reports about completeness. |
| `monthly.json` | Citywide monthly totals. |
| `cube_main.csv` | year × month × community area × offence group × arrest × domestic. The dashboard's main source: 588,887 rows, 2003 onward. The offence group travels as an integer code over `type_lookup.csv`, which more than halves the file. |
| `cube_clock.csv` | year × hour × weekday × offence group. |
| `cube_citywide.csv` | year × month × offence group × arrest × domestic, every year including the ungeocoded ones. Not loaded by the dashboard; it exists so `04_verify.sql` can check totals against the full incident count. |
| `community_areas.geojson` | The 77 community area boundaries, coordinates rounded to five decimals (about a metre) and stripped to the two properties the pages use: 2.0 MB down to 1.1 MB, 197 KB gzipped. Committed rather than left in `data/raw/`, because the map and the dashboard choropleth fetch it at runtime. |
| `ca_lookup.csv`, `type_lookup.csv`, `type_group_map.json` | The lookups the dashboard needs, and the offence-to-group mapping in full. |
| `geo_coverage.json` | Geographic coding coverage per year, and which years clear the threshold for map and community-area figures. |

## Where the data comes from

All from the City of Chicago open data portal:

| Dataset | ID | Used for |
|---|---|---|
| Crimes — 2001 to Present | `ijzp-q8t2` | Every incident figure. One row per reported incident. |
| Boundaries — Community Areas | `igwz-8jzy` | The map. |
| ACS 5-Year Data by Community Area | `t68z-cikk` | Population denominators for per-capita rates. |
| Selected socioeconomic indicators, 2008–2012 | `kn9c-c2s2` | Per-capita income and hardship index. |

Two notes for anyone rerunning this. The widely cited boundary layer
`cauq-8yn6` now returns an empty FeatureCollection; `igwz-8jzy` is the live one.
And the portal's one-click CSV export is not resumable — it advertises no
`Accept-Ranges` and answers a range request with the whole body — so
`fetch_crimes.sh` slices by year instead, which also keeps each request bounded;
`$limit`/`$offset` paging degrades badly with depth.

## Cleaning decisions

All of these are stated on the page as well as here.

- **Deduplicated** on the city's incident `id`, keeping the most recently
  updated row for each.
- **`CRIMINAL SEXUAL ASSAULT` and `CRIM SEXUAL ASSAULT` are merged.** The city
  relabelled the same offence partway through the series; left alone it reads as
  one category ending and another beginning.
- **Geographic coding phases in, so the maps start in 2003.** This is not a
  case of one missing year: 2001 is 1.3% geocoded and 2002 is 72.8%, against
  99.98%+ from 2003 on. A year that is a quarter unmapped understates each of
  its community areas by about a quarter, which on a map looks like a real
  shortfall rather than like missing data — the more dangerous of the two
  failures. So rather than hardcoding a cutoff, `sql/01_load.sql` keeps any
  year at or above 95% coverage and drops the rest. The citywide series still
  uses all 26 years; only geographic breakouts are restricted, to 7,705,769
  incidents.
- **2026 is a partial year.** It is excluded from every annual chart and all
  year-over-year comparisons; "latest" always means 2025, the last full year.
  Monthly charts include it, which is why their final point drops.
- **Part I membership comes from `fbi_code`, not the offence name**, because the
  codes separate aggravated assault and battery (`04A`/`04B`, Part I) from
  simple (`08A`/`08B`, not).
- **The police-initiated classification is declared up front** in
  `sql/01_load.sql`, not derived from arrest rates — defining the groups by
  arrest rate and then reporting their arrest rates would be circular.
- **Per-capita rates use the 2023 ACS population held constant** across all
  years, so they measure incidents per present-day resident rather than a true
  time-varying rate. Areas whose population changed materially since 2002 are
  measured against the wrong base, and this data cannot fix that.
- **Unmatched location descriptions fall to "other"**, which is plotted rather
  than hidden, because the folding rule is a judgement and its size should be
  visible.
- **The most important limitation is in the source, not the cleaning.** These
  are incidents reported to or observed by police and recorded. Changes in
  willingness to report, and in what officers record, move these series exactly
  as changes in crime do.

## Design

The look is a print atlas: warm paper, hairline rules, a transitional serif for
prose and a monospace for every figure. The site commits to a single light
palette deliberately — a paper ground is the concept, and an inverted dark mode
would read as a different document.

Every colour was chosen by running candidates through a palette validator rather
than by eye, and `css/PALETTE.md` records the scores. The notable consequence:
only three of the eight categorical hues clear the all-pairs colourblindness
gate, so scatter plots, the choropleth and the small-multiples grid cap at three
colour-coded series. That is why the 36-panel offence grid draws every panel in
one hue and lets the headings carry identity.

Charts carry a legend whenever there are two or more series, keyboard
navigation that mirrors hover, and an automatically generated table twin, so no
value is reachable only by pointing at a mark.

## Author

Mattox Knod · Financial Data Analytics · Data Website Project
