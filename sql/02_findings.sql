-- 02_findings.sql -----------------------------------------------------------
-- Computes every number the report page quotes and writes it to
-- data/derived/ as JSON. Run after 01_load.sql:
--
--   duckdb data/derived/crimes.duckdb -c ".read sql/02_findings.sql"
--
-- The report page reads these files and nothing else, so no number on the page
-- is typed by hand. 03_cubes.sql builds the dashboard's data from the same
-- `crimes` table, which is what keeps the two pages in agreement.
--
-- Conventions used throughout:
--   * "Part I" means an FBI index offence, by fbi_code (see 01_load.sql).
--     Violent Part I = 01A, 01B, 02, 03, 04A, 04B. Property Part I = 05, 06,
--     07, 09.
--   * Anything broken out by community area is restricted to geocoded rows in
--     years whose coverage clears the threshold in 01_load.sql -- 2003 onward
--     here, since 2001 is 1.3% geocoded and 2002 only 72.8%.
--   * 2026 is a partial year (the extract ends mid-November), so it is
--     excluded from year-over-year comparisons and flagged everywhere it
--     appears. The "latest full year" is 2025.
-- ---------------------------------------------------------------------------

-- Reusable definitions ------------------------------------------------------

CREATE OR REPLACE VIEW v_crimes AS
SELECT *,
       fbi_code IN ('01A','01B','02','03','04A','04B') AS is_violent_p1,
       fbi_code IN ('05','06','07','09')               AS is_property_p1
FROM crimes;

CREATE OR REPLACE VIEW v_years AS
SELECT min(yr) AS first_year,
       max(yr) AS last_year,
       max(yr) FILTER (WHERE yr < (SELECT max(yr) FROM crimes)) AS last_full_year
FROM crimes;

-- 1. Headline figures -------------------------------------------------------

COPY (
    WITH b AS (SELECT * FROM v_years),
    peak AS (
        SELECT yr, count(*) AS n FROM crimes GROUP BY 1 ORDER BY n DESC LIMIT 1
    ),
    trough AS (
        SELECT yr, count(*) AS n FROM crimes
        WHERE yr < (SELECT last_year FROM b)
        GROUP BY 1 ORDER BY n ASC LIMIT 1
    ),
    latest AS (
        SELECT count(*) AS n FROM crimes WHERE yr = (SELECT last_full_year FROM b)
    ),
    rates AS (
        SELECT
            round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 1) AS arrest_pct_all_time,
            round(100.0 * count(*) FILTER (WHERE arrest AND yr = (SELECT last_full_year FROM b))
                  / nullif(count(*) FILTER (WHERE yr = (SELECT last_full_year FROM b)), 0), 1)
                                                                        AS arrest_pct_latest
        FROM crimes
    )
    SELECT
        (SELECT count(*) FROM crimes)                      AS total_incidents,
        (SELECT count(DISTINCT yr) FROM crimes)            AS years_covered,
        (SELECT count(DISTINCT month_start) FROM crimes)   AS months_covered,
        (SELECT first_year FROM b)                         AS first_year,
        (SELECT last_year FROM b)                          AS last_year,
        (SELECT last_full_year FROM b)                     AS last_full_year,
        (SELECT yr FROM peak)                              AS peak_year,
        (SELECT n  FROM peak)                              AS peak_incidents,
        (SELECT yr FROM trough)                            AS trough_year,
        (SELECT n  FROM trough)                            AS trough_incidents,
        (SELECT n  FROM latest)                            AS latest_incidents,
        round(100.0 * ((SELECT n FROM trough) - (SELECT n FROM peak)) / (SELECT n FROM peak), 1)
                                                           AS pct_change_peak_to_trough,
        round(100.0 * ((SELECT n FROM latest) - (SELECT n FROM trough)) / (SELECT n FROM trough), 1)
                                                           AS pct_rebound_trough_to_latest,
        (SELECT arrest_pct_all_time FROM rates)            AS arrest_pct_all_time,
        (SELECT arrest_pct_latest FROM rates)              AS arrest_pct_latest,
        (SELECT count(*) FROM community_areas)             AS community_areas,
        (SELECT sum(population) FROM community_areas)      AS acs_population
) TO 'data/derived/headline.json' (FORMAT JSON, ARRAY true);

-- 2. Annual series ----------------------------------------------------------
-- The spine of the report: incidents, arrests, and Part I clearance by year.

COPY (
    SELECT
        yr                                                              AS year,
        count(*)                                                        AS incidents,
        count(*) FILTER (WHERE arrest)                                  AS arrests,
        round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 2)     AS arrest_rate,
        count(*) FILTER (WHERE is_part1)                                AS part1,
        round(100.0 * count(*) FILTER (WHERE is_part1 AND arrest)
              / nullif(count(*) FILTER (WHERE is_part1), 0), 2)         AS part1_clearance,
        count(*) FILTER (WHERE is_violent_p1)                           AS violent_p1,
        round(100.0 * count(*) FILTER (WHERE is_violent_p1 AND arrest)
              / nullif(count(*) FILTER (WHERE is_violent_p1), 0), 2)    AS violent_clearance,
        count(*) FILTER (WHERE is_property_p1)                          AS property_p1,
        round(100.0 * count(*) FILTER (WHERE is_property_p1 AND arrest)
              / nullif(count(*) FILTER (WHERE is_property_p1), 0), 2)   AS property_clearance,
        count(*) FILTER (WHERE domestic)                                AS domestic,
        round(100.0 * count(*) FILTER (WHERE domestic) / count(*), 2)   AS domestic_share,
        (yr = (SELECT max(yr) FROM crimes))                             AS partial_year
    FROM v_crimes
    GROUP BY 1 ORDER BY 1
) TO 'data/derived/annual.json' (FORMAT JSON, ARRAY true);

-- 3. The decomposition ------------------------------------------------------
-- Splitting the citywide arrest rate by how an offence reaches the record.
-- Police-initiated offences are arrests by construction, so their volume
-- moves the citywide rate without any change in clearance. This is the
-- central argument of the report.

COPY (
    SELECT
        yr                                                                      AS year,
        count(*) FILTER (WHERE discovery = 'police-initiated')                  AS police_initiated,
        count(*) FILTER (WHERE discovery = 'citizen-reported')                  AS citizen_reported,
        round(100.0 * count(*) FILTER (WHERE discovery = 'police-initiated')
              / count(*), 2)                                                    AS police_initiated_share,
        round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 2)             AS arrest_rate_all,
        round(100.0 * count(*) FILTER (WHERE arrest AND discovery = 'police-initiated')
              / nullif(count(*) FILTER (WHERE discovery = 'police-initiated'), 0), 2)
                                                                                AS arrest_rate_police_initiated,
        round(100.0 * count(*) FILTER (WHERE arrest AND discovery = 'citizen-reported')
              / nullif(count(*) FILTER (WHERE discovery = 'citizen-reported'), 0), 2)
                                                                                AS arrest_rate_citizen_reported,
        count(*) FILTER (WHERE primary_type = 'NARCOTICS')                      AS narcotics,
        round(100.0 * count(*) FILTER (WHERE arrest AND primary_type <> 'NARCOTICS')
              / nullif(count(*) FILTER (WHERE primary_type <> 'NARCOTICS'), 0), 2)
                                                                                AS arrest_rate_ex_narcotics
    FROM crimes
    GROUP BY 1 ORDER BY 1
) TO 'data/derived/decomposition.json' (FORMAT JSON, ARRAY true);

-- A counterfactual: hold each year's offence mix at the first year's mix and
-- apply that year's within-class arrest rates. The gap between this and the
-- actual rate is the part of the decline that is mix rather than behaviour.
COPY (
    WITH base_mix AS (
        SELECT discovery, count(*) * 1.0 / sum(count(*)) OVER () AS w
        FROM crimes WHERE yr = (SELECT min(yr) FROM crimes)
        GROUP BY 1
    ),
    by_year AS (
        SELECT yr, discovery,
               count(*) AS n,
               count(*) FILTER (WHERE arrest) * 1.0 / count(*) AS rate
        FROM crimes GROUP BY 1, 2
    )
    SELECT b.yr                                                     AS year,
           round(100.0 * sum(b.rate * m.w), 2)                      AS arrest_rate_mix_held_constant,
           round(100.0 * sum(b.n * b.rate) / sum(b.n), 2)           AS arrest_rate_actual
    FROM by_year b JOIN base_mix m USING (discovery)
    GROUP BY 1 ORDER BY 1
) TO 'data/derived/counterfactual.json' (FORMAT JSON, ARRAY true);

-- 4. Offence types ----------------------------------------------------------
-- Every type by year, for the small-multiples grid and the indexed chart.

COPY (
    SELECT primary_type AS type, yr AS year, count(*) AS incidents,
           round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 2) AS arrest_rate
    FROM crimes GROUP BY 1, 2 ORDER BY 1, 2
) TO 'data/derived/type_year.json' (FORMAT JSON, ARRAY true);

-- Type totals with first/last full-year change, to sort the grid by trend.
COPY (
    WITH b AS (SELECT * FROM v_years),
    t AS (
        SELECT primary_type AS type,
               count(*) AS total,
               count(*) FILTER (WHERE yr = (SELECT first_year FROM b))     AS first_year_n,
               count(*) FILTER (WHERE yr = (SELECT last_full_year FROM b)) AS last_year_n,
               round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 2) AS arrest_rate,
               any_value(discovery)                                        AS discovery
        FROM crimes GROUP BY 1
    )
    SELECT *,
           CASE WHEN first_year_n > 0
                THEN round(100.0 * (last_year_n - first_year_n) / first_year_n, 1) END AS pct_change
    FROM t ORDER BY total DESC
) TO 'data/derived/type_totals.json' (FORMAT JSON, ARRAY true);

-- 5. Motor vehicle theft, monthly ------------------------------------------
-- The 2022 shock. Monthly resolution is the point: an annual series hides the
-- discontinuity inside two calendar years.

COPY (
    SELECT month_start::DATE AS month, count(*) AS incidents,
           round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 2) AS arrest_rate
    FROM crimes WHERE primary_type = 'MOTOR VEHICLE THEFT'
    GROUP BY 1 ORDER BY 1
) TO 'data/derived/mvt_monthly.json' (FORMAT JSON, ARRAY true);

-- 6. Seasonality ------------------------------------------------------------
-- Each month's deviation from its own year's monthly mean, averaged over
-- years. Expressing it as a deviation is what removes the long-run decline
-- from a month-of-year profile; a raw month average would mostly show that
-- early years had more crime.

COPY (
    WITH per AS (
        SELECT yr, mo,
               count(*) FILTER (WHERE is_violent_p1)  AS violent,
               count(*) FILTER (WHERE is_property_p1) AS property,
               count(*)                               AS total
        FROM v_crimes
        -- Whole years only, so a partial year cannot tilt a month's mean.
        WHERE yr < (SELECT max(yr) FROM crimes)
        GROUP BY 1, 2
    ),
    means AS (
        SELECT yr, avg(violent) AS mv, avg(property) AS mp, avg(total) AS mt
        FROM per GROUP BY 1
    )
    SELECT p.mo AS month,
           round(avg(100.0 * (p.violent  - m.mv) / m.mv), 2) AS violent_vs_mean,
           round(avg(100.0 * (p.property - m.mp) / m.mp), 2) AS property_vs_mean,
           round(avg(100.0 * (p.total    - m.mt) / m.mt), 2) AS total_vs_mean
    FROM per p JOIN means m USING (yr)
    GROUP BY 1 ORDER BY 1
) TO 'data/derived/seasonality.json' (FORMAT JSON, ARRAY true);

-- 7. Hour-of-day fingerprints ----------------------------------------------
-- Share of each offence type's own incidents falling in each hour, so types
-- of wildly different volume can be compared in one heatmap.

COPY (
    WITH t AS (
        SELECT primary_type, hr, count(*) AS n
        FROM crimes
        WHERE primary_type IN (
            SELECT primary_type FROM crimes GROUP BY 1 ORDER BY count(*) DESC LIMIT 12
        )
        GROUP BY 1, 2
    )
    SELECT primary_type AS type, hr AS hour, n AS incidents,
           round(100.0 * n / sum(n) OVER (PARTITION BY primary_type), 3) AS pct_of_type
    FROM t ORDER BY 1, 2
) TO 'data/derived/clock.json' (FORMAT JSON, ARRAY true);

-- 8. Geographic concentration ----------------------------------------------

COPY (
    WITH per_ca AS (
        SELECT ca, count(*) FILTER (WHERE is_violent_p1) AS violent, count(*) AS total
        FROM v_crimes WHERE geo_ok AND yr IN (SELECT yr FROM geo_years) GROUP BY 1
    ),
    ranked AS (
        SELECT ca, violent, total,
               row_number() OVER (ORDER BY violent DESC) AS rk,
               sum(violent) OVER () AS all_violent
        FROM per_ca
    )
    SELECT r.rk AS rank, c.ca_name AS name, r.violent, r.total,
           round(100.0 * sum(r.violent) OVER (ORDER BY r.rk) / r.all_violent, 2) AS cumulative_pct
    FROM ranked r JOIN community_areas c ON c.ca = r.ca
    ORDER BY r.rk
) TO 'data/derived/concentration.json' (FORMAT JSON, ARRAY true);

-- 9. Community area rates ---------------------------------------------------
-- Counts and per-100k rates side by side, with each area's rank on both, which
-- is what makes the count-versus-rate reordering visible.
-- Rate denominator: 2023 ACS 5-year population, held constant across years.
-- It therefore measures incidents per present-day resident, not a true
-- time-varying rate. Stated on the page.

COPY (
    WITH b AS (SELECT * FROM v_years),
    per_ca AS (
        SELECT ca,
               count(*)                                              AS total,
               count(*) FILTER (WHERE is_violent_p1)                  AS violent,
               count(*) FILTER (WHERE is_property_p1)                 AS property,
               count(*) FILTER (WHERE yr = (SELECT last_full_year FROM b)) AS latest_year,
               round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 2) AS arrest_rate
        FROM v_crimes WHERE geo_ok AND yr IN (SELECT yr FROM geo_years) GROUP BY 1
    ),
    joined AS (
        SELECT c.ca, c.ca_name AS name, c.population, c.per_capita_income,
               c.hardship_index, c.pct_below_poverty,
               p.total, p.violent, p.property, p.latest_year, p.arrest_rate,
               round(1.0 * p.violent / c.population * 100000, 1) AS violent_per_100k,
               round(1.0 * p.total   / c.population * 100000, 1) AS total_per_100k,
               round(1.0 * p.latest_year / c.population * 100000, 1) AS latest_per_100k
        FROM community_areas c JOIN per_ca p ON p.ca = c.ca
    )
    SELECT *,
           row_number() OVER (ORDER BY violent DESC)          AS rank_by_count,
           row_number() OVER (ORDER BY violent_per_100k DESC) AS rank_by_rate
    FROM joined ORDER BY violent DESC
) TO 'data/derived/community_areas.json' (FORMAT JSON, ARRAY true);

-- 10. Domestic incidents ----------------------------------------------------

COPY (
    SELECT yr AS year,
           count(*) FILTER (WHERE domestic)                                   AS domestic,
           round(100.0 * count(*) FILTER (WHERE domestic) / count(*), 2)      AS domestic_share,
           round(100.0 * count(*) FILTER (WHERE arrest AND domestic)
                 / nullif(count(*) FILTER (WHERE domestic), 0), 2)            AS arrest_rate_domestic,
           round(100.0 * count(*) FILTER (WHERE arrest AND NOT domestic)
                 / nullif(count(*) FILTER (WHERE NOT domestic), 0), 2)        AS arrest_rate_non_domestic
    FROM crimes GROUP BY 1 ORDER BY 1
) TO 'data/derived/domestic.json' (FORMAT JSON, ARRAY true);

-- Monthly, for the 2020 lockdown window.
COPY (
    SELECT month_start::DATE AS month,
           round(100.0 * count(*) FILTER (WHERE domestic) / count(*), 2) AS domestic_share,
           count(*) AS incidents
    FROM crimes WHERE yr BETWEEN 2018 AND 2022 GROUP BY 1 ORDER BY 1
) TO 'data/derived/domestic_monthly.json' (FORMAT JSON, ARRAY true);

-- 11. Where incidents happen ------------------------------------------------
-- Location text is free-form and long-tailed, so it is folded into a small
-- set of settings. Everything not matched lands in "other", which is reported
-- rather than hidden.

COPY (
    WITH mapped AS (
        SELECT yr,
               CASE
                   WHEN location_description IS NULL THEN 'other'
                   WHEN location_description LIKE '%STREET%'
                     OR location_description LIKE '%SIDEWALK%'
                     OR location_description LIKE '%ALLEY%'          THEN 'street'
                   WHEN location_description LIKE '%APARTMENT%'
                     OR location_description LIKE '%RESIDENCE%'
                     OR location_description LIKE '%HOUSE%'
                     OR location_description LIKE '%PORCH%'
                     OR location_description LIKE '%YARD%'           THEN 'residence'
                   WHEN location_description LIKE '%STORE%'
                     OR location_description LIKE '%RESTAURANT%'
                     OR location_description LIKE '%GROCERY%'
                     OR location_description LIKE '%BAR%'
                     OR location_description LIKE '%TAVERN%'
                     OR location_description LIKE '%COMMERCIAL%'
                     OR location_description LIKE '%BUSINESS%'       THEN 'retail and hospitality'
                   WHEN location_description LIKE '%CTA%'
                     OR location_description LIKE '%TRAIN%'
                     OR location_description LIKE '%PLATFORM%'
                     OR location_description LIKE '%BUS%'
                     OR location_description LIKE '%AIRPORT%'        THEN 'transit'
                   WHEN location_description LIKE '%SCHOOL%'
                     OR location_description LIKE '%UNIVERSITY%'
                     OR location_description LIKE '%COLLEGE%'        THEN 'school'
                   WHEN location_description LIKE '%VEHICLE%'
                     OR location_description LIKE '%AUTO%'
                     OR location_description LIKE '%PARKING%'        THEN 'vehicles and parking'
                   ELSE 'other'
               END AS setting
        FROM crimes
    )
    SELECT yr AS year, setting, count(*) AS incidents,
           round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY yr), 2) AS pct_of_year
    FROM mapped GROUP BY 1, 2 ORDER BY 1, 2
) TO 'data/derived/settings.json' (FORMAT JSON, ARRAY true);

-- 12. Data quality ----------------------------------------------------------
-- Everything the methodology section needs to state plainly.

COPY (
    SELECT
        (SELECT count(*) FROM crimes_raw)                                      AS rows_downloaded,
        (SELECT count(*) FROM crimes)                                          AS rows_after_dedupe,
        (SELECT count(*) FROM crimes_raw) - (SELECT count(*) FROM crimes)      AS duplicates_removed,
        count(*) FILTER (WHERE NOT geo_ok)                                     AS rows_without_community_area,
        round(100.0 * count(*) FILTER (WHERE NOT geo_ok) / count(*), 2)        AS pct_without_community_area,
        count(*) FILTER (WHERE NOT geo_ok AND yr = 2001)                       AS ungeocoded_in_2001,
        count(*) FILTER (WHERE latitude IS NULL)                               AS rows_without_coordinates,
        round(100.0 * count(*) FILTER (WHERE latitude IS NULL) / count(*), 2)  AS pct_without_coordinates,
        count(*) FILTER (WHERE hr = 0 AND date_part('minute', date) = 0)       AS rows_timestamped_midnight,
        round(100.0 * count(*) FILTER (WHERE hr = 0 AND date_part('minute', date) = 0)
              / count(*), 2)                                                   AS pct_timestamped_midnight,
        (SELECT max(date) FROM crimes)                                         AS last_incident,
        (SELECT max(updated_on) FROM crimes)                                   AS last_updated,
        (SELECT count(*) FROM crimes WHERE yr = (SELECT max(yr) FROM crimes))  AS partial_year_rows
    FROM crimes
) TO 'data/derived/quality.json' (FORMAT JSON, ARRAY true);

-- Which years clear the geographic-coverage threshold, so the page can state
-- where its maps actually start rather than asserting a year.
COPY (
    SELECT yr AS year, rows, geocoded, pct_geocoded, usable_for_geography
    FROM geo_coverage ORDER BY yr
) TO 'data/derived/geo_coverage.json' (FORMAT JSON, ARRAY true);

-- Per-year geographic coverage, so the gap is shown, not just asserted.
COPY (
    SELECT yr AS year, count(*) AS incidents,
           round(100.0 * count(*) FILTER (WHERE NOT geo_ok) / count(*), 2) AS pct_missing_community_area,
           round(100.0 * count(*) FILTER (WHERE latitude IS NULL) / count(*), 2) AS pct_missing_coordinates,
           round(100.0 * count(*) FILTER (WHERE hr = 0 AND date_part('minute', date) = 0) / count(*), 2) AS pct_midnight
    FROM crimes GROUP BY 1 ORDER BY 1
) TO 'data/derived/quality_by_year.json' (FORMAT JSON, ARRAY true);

-- Monthly totals, for the completeness check and the dashboard's time axis.
COPY (
    SELECT month_start::DATE AS month, count(*) AS incidents
    FROM crimes GROUP BY 1 ORDER BY 1
) TO 'data/derived/monthly.json' (FORMAT JSON, ARRAY true);

SELECT 'findings written' AS status, count(*) AS tables_in_db FROM duckdb_tables();
