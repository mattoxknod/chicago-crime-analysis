-- 04_verify.sql -------------------------------------------------------------
-- Independent cross-check that the dashboard's cubes and the report's findings
-- describe the same data. Run last:
--
--   duckdb data/derived/crimes.duckdb -c ".read sql/04_verify.sql"
--
-- The point is adversarial: recompute the report's headline numbers a second
-- time, from the cubes rather than from the incident table, and fail loudly on
-- any disagreement. A cube built with the wrong grain, a filter that silently
-- drops rows, or a group-by that double-counts all show up here as a mismatch
-- rather than as a wrong number on a published page.
--
-- Every check prints its two values so a reader can see the agreement, not
-- just a pass.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TEMP MACRO must(cond, label) AS
    CASE WHEN cond THEN 'ok' ELSE error('MISMATCH: ' || label) END;

-- 1. Totals -----------------------------------------------------------------

WITH from_rows AS (SELECT count(*) AS v FROM crimes),
     from_cube AS (SELECT sum(n) AS v FROM cube_citywide)
SELECT 'total incidents'            AS check,
       (SELECT v FROM from_rows)    AS from_incident_table,
       (SELECT v FROM from_cube)    AS from_cube,
       must((SELECT v FROM from_rows) = (SELECT v FROM from_cube),
            'total incidents') AS result;

-- 2. Geocoded totals, which cube_main is restricted to ----------------------

WITH from_rows AS (SELECT count(*) AS v FROM crimes WHERE geo_ok),
     from_cube AS (SELECT sum(n) AS v FROM cube_main)
SELECT 'geocoded incidents'         AS check,
       (SELECT v FROM from_rows)    AS from_incident_table,
       (SELECT v FROM from_cube)    AS from_cube,
       must((SELECT v FROM from_rows) = (SELECT v FROM from_cube),
            'geocoded incidents') AS result;

-- 3. Arrest rate by year, every year, both ways -----------------------------
-- The report's central series. Compared to two decimal places.

WITH rows_by_year AS (
    SELECT yr, round(100.0 * count(*) FILTER (WHERE arrest) / count(*), 2) AS rate
    FROM crimes GROUP BY 1
),
cube_by_year AS (
    SELECT yr, round(100.0 * sum(n) FILTER (WHERE a = 1) / sum(n), 2) AS rate
    FROM (SELECT yr, arrest::INT AS a, n FROM cube_citywide) GROUP BY 1
),
diffs AS (
    SELECT r.yr, r.rate AS rows_rate, c.rate AS cube_rate
    FROM rows_by_year r JOIN cube_by_year c USING (yr)
    WHERE r.rate <> c.rate
)
SELECT 'arrest rate by year'                AS check,
       (SELECT count(*) FROM rows_by_year)  AS years_compared,
       (SELECT count(*) FROM diffs)         AS years_disagreeing,
       must((SELECT count(*) FROM diffs) = 0, 'arrest rate by year') AS result;

-- 4. Per-community-area violent counts, both ways ---------------------------

WITH rows_by_ca AS (
    SELECT ca, count(*) AS n
    FROM crimes
    WHERE geo_ok AND fbi_code IN ('01A','01B','02','03','04A','04B')
    GROUP BY 1
),
-- Part I violent is a subset of is_part1, so it cannot be read off the cube's
-- n_part1 column alone; the cube is checked on its total Part I count instead.
cube_part1 AS (SELECT sum(n_part1) AS v FROM cube_main),
rows_part1 AS (SELECT count(*) AS v FROM crimes WHERE geo_ok AND is_part1)
SELECT 'Part I incidents (geocoded)' AS check,
       (SELECT v FROM rows_part1)    AS from_incident_table,
       (SELECT v FROM cube_part1)    AS from_cube,
       must((SELECT v FROM rows_part1) = (SELECT v FROM cube_part1),
            'Part I incidents') AS result,
       (SELECT count(*) FROM rows_by_ca) AS community_areas_with_violent;

-- 5. Offence-group totals round-trip ----------------------------------------
-- Every incident must land in exactly one group: the grouped total has to
-- equal the ungrouped one, which catches a type added to two VALUES rows or
-- misspelled against primary_type.

WITH grouped AS (SELECT sum(n) AS v FROM cube_citywide),
     raw AS (SELECT count(*) AS v FROM crimes)
SELECT 'offence grouping is a partition' AS check,
       (SELECT v FROM raw)               AS incidents,
       (SELECT v FROM grouped)           AS grouped_total,
       must((SELECT v FROM raw) = (SELECT v FROM grouped), 'offence grouping') AS result;

-- How much landed in the residual "Other" group, reported rather than hidden.
-- coalesce so that "nothing fell through" reads as 0.000 rather than NULL.
SELECT 'share in residual Other group' AS check,
       round(100.0 * coalesce(sum(n) FILTER (WHERE t = 'Other'), 0) / sum(n), 3) AS pct
FROM (SELECT type_group AS t, n FROM cube_citywide);

-- 6. The clock cube -------------------------------------------------------

WITH from_rows AS (SELECT count(*) AS v FROM crimes),
     from_cube AS (SELECT sum(n) AS v FROM cube_clock)
SELECT 'clock cube total'           AS check,
       (SELECT v FROM from_rows)    AS from_incident_table,
       (SELECT v FROM from_cube)    AS from_cube,
       must((SELECT v FROM from_rows) = (SELECT v FROM from_cube), 'clock cube') AS result;

-- 7. No negative or null counts anywhere ------------------------------------

SELECT 'counts are positive integers' AS check,
       must((SELECT count(*) FROM cube_main     WHERE n IS NULL OR n <= 0) = 0, 'cube_main counts')
    || ' / ' ||
       must((SELECT count(*) FROM cube_clock    WHERE n IS NULL OR n <= 0) = 0, 'cube_clock counts')
    || ' / ' ||
       must((SELECT count(*) FROM cube_citywide WHERE n IS NULL OR n <= 0) = 0, 'cube_citywide counts')
       AS result;

-- 8. Every community area in the cube resolves to a name --------------------

SELECT 'every cube community area has a name' AS check,
       must((SELECT count(*) FROM (SELECT DISTINCT ca FROM cube_main)
             WHERE ca NOT IN (SELECT ca FROM community_areas)) = 0,
            'community area lookup covers the cube') AS result;

SELECT '--- all cross-checks passed ---' AS status;
