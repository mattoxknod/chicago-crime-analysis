-- 01_load.sql ----------------------------------------------------------------
-- Builds the working database from the raw downloads.
--
--   duckdb data/derived/crimes.duckdb -c ".read sql/01_load.sql"
--
-- Every cleaning decision here is reported in the methodology section of
-- index.html. Nothing downstream re-cleans the data: 02_findings.sql and
-- 03_cubes.sql both read the tables this file creates, which is what keeps the
-- report page and the dashboard from disagreeing.
-- ---------------------------------------------------------------------------

-- 1. Raw incidents -----------------------------------------------------------
-- The chunk files overlap by construction only if a row was edited mid-
-- download and shifted Socrata's pagination, so we deduplicate on id. id is
-- the city's own stable incident number; ":id" is Socrata's internal row key
-- and is dropped after load.

CREATE OR REPLACE TABLE crimes_raw AS
SELECT * FROM read_csv_auto('data/raw/crimes_chunks/crimes_*.csv', sample_size = -1, union_by_name = true);

-- 2. Cleaned incidents -------------------------------------------------------

CREATE OR REPLACE TABLE crimes AS
WITH deduped AS (
    SELECT *, row_number() OVER (PARTITION BY id ORDER BY updated_on DESC) AS rn
    FROM crimes_raw
)
SELECT
    id,
    date,
    date_trunc('month', date)                      AS month_start,
    date_part('year',    date)::SMALLINT            AS yr,
    date_part('month',   date)::TINYINT             AS mo,
    date_part('hour',    date)::TINYINT             AS hr,
    -- DuckDB's isodow: 1 = Monday ... 7 = Sunday.
    date_part('isodow',  date)::TINYINT             AS dow,

    -- The city relabelled this offense partway through the series. Left
    -- unmerged it reads as one category ending and another beginning.
    CASE primary_type
        WHEN 'CRIMINAL SEXUAL ASSAULT' THEN 'CRIM SEXUAL ASSAULT'
        ELSE primary_type
    END                                             AS primary_type,

    description,
    location_description,
    arrest,
    domestic,
    beat,
    district,
    ward,
    community_area                                  AS ca,
    fbi_code,
    iucr,
    latitude,
    longitude,
    updated_on,

    -- FBI Uniform Crime Reporting Part I ("index") offenses: homicide,
    -- criminal sexual assault, robbery, aggravated assault, aggravated
    -- battery, burglary, larceny-theft, motor vehicle theft, arson. This is an
    -- external, published definition rather than one we invented, which is why
    -- the report leans on it for the clearance-rate argument. Note that it
    -- splits BATTERY and ASSAULT by severity: 04A/04B are Part I, 08A/08B are
    -- not, so fbi_code and not primary_type is the correct key.
    (fbi_code IN ('01A','01B','02','03','04A','04B','05','06','07','09'))
                                                    AS is_part1,

    -- Whether an offense normally reaches the record through a victim's report
    -- or through an officer's own action. This classification is ours, stated
    -- up front rather than derived from the arrest rate, because defining it
    -- by arrest rate and then reporting arrest rates by class would be
    -- circular. The rule: consensual, victimless, status and possession
    -- offenses are police-initiated; offenses with a complaining victim are
    -- citizen-reported.
    CASE
        WHEN primary_type IN (
            'NARCOTICS', 'OTHER NARCOTIC VIOLATION', 'PROSTITUTION',
            'GAMBLING', 'LIQUOR LAW VIOLATION', 'PUBLIC INDECENCY',
            'OBSCENITY', 'CONCEALED CARRY LICENSE VIOLATION',
            'INTERFERENCE WITH PUBLIC OFFICER', 'WEAPONS VIOLATION',
            'CRIMINAL TRESPASS', 'PUBLIC PEACE VIOLATION'
        ) THEN 'police-initiated'
        ELSE 'citizen-reported'
    END                                             AS discovery,

    -- Geographic coding is absent for essentially all of 2001 (99.4% of that
    -- year has no community area and 99.8% has no ward, against 0.0% in every
    -- later year). Rather than drop those rows outright, we flag them: the
    -- citywide time series uses all years, and anything broken out by
    -- community area or ward filters on geo_ok and therefore starts in 2002.
    (ca IS NOT NULL AND ca BETWEEN 1 AND 77)        AS geo_ok
FROM deduped
WHERE rn = 1;

-- 3. Community areas ---------------------------------------------------------
-- Boundaries carry the area number and an upper-case name; the ACS table
-- carries the same upper-case name; the socioeconomic table carries the area
-- number and a title-case name. So: ACS joins by name, socioeconomic joins by
-- number. Joining socioeconomic by name silently matches nothing.

CREATE OR REPLACE TABLE community_areas AS
WITH geo AS (
    SELECT f.properties.area_numbe::SMALLINT AS ca,
           f.properties.community            AS ca_name
    FROM (
        SELECT unnest(features) AS f
        FROM read_json('data/raw/community_areas.geojson', maximum_object_size = 20000000)
    )
),
acs AS (
    SELECT community_area AS ca_name, total_population::INT AS population
    FROM read_csv_auto('data/raw/acs_community_area.csv')
),
se AS (
    -- Row 78 is a citywide CHICAGO aggregate with a null ca; excluding it is
    -- what keeps this table at 77 rows.
    SELECT ca::SMALLINT                 AS ca,
           per_capita_income_::INT       AS per_capita_income,
           hardship_index::INT           AS hardship_index,
           percent_households_below_poverty::DOUBLE AS pct_below_poverty
    FROM read_csv_auto('data/raw/socioeconomic.csv')
    WHERE ca IS NOT NULL
)
SELECT geo.ca, geo.ca_name, acs.population,
       se.per_capita_income, se.hardship_index, se.pct_below_poverty
FROM geo
JOIN acs ON acs.ca_name = geo.ca_name
LEFT JOIN se ON se.ca = geo.ca
ORDER BY geo.ca;

-- 4. Assertions --------------------------------------------------------------
-- These fail the build loudly rather than letting a wrong number reach a page.

CREATE OR REPLACE TEMP MACRO must(cond, label) AS
    CASE WHEN cond THEN 'ok: ' || label
         ELSE error('ASSERTION FAILED: ' || label) END;

SELECT must((SELECT count(*) FROM community_areas) = 77,
            '77 community areas after joining boundaries, ACS and socioeconomic') AS check_1,
       must((SELECT count(*) FROM community_areas WHERE population IS NULL) = 0,
            'every community area has an ACS population')                         AS check_2,
       must((SELECT count(*) FROM crimes) = (SELECT count(DISTINCT id) FROM crimes),
            'one row per incident id after dedupe')                               AS check_3,
       must((SELECT count(*) FROM crimes WHERE geo_ok AND yr >= 2002) > 0,
            'geographically coded incidents exist from 2002')                     AS check_4;

-- 5. Load summary ------------------------------------------------------------

SELECT 'rows in chunks'      AS metric, count(*)::VARCHAR AS value FROM crimes_raw
UNION ALL SELECT 'rows after dedupe',   count(*)::VARCHAR FROM crimes
UNION ALL SELECT 'duplicates removed',  (SELECT count(*) FROM crimes_raw) - (SELECT count(*) FROM crimes)
UNION ALL SELECT 'date range',          min(date)::VARCHAR || ' to ' || max(date)::VARCHAR FROM crimes
UNION ALL SELECT 'distinct years',      count(DISTINCT yr)::VARCHAR FROM crimes
UNION ALL SELECT 'distinct months',     count(DISTINCT month_start)::VARCHAR FROM crimes
UNION ALL SELECT 'distinct offenses',   count(DISTINCT primary_type)::VARCHAR FROM crimes
UNION ALL SELECT 'geo-coded share',     round(100.0 * count(*) FILTER (WHERE geo_ok) / count(*), 2)::VARCHAR || '%' FROM crimes
UNION ALL SELECT 'Part I share',        round(100.0 * count(*) FILTER (WHERE is_part1) / count(*), 2)::VARCHAR || '%' FROM crimes
UNION ALL SELECT 'police-initiated share', round(100.0 * count(*) FILTER (WHERE discovery = 'police-initiated') / count(*), 2)::VARCHAR || '%' FROM crimes;
