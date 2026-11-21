-- 03_cubes.sql --------------------------------------------------------------
-- Builds the dashboard's data. Run after 01_load.sql:
--
--   duckdb data/derived/crimes.duckdb -c ".read sql/03_cubes.sql"
--
-- Why a cube at all: the dashboard has to filter and re-aggregate 8.7 million
-- incidents in the browser, and shipping 8.7 million rows is not an option. So
-- the browser gets pre-grouped counts instead and sums them. Every number the
-- dashboard shows is a sum over one of these cubes, and the cubes come from the
-- same `crimes` table the report's findings come from, so the two pages cannot
-- disagree.
--
-- The cost of a cube is that a dimension not in it cannot be filtered or
-- broken out. The dimensions below were chosen to cover the filters the
-- dashboard actually exposes, at the finest time resolution that keeps the
-- file small enough to fetch. 04_verify.sql re-derives the report's headline
-- numbers from these cubes as an independent check that they agree.
-- ---------------------------------------------------------------------------

-- Offence groups. Full detail is 36 types, which multiplies the main cube past
-- what is worth downloading, so types fold into these groups. The grouping is
-- reported on the dashboard and in the README. Part I index offences are kept
-- separable within their groups by the is_part1 flag carried on each row.
CREATE OR REPLACE TABLE type_groups AS
SELECT * FROM (VALUES
    ('HOMICIDE',                          'Homicide'),
    ('CRIM SEXUAL ASSAULT',               'Sexual assault and offences'),
    ('SEX OFFENSE',                       'Sexual assault and offences'),
    ('PROSTITUTION',                      'Sexual assault and offences'),
    ('OBSCENITY',                         'Sexual assault and offences'),
    ('PUBLIC INDECENCY',                  'Sexual assault and offences'),
    ('HUMAN TRAFFICKING',                 'Sexual assault and offences'),
    ('ROBBERY',                           'Robbery'),
    ('BATTERY',                           'Assault and battery'),
    ('ASSAULT',                           'Assault and battery'),
    ('INTIMIDATION',                      'Assault and battery'),
    ('STALKING',                          'Assault and battery'),
    ('KIDNAPPING',                        'Assault and battery'),
    ('OFFENSE INVOLVING CHILDREN',        'Offences involving children'),
    ('BURGLARY',                          'Burglary'),
    ('THEFT',                             'Theft'),
    ('MOTOR VEHICLE THEFT',               'Motor vehicle theft'),
    ('ARSON',                             'Arson and criminal damage'),
    ('CRIMINAL DAMAGE',                   'Arson and criminal damage'),
    ('DECEPTIVE PRACTICE',                'Fraud and deceptive practice'),
    ('NARCOTICS',                         'Narcotics'),
    ('OTHER NARCOTIC VIOLATION',          'Narcotics'),
    ('WEAPONS VIOLATION',                 'Weapons'),
    ('CONCEALED CARRY LICENSE VIOLATION', 'Weapons'),
    ('CRIMINAL TRESPASS',                 'Trespass and public order'),
    ('PUBLIC PEACE VIOLATION',            'Trespass and public order'),
    ('INTERFERENCE WITH PUBLIC OFFICER',  'Trespass and public order'),
    ('LIQUOR LAW VIOLATION',              'Trespass and public order'),
    ('GAMBLING',                          'Trespass and public order')
) AS t(primary_type, type_group);

-- Anything not listed above (legacy and residual labels: OTHER OFFENSE,
-- NON-CRIMINAL, RITUALISM, DOMESTIC VIOLENCE and the like) falls to "Other",
-- which is shown in the dashboard rather than silently dropped.
CREATE OR REPLACE VIEW v_grouped AS
SELECT c.*, coalesce(g.type_group, 'Other') AS type_group
FROM crimes c
LEFT JOIN type_groups g USING (primary_type);

-- Cube A: the dashboard's main source ---------------------------------------
-- year x month x community area x offence group x arrest x domestic.
-- Supports the time, geography, offence, arrest and domestic filters, and any
-- breakdown over those dimensions, with exact counts for every combination.
-- Restricted to geocoded rows in years whose coverage clears the threshold in
-- 01_load.sql, which in this extract means 2003 onward: 2001 is 1.3% geocoded
-- and 2002 is 72.8%, and a quarter-unmapped year would read on the map as a
-- real shortfall rather than as missing data.

CREATE OR REPLACE TABLE cube_main AS
SELECT yr, mo, ca, type_group, arrest, domestic,
       count(*)                        AS n,
       count(*) FILTER (WHERE is_part1) AS n_part1
FROM v_grouped
WHERE geo_ok AND yr IN (SELECT yr FROM geo_years)
GROUP BY ALL;

-- Cube B: the clock ---------------------------------------------------------
-- year x hour x weekday x offence group. Hour and weekday would multiply cube
-- A past a sensible download, so they live here. Citywide, all years.

CREATE OR REPLACE TABLE cube_clock AS
SELECT yr, hr, dow, type_group, count(*) AS n, count(*) FILTER (WHERE arrest) AS n_arrest
FROM v_grouped
GROUP BY ALL;

-- Cube C: citywide monthly totals ------------------------------------------
-- Every row, including the ungeocoded ones cube A drops. Not loaded by the
-- dashboard; it exists so 04_verify.sql can check totals against the full
-- incident count.

CREATE OR REPLACE TABLE cube_citywide AS
SELECT yr, mo, type_group, arrest, domestic, count(*) AS n
FROM v_grouped
GROUP BY ALL;

-- Size report ---------------------------------------------------------------
-- Printed so the cube design is chosen against measured rows, not a guess.

SELECT 'cube_main'     AS cube, count(*) AS rows, count(DISTINCT ca) AS cas,
       count(DISTINCT type_group) AS groups, min(yr) AS first_year, max(yr) AS last_year
FROM cube_main
UNION ALL
SELECT 'cube_clock', count(*), NULL, count(DISTINCT type_group), min(yr), max(yr) FROM cube_clock
UNION ALL
SELECT 'cube_citywide', count(*), NULL, count(DISTINCT type_group), min(yr), max(yr) FROM cube_citywide;

-- Integrity: a cube must reproduce the row counts it was built from ---------

CREATE OR REPLACE TEMP MACRO must(cond, label) AS
    CASE WHEN cond THEN 'ok: ' || label
         ELSE error('ASSERTION FAILED: ' || label) END;

SELECT must((SELECT sum(n) FROM cube_main)
            = (SELECT count(*) FROM crimes
               WHERE geo_ok AND yr IN (SELECT yr FROM geo_years)),
            'cube_main totals equal the geocoded incidents in usable years') AS check_1,
       must((SELECT sum(n) FROM cube_clock) = (SELECT count(*) FROM crimes),
            'cube_clock totals equal every incident')                        AS check_2,
       must((SELECT sum(n) FROM cube_citywide) = (SELECT count(*) FROM crimes),
            'cube_citywide totals equal every incident')                     AS check_3,
       must((SELECT sum(n_part1) FROM cube_main)
            = (SELECT count(*) FROM crimes
               WHERE geo_ok AND yr IN (SELECT yr FROM geo_years) AND is_part1),
            'cube_main Part I totals agree')                                 AS check_4;

-- Export --------------------------------------------------------------------
-- CSV rather than JSON: at these row counts the repeated key names in JSON
-- cost several times the payload, and GitHub Pages serves CSV gzipped.
-- Booleans export as integers to keep the files narrow.
--
-- The offence group is exported as a small integer rather than its name. The
-- names average about twenty characters and repeat once per row, which was
-- more than half the uncompressed size of cube_main on its own; the dashboard
-- resolves them through type_lookup.csv, which it needs to build the filter
-- list anyway.

CREATE OR REPLACE TABLE type_lookup AS
SELECT row_number() OVER (ORDER BY type_group) - 1 AS t, type_group
FROM (SELECT DISTINCT type_group FROM v_grouped);

COPY (
    SELECT t, type_group AS name FROM type_lookup ORDER BY t
) TO 'data/derived/type_lookup.csv' (FORMAT CSV, HEADER true);

COPY (
    SELECT c.yr AS y, c.mo AS m, c.ca, l.t,
           c.arrest::INT AS a, c.domestic::INT AS d, c.n, c.n_part1 AS p
    FROM cube_main c JOIN type_lookup l USING (type_group)
    ORDER BY c.yr, c.mo, c.ca
) TO 'data/derived/cube_main.csv' (FORMAT CSV, HEADER true);

COPY (
    SELECT c.yr AS y, c.hr AS h, c.dow AS w, l.t, c.n, c.n_arrest AS a
    FROM cube_clock c JOIN type_lookup l USING (type_group)
    ORDER BY c.yr, c.hr, c.dow
) TO 'data/derived/cube_clock.csv' (FORMAT CSV, HEADER true);

COPY (
    SELECT yr AS y, mo AS m, type_group AS t, arrest::INT AS a, domestic::INT AS d, n
    FROM cube_citywide ORDER BY yr, mo
) TO 'data/derived/cube_citywide.csv' (FORMAT CSV, HEADER true);

-- The lookup tables the dashboard needs alongside the cubes.
COPY (
    SELECT ca, ca_name AS name, population, per_capita_income, hardship_index
    FROM community_areas ORDER BY ca
) TO 'data/derived/ca_lookup.csv' (FORMAT CSV, HEADER true);

COPY (
    SELECT type_group, string_agg(primary_type, '; ' ORDER BY primary_type) AS offences
    FROM (SELECT coalesce(g.type_group, 'Other') AS type_group, c.primary_type
          FROM (SELECT DISTINCT primary_type FROM crimes) c
          LEFT JOIN type_groups g USING (primary_type))
    GROUP BY 1 ORDER BY 1
) TO 'data/derived/type_group_map.json' (FORMAT JSON, ARRAY true);
