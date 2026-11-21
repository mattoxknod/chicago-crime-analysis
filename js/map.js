/* ===========================================================================
   map.js — the community area map page.
   ---------------------------------------------------------------------------
   A third page beyond what the brief asks for. It exists because the community
   area is the only geography in this data whose boundaries mean the same thing
   across the whole series, and because the count-versus-rate reordering that
   plate eleven argues in the abstract is much easier to believe when you can
   see it move on a map.

   Reads community_areas.json — the same file the report's plates nine through
   twelve read — so nothing here can disagree with the report.
   =========================================================================== */

(async function () {
  "use strict";

  const A = Atlas;
  const D = AtlasData;
  const f = A.fmt;

  D.masthead("map");

  const $ = (sel) => document.querySelector(sel);
  const loading = $("[data-loading]");
  const app = $("[data-app]");

  let areas, geo, typeYear, headline, geoCoverage;
  try {
    const [a, g, ty, h, gc] = await Promise.all([
      D.json("community_areas.json"),
      fetch("data/derived/community_areas.geojson").then((r) => {
        if (!r.ok) throw new Error(`boundaries: HTTP ${r.status}`);
        return r.json();
      }),
      D.json("type_year.json"),
      D.one("headline.json"),
      D.json("geo_coverage.json"),
    ]);
    areas = a;
    geo = g;
    typeYear = ty;
    headline = h;
    geoCoverage = gc;
  } catch (err) {
    loading.textContent = `Could not load the map (${err.message}). Boundaries come from scripts/fetch_data.sh; figures from sql/02_findings.sql.`;
    console.error(err);
    return;
  }

  /* The first year whose geographic coverage clears the threshold, read from
     the pipeline rather than written in. */
  const geoFirst = (geoCoverage.find((r) => r.usable_for_geography) || {}).year || headline.first_year;

  const byCa = new Map(areas.map((a) => [String(a.ca), a]));

  /* Citywide incidents per year, for the comparison line in a profile. */
  const cityByYear = (() => {
    const m = new Map();
    for (const r of typeYear) m.set(r.year, (m.get(r.year) || 0) + r.incidents);
    return m;
  })();

  /* --- Measures ----------------------------------------------------------- */
  /* Every measure is read straight off community_areas.json rather than
     recomputed here, so the map cannot drift from the report's plates. */

  const MEASURES = [
    {
      key: "violent_per_100k",
      label: "Violent per 100k",
      format: (v) => f.dec(v, 0),
      blurb: `Violent Part I incidents per 100,000 residents, ${geoFirst} onward`,
    },
    {
      key: "violent",
      label: "Violent count",
      format: f.int,
      blurb: `Violent Part I incidents, total across ${geoFirst} onward`,
    },
    {
      key: "total_per_100k",
      label: "All per 100k",
      format: (v) => f.dec(v, 0),
      blurb: `All recorded incidents per 100,000 residents, ${geoFirst} onward`,
    },
    {
      key: "arrest_rate",
      label: "Arrest rate",
      format: (v) => f.pct(v),
      blurb: "Share of the area's incidents that ended in an arrest",
    },
    {
      key: "per_capita_income",
      label: "Income",
      format: (v) => `$${f.int(v)}`,
      blurb: "Per-capita income, 2008–2012 socioeconomic indicators",
    },
  ];
  let measure = MEASURES[0];
  let selected = null;

  const switchHost = $('[data-switch="measure"]');
  function buildSwitch() {
    switchHost.innerHTML = "";
    for (const m of MEASURES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = m.label;
      b.setAttribute("aria-pressed", String(m.key === measure.key));
      b.addEventListener("click", () => {
        measure = m;
        buildSwitch();
        drawMap();
      });
      switchHost.appendChild(b);
    }
  }

  /* --- Map ---------------------------------------------------------------- */

  function drawMap() {
    const values = new Map();
    for (const a of areas) {
      const v = a[measure.key];
      if (v != null && !Number.isNaN(v)) values.set(String(a.ca), v);
    }

    /* The figure wrapper is recreated on each draw, so the table twin that
       choropleth() attaches does not accumulate duplicate toggles. */
    const figure = $('[data-figure="map"]');
    figure.querySelectorAll(".figure__tools, .table-scroll").forEach((n) => n.remove());
    const holder = figure.querySelector(".figure__frame").nextElementSibling;
    if (holder && holder.hasAttribute("hidden")) holder.remove();
    figure.querySelector(".figure__frame").hidden = false;

    A.choropleth($('[data-chart="map"]'), {
      features: geo.features,
      values,
      width: 560,
      height: 700,
      valueFormat: measure.format,
      selected,
      onSelect: (id) => {
        selected = selected === id ? null : id;
        drawMap();
        showProfile(selected);
      },
      figure,
      tableColumns: ["Community area", measure.label],
      tableLabel: "all 77 areas",
      title: `Chicago community areas shaded by ${measure.label.toLowerCase()}`,
    });

    $("[data-caption='map']").innerHTML =
      `<b>${measure.label}.</b> ${measure.blurb}. Shaded in five quantile bins, so
       each band holds roughly the same number of areas — a few extreme areas
       would otherwise flatten every other distinction. Click an area to select
       it.`;
  }

  /* --- Profile panel ------------------------------------------------------ */

  function showProfile(id) {
    const nameEl = $("[data-profile-name]");
    const rankEl = $("[data-profile-rank]");
    const hintEl = $("[data-profile-hint]");
    const statsEl = $("[data-profile-stats]");
    const sparkEl = $("[data-profile-spark]");

    if (!id || !byCa.has(id)) {
      nameEl.textContent = "Pick an area";
      rankEl.textContent = "";
      hintEl.hidden = false;
      statsEl.hidden = true;
      sparkEl.hidden = true;
      return;
    }

    const a = byCa.get(id);
    nameEl.textContent = D.titleCase(a.name);
    rankEl.textContent = `Rank ${a.rank_by_count} of ${areas.length} by violent count · rank ${a.rank_by_rate} by rate`;
    hintEl.hidden = true;

    const cityTotalPop = areas.reduce((s, x) => s + x.population, 0);
    const cityViolent = areas.reduce((s, x) => s + x.violent, 0);
    const cityRate = (cityViolent / cityTotalPop) * 100000;

    const rows = [
      ["Population", f.int(a.population)],
      ["All incidents", f.int(a.total)],
      ["Violent Part I", f.int(a.violent)],
      ["Violent per 100k", f.dec(a.violent_per_100k, 0)],
      ["Citywide per 100k", f.dec(cityRate, 0)],
      ["Against citywide", f.signedPct(((a.violent_per_100k - cityRate) / cityRate) * 100, 0)],
      ["Arrest rate", f.pct(a.arrest_rate)],
      ["Per-capita income", a.per_capita_income == null ? "—" : `$${f.int(a.per_capita_income)}`],
      ["Hardship index", a.hardship_index == null ? "—" : String(a.hardship_index)],
    ];
    statsEl.innerHTML = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join("");
    statsEl.hidden = false;

    /* The area has no per-year series in community_areas.json — that would be
       a 77 x 26 table this page does not otherwise need — so the sparkline
       shows the citywide trend as context for the area's figures above. */
    const points = [...cityByYear.entries()]
      .filter(([y]) => y >= geoFirst && y < headline.last_year)
      .sort((x, y) => x[0] - y[0])
      .map(([y, n]) => ({ x: y, y: n }));
    sparkEl.hidden = false;
    sparkEl.querySelector("p").textContent = "Citywide incidents per year, for comparison";
    A.sparkline($('[data-chart="profile-spark"]'), {
      points,
      width: 260,
      height: 54,
      title: "Citywide incidents per year",
    });
  }

  buildSwitch();
  drawMap();
  showProfile(null);
  loading.hidden = true;
  app.hidden = false;
})();
