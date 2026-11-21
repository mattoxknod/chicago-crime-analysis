/* ===========================================================================
   dashboard.js — the interactive page.
   ---------------------------------------------------------------------------
   The browser cannot hold 8.7 million incident rows, so it holds pre-grouped
   counts instead and sums them. sql/03_cubes.sql writes three cubes:

     cube_main      year x month x community area x offence group x arrest
                    x domestic  — the source for everything except the clock.
                    Geographically coded rows only, so it starts in 2002.
     cube_clock     year x hour x weekday x offence group — hour and weekday
                    would multiply cube_main past a sensible download.
     cube_citywide  year x month x offence group x arrest x domestic, every
                    row including 2001's ungeocoded incidents.

   Both the cubes and the report's figures are built from the same incident
   table, which is what keeps the two pages' numbers identical;
   sql/04_verify.sql checks that claim rather than trusting it.

   Cube rows are parsed into parallel typed arrays, not objects. At a few
   hundred thousand rows that is the difference between a filter pass that is
   imperceptible and one the reader waits for.
   =========================================================================== */

(async function () {
  "use strict";

  const A = Atlas;
  const D = AtlasData;
  const f = A.fmt;

  D.masthead("dashboard");

  const $ = (sel) => document.querySelector(sel);
  const loading = $("[data-loading]");
  const app = $("[data-app]");

  /* --- Minimal CSV parser ------------------------------------------------- */
  /* The cubes contain no quoted fields or embedded commas — they are integers
     and a small set of offence-group names that sql/03_cubes.sql controls — so
     a split is correct here and far faster than a general parser. */

  function parseCube(csvText, numeric) {
    const lines = csvText.trim().split("\n");
    const header = lines[0].trim().split(",");
    const n = lines.length - 1;
    const cols = {};
    for (const h of header) {
      cols[h] = numeric.includes(h) ? new Int32Array(n) : new Array(n);
    }
    for (let i = 0; i < n; i++) {
      const parts = lines[i + 1].split(",");
      for (let j = 0; j < header.length; j++) {
        const h = header[j];
        cols[h][i] = numeric.includes(h) ? +parts[j] : parts[j];
      }
    }
    cols.length = n;
    return cols;
  }

  /* String columns become integer codes, so the hot loop compares numbers. */
  function encode(column, length) {
    const values = [...new Set(Array.prototype.slice.call(column, 0, length))].sort();
    const index = new Map(values.map((v, i) => [v, i]));
    const codes = new Int16Array(length);
    for (let i = 0; i < length; i++) codes[i] = index.get(column[i]);
    return { values, index, codes };
  }

  /* --- Load --------------------------------------------------------------- */

  let main, clock, citywide, areas, geo;
  try {
    const [mainCsv, clockCsv, cityCsv, caCsv, geoJson] = await Promise.all([
      fetch("data/derived/cube_main.csv").then((r) => r.text()),
      fetch("data/derived/cube_clock.csv").then((r) => r.text()),
      fetch("data/derived/cube_citywide.csv").then((r) => r.text()),
      fetch("data/derived/ca_lookup.csv").then((r) => r.text()),
      fetch("data/raw/community_areas.geojson")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    main = parseCube(mainCsv, ["y", "m", "ca", "a", "d", "n", "p"]);
    clock = parseCube(clockCsv, ["y", "h", "w", "n", "a"]);
    citywide = parseCube(cityCsv, ["y", "m", "a", "d", "n"]);

    /* The community area lookup is small; parse it into plain objects. */
    const caLines = caCsv.trim().split("\n");
    const caHeader = caLines[0].split(",");
    areas = caLines.slice(1).map((line) => {
      const parts = line.split(",");
      const o = {};
      caHeader.forEach((h, i) => (o[h] = i === 1 ? parts[i] : +parts[i]));
      return o;
    });
    geo = geoJson;
  } catch (err) {
    loading.textContent = `Could not load the aggregates (${err.message}). They are written by sql/03_cubes.sql into data/derived/.`;
    console.error(err);
    return;
  }

  const mainTypes = encode(main.t, main.length);
  const clockTypes = encode(clock.t, clock.length);
  const cityTypes = encode(citywide.t, citywide.length);

  const areaById = new Map(areas.map((a) => [a.ca, a]));
  const typeNames = mainTypes.values;
  const years = (() => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < citywide.length; i++) {
      if (citywide.y[i] < lo) lo = citywide.y[i];
      if (citywide.y[i] > hi) hi = citywide.y[i];
    }
    return { lo, hi };
  })();

  /* The final year in the extract is partial; the dashboard says so rather
     than letting it read as a collapse. */
  const partialYear = years.hi;

  /* --- Filter state ------------------------------------------------------- */

  const DEFAULTS = Object.freeze({
    from: years.lo,
    to: years.hi,
    season: "all",
    arrest: "all",
    domestic: "all",
    types: [],
    areas: [],
  });
  let state = { ...DEFAULTS, types: [], areas: [] };

  const SEASONS = {
    all: null,
    winter: [12, 1, 2],
    spring: [3, 4, 5],
    summer: [6, 7, 8],
    autumn: [9, 10, 11],
  };

  const MEASURES = [
    { key: "count", label: "Incidents", format: f.int, axis: f.compact },
    { key: "arrest_rate", label: "Arrest rate", format: (v) => f.pct(v), axis: (v) => `${Math.round(v)}%`, pct: true },
    { key: "per100k", label: "Per 100k residents", format: (v) => f.dec(v, 0), axis: f.compact },
    { key: "share", label: "Share of selection", format: (v) => f.pct(v), axis: (v) => `${Math.round(v)}%`, pct: true },
    { key: "part1", label: "Part I incidents", format: f.int, axis: f.compact },
  ];
  const BREAKDOWNS = [
    { key: "type", label: "Offence group" },
    { key: "area", label: "Community area" },
    { key: "year", label: "Year" },
    { key: "month", label: "Month" },
    { key: "arrest", label: "Arrest made" },
    { key: "domestic", label: "Domestic" },
  ];
  let measure = MEASURES[0];
  let breakdown = BREAKDOWNS[0];

  /* --- Controls ----------------------------------------------------------- */

  const typeSelect = $('[data-filter="types"]');
  typeNames.forEach((t) => {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = t;
    typeSelect.appendChild(o);
  });

  const areaSelect = $('[data-filter="areas"]');
  [...areas]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((a) => {
      const o = document.createElement("option");
      o.value = String(a.ca);
      o.textContent = D.titleCase(a.name);
      areaSelect.appendChild(o);
    });

  const fromInput = $('[data-filter="from"]');
  const toInput = $('[data-filter="to"]');
  for (const input of [fromInput, toInput]) {
    input.min = String(years.lo);
    input.max = String(years.hi);
    input.step = "1";
  }
  fromInput.value = String(years.lo);
  toInput.value = String(years.hi);

  function buildSwitch(host, items, current, onPick) {
    host.innerHTML = "";
    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = item.label;
      b.setAttribute("aria-pressed", String(item.key === current().key));
      b.addEventListener("click", () => {
        onPick(item);
        [...host.children].forEach((c) =>
          c.setAttribute("aria-pressed", String(c.textContent === item.label))
        );
        render();
      });
      host.appendChild(b);
    }
  }
  buildSwitch($('[data-switch="measure"]'), MEASURES, () => measure, (m) => (measure = m));
  buildSwitch($('[data-switch="breakdown"]'), BREAKDOWNS, () => breakdown, (b) => (breakdown = b));

  function readControls() {
    let from = +fromInput.value;
    let to = +toInput.value;
    /* Keep the two ends ordered however the reader drags them. */
    if (from > to) [from, to] = [to, from];
    state = {
      from,
      to,
      season: $('[data-filter="season"]').value,
      arrest: $('[data-filter="arrest"]').value,
      domestic: $('[data-filter="domestic"]').value,
      types: [...typeSelect.selectedOptions].map((o) => o.value),
      areas: [...areaSelect.selectedOptions].map((o) => +o.value),
    };
    $('[data-out="from"]').value = String(from);
    $('[data-out="to"]').value = String(to);
    $('[data-count="types"]').textContent = state.types.length ? `(${state.types.length})` : "(all)";
    $('[data-count="areas"]').textContent = state.areas.length ? `(${state.areas.length})` : "(all)";
  }

  for (const el of document.querySelectorAll("[data-filter]")) {
    el.addEventListener("input", () => {
      readControls();
      render();
    });
  }

  $("[data-reset]").addEventListener("click", () => {
    fromInput.value = String(DEFAULTS.from);
    toInput.value = String(DEFAULTS.to);
    $('[data-filter="season"]').value = DEFAULTS.season;
    $('[data-filter="arrest"]').value = DEFAULTS.arrest;
    $('[data-filter="domestic"]').value = DEFAULTS.domestic;
    for (const o of typeSelect.options) o.selected = false;
    for (const o of areaSelect.options) o.selected = false;
    measure = MEASURES[0];
    breakdown = BREAKDOWNS[0];
    buildSwitch($('[data-switch="measure"]'), MEASURES, () => measure, (m) => (measure = m));
    buildSwitch($('[data-switch="breakdown"]'), BREAKDOWNS, () => breakdown, (b) => (breakdown = b));
    readControls();
    render();
  });

  /* --- Aggregation -------------------------------------------------------- */
  /* One pass over a cube, summing into whatever buckets the current breakdown
     needs. Membership tests are precomputed into flat lookup arrays so the
     inner loop does array indexing rather than Set lookups. */

  function buildMask() {
    const monthOk = new Uint8Array(13);
    const months = SEASONS[state.season];
    if (months) for (const m of months) monthOk[m] = 1;
    else monthOk.fill(1);

    const typeOk = new Uint8Array(typeNames.length);
    if (state.types.length) {
      for (const t of state.types) {
        const i = mainTypes.index.get(t);
        if (i != null) typeOk[i] = 1;
      }
    } else typeOk.fill(1);

    const maxCa = Math.max(...areas.map((a) => a.ca)) + 1;
    const areaOk = new Uint8Array(maxCa);
    if (state.areas.length) for (const c of state.areas) areaOk[c] = 1;
    else areaOk.fill(1);

    const arrestWanted = state.arrest === "all" ? -1 : +state.arrest;
    const domesticWanted = state.domestic === "all" ? -1 : +state.domestic;

    return { monthOk, typeOk, areaOk, arrestWanted, domesticWanted, maxCa };
  }

  /* Totals for the summary figures, from cube_main. */
  function aggregate() {
    const mask = buildMask();
    const { monthOk, typeOk, areaOk, arrestWanted, domesticWanted } = mask;

    let n = 0, nArrest = 0, nPart1 = 0, nDomestic = 0;
    const byType = new Float64Array(typeNames.length);
    const byArea = new Float64Array(mask.maxCa);
    const byAreaArrest = new Float64Array(mask.maxCa);
    const byYear = new Map();
    const byMonth = new Float64Array(13);
    const byArrest = [0, 0];
    const byDomestic = [0, 0];
    const byTypeArrest = new Float64Array(typeNames.length);
    const byYearArrest = new Map();
    const byMonthArrest = new Float64Array(13);
    const areasSeen = new Set();

    const Y = main.y, M = main.m, CA = main.ca, Ar = main.a, Dm = main.d, N = main.n, P = main.p;
    const T = mainTypes.codes;

    for (let i = 0; i < main.length; i++) {
      const y = Y[i];
      if (y < state.from || y > state.to) continue;
      if (!monthOk[M[i]]) continue;
      if (!typeOk[T[i]]) continue;
      const ca = CA[i];
      if (!areaOk[ca]) continue;
      const a = Ar[i];
      if (arrestWanted !== -1 && a !== arrestWanted) continue;
      const dm = Dm[i];
      if (domesticWanted !== -1 && dm !== domesticWanted) continue;

      const c = N[i];
      n += c;
      nPart1 += P[i];
      if (a === 1) nArrest += c;
      if (dm === 1) nDomestic += c;

      byType[T[i]] += c;
      byArea[ca] += c;
      byMonth[M[i]] += c;
      byArrest[a] += c;
      byDomestic[dm] += c;
      byYear.set(y, (byYear.get(y) || 0) + c);
      areasSeen.add(ca);
      if (a === 1) {
        byTypeArrest[T[i]] += c;
        byAreaArrest[ca] += c;
        byMonthArrest[M[i]] += c;
        byYearArrest.set(y, (byYearArrest.get(y) || 0) + c);
      }
    }

    return {
      n, nArrest, nPart1, nDomestic,
      byType, byTypeArrest, byArea, byAreaArrest,
      byYear, byYearArrest, byMonth, byMonthArrest,
      byArrest, byDomestic, areasSeen,
    };
  }

  /* The clock cube carries neither community area nor the domestic flag, so
     those two filters cannot narrow it. The panel says so when they are set,
     rather than quietly showing a different slice than the rest of the page. */
  function aggregateClock() {
    const typeOk = new Uint8Array(clockTypes.values.length);
    if (state.types.length) {
      for (const t of state.types) {
        const i = clockTypes.index.get(t);
        if (i != null) typeOk[i] = 1;
      }
    } else typeOk.fill(1);

    const cells = new Float64Array(24 * 7);
    const Y = clock.y, Hh = clock.h, W = clock.w, N = clock.n, Aa = clock.a;
    const T = clockTypes.codes;
    const arrestOnly = state.arrest === "1";
    const noArrestOnly = state.arrest === "0";

    for (let i = 0; i < clock.length; i++) {
      if (Y[i] < state.from || Y[i] > state.to) continue;
      if (!typeOk[T[i]]) continue;
      const v = arrestOnly ? Aa[i] : noArrestOnly ? N[i] - Aa[i] : N[i];
      if (!v) continue;
      cells[(W[i] - 1) * 24 + Hh[i]] += v;
    }
    return cells;
  }

  /* --- Measure resolution ------------------------------------------------- */
  /* One place that turns a bucket's count, arrest count and population into
     whatever the current measure is. Every chart and the table go through it,
     so they cannot disagree about what "per 100k" means. */

  function resolve(count, arrestCount, part1Count, population, total) {
    switch (measure.key) {
      case "arrest_rate":
        return count ? (arrestCount / count) * 100 : null;
      case "per100k":
        return population ? (count / population) * 100000 : null;
      case "share":
        return total ? (count / total) * 100 : null;
      case "part1":
        return part1Count;
      default:
        return count;
    }
  }

  /* --- Render ------------------------------------------------------------- */

  function render() {
    const charts = document.querySelectorAll(".grid-charts .panel, [data-summary]");
    charts.forEach((c) => c.classList.add("is-busy"));

    const agg = aggregate();
    const selectedPop = [...agg.areasSeen].reduce(
      (s, ca) => s + (areaById.get(ca)?.population || 0),
      0
    );

    /* --- Summary figures --- */
    const summary = [
      { value: f.int(agg.n), label: "incidents in this selection", note: `${state.from}–${state.to}` },
      {
        value: agg.n ? f.pct((agg.nArrest / agg.n) * 100) : "—",
        label: "ended in an arrest",
        note: `${f.int(agg.nArrest)} arrests`,
      },
      {
        value: selectedPop ? f.dec((agg.n / selectedPop) * 100000, 0) : "—",
        label: "incidents per 100k residents",
        note: `${f.compact(selectedPop)} residents in ${agg.areasSeen.size} areas`,
      },
      {
        value: agg.n ? f.pct((agg.nPart1 / agg.n) * 100) : "—",
        label: "were FBI Part I offences",
        note: `${f.int(agg.nPart1)} incidents`,
      },
      {
        value: agg.n ? f.pct((agg.nDomestic / agg.n) * 100) : "—",
        label: "were flagged domestic",
        note: `${f.int(agg.nDomestic)} incidents`,
      },
      {
        value: String(agg.areasSeen.size),
        label: `of ${areas.length} community areas represented`,
        note: state.areas.length ? "filtered" : "no area filter",
      },
    ];
    $("[data-summary]").innerHTML = summary
      .map(
        (s) => `<div class="keyfigure">
          <span class="keyfigure__value">${s.value}</span>
          <span class="keyfigure__label">${s.label}</span>
          <span class="keyfigure__note">${s.note}</span>
        </div>`
      )
      .join("");

    /* --- Chart 1: over time --- */
    const yearList = [...agg.byYear.keys()].sort((a, b) => a - b);
    const timePoints = yearList.map((y) => {
      const c = agg.byYear.get(y) || 0;
      const ac = agg.byYearArrest.get(y) || 0;
      return { x: y, y: resolve(c, ac, null, selectedPop, agg.n) };
    });
    $('[data-sub="time"]').textContent = `${measure.label} by year${state.to === partialYear ? ` · ${partialYear} is a partial year` : ""}`;
    if (measure.key === "part1") {
      /* Part I is not carried per year in the aggregation above, so this
         measure falls back to the incident count rather than show a wrong
         line. Stated in the subtitle instead of silently substituted. */
      $('[data-sub="time"]').textContent = "Incidents by year · Part I is not broken out over time";
    }
    A.lineChart($('[data-chart="time"]'), {
      series: [{ name: measure.label, color: A.token("--series-1"), points: timePoints }],
      yZero: !measure.pct ? true : true,
      yFormat: measure.axis,
      tipFormat: measure.format,
      xFormat: (v) => String(v),
      width: 560,
      height: 300,
      margin: { left: 58, right: 18, top: 14, bottom: 30 },
      directLabel: false,
      title: `${measure.label} by year for the current selection`,
    });

    /* --- Chart 2: breakdown --- */
    let rows = [];
    if (breakdown.key === "type") {
      rows = typeNames.map((name, i) => ({
        name,
        count: agg.byType[i],
        arrest: agg.byTypeArrest[i],
        population: selectedPop,
      }));
    } else if (breakdown.key === "area") {
      rows = [...agg.areasSeen].map((ca) => {
        const a = areaById.get(ca);
        return {
          name: a ? D.titleCase(a.name) : `Area ${ca}`,
          count: agg.byArea[ca],
          arrest: agg.byAreaArrest[ca],
          population: a?.population || 0,
        };
      });
    } else if (breakdown.key === "year") {
      rows = yearList.map((y) => ({
        name: String(y),
        count: agg.byYear.get(y) || 0,
        arrest: agg.byYearArrest.get(y) || 0,
        population: selectedPop,
      }));
    } else if (breakdown.key === "month") {
      rows = D.MONTHS.map((nm, i) => ({
        name: nm,
        count: agg.byMonth[i + 1],
        arrest: agg.byMonthArrest[i + 1],
        population: selectedPop,
      }));
    } else if (breakdown.key === "arrest") {
      rows = [
        { name: "No arrest", count: agg.byArrest[0], arrest: 0, population: selectedPop },
        { name: "Arrest made", count: agg.byArrest[1], arrest: agg.byArrest[1], population: selectedPop },
      ];
    } else {
      rows = [
        { name: "Non-domestic", count: agg.byDomestic[0], arrest: 0, population: selectedPop },
        { name: "Domestic", count: agg.byDomestic[1], arrest: 0, population: selectedPop },
      ];
    }

    rows = rows.filter((r) => r.count > 0);
    const valued = rows
      .map((r) => ({ ...r, value: resolve(r.count, r.arrest, null, r.population, agg.n) }))
      .filter((r) => r.value != null);

    /* Order by value, except where the category is inherently ordered — a
       month or a year sorted by size would be unreadable. */
    const ordered = ["month", "year"].includes(breakdown.key)
      ? valued
      : valued.sort((a, b) => b.value - a.value);
    const shown = ordered.slice(0, 20);

    $("[data-title='breakdown']").textContent = `${measure.label} by ${breakdown.label.toLowerCase()}`;
    $('[data-sub="breakdown"]').textContent =
      ordered.length > shown.length ? `Top ${shown.length} of ${ordered.length}` : `${ordered.length} categories`;
    A.barChart($('[data-chart="breakdown"]'), {
      bars: shown.map((r) => ({ label: r.name, value: r.value })),
      horizontal: true,
      valueFormat: measure.format,
      axisFormat: measure.axis,
      width: 560,
      height: Math.max(220, shown.length * 26 + 50),
      margin: { left: 140, right: 70, top: 8, bottom: 28 },
      title: `${measure.label} by ${breakdown.label.toLowerCase()}`,
    });

    /* --- Chart 3: the clock --- */
    const cells = aggregateClock();
    const clockCells = [];
    for (let w = 0; w < 7; w++) {
      for (let h = 0; h < 24; h++) {
        clockCells.push({ r: D.DAYS[w], c: h, v: cells[w * 24 + h] });
      }
    }
    const clockCaveats = [];
    if (state.areas.length) clockCaveats.push("community area");
    if (state.domestic !== "all") clockCaveats.push("domestic");
    if (state.season !== "all") clockCaveats.push("month");
    $('[data-sub="clock"]').textContent = clockCaveats.length
      ? `Incidents by hour and weekday · ignores the ${clockCaveats.join(" and ")} filter`
      : "Incidents by hour and weekday";
    A.heatmap($('[data-chart="clock"]'), {
      rows: D.DAYS,
      cols: Array.from({ length: 24 }, (_, i) => i),
      cells: clockCells,
      colLabel: (c) => (c % 3 === 0 ? D.hourLabel(c) : ""),
      valueFormat: f.int,
      width: 560,
      height: 260,
      margin: { left: 42, right: 14, top: 8, bottom: 26 },
      title: "Incidents by hour of day and day of week",
    });

    /* --- Chart 4: the map --- */
    $('[data-sub="map"]').textContent = geo
      ? `${measure.label} by community area`
      : "Boundary file not present — run scripts/fetch_data.sh";
    if (geo) {
      const values = new Map();
      for (const ca of agg.areasSeen) {
        const a = areaById.get(ca);
        const v = resolve(agg.byArea[ca], agg.byAreaArrest[ca], null, a?.population || 0, agg.n);
        if (v != null) values.set(String(ca), v);
      }
      A.choropleth($('[data-chart="map"]'), {
        features: geo.features,
        values,
        width: 480,
        height: 560,
        valueFormat: measure.format,
        title: `${measure.label} by community area`,
      });
    }

    /* --- The table behind the current view --- */
    const tableRows = ordered.map((r) => [
      r.name,
      f.int(r.count),
      f.int(r.arrest),
      r.count ? f.pct((r.arrest / r.count) * 100) : "—",
      r.population ? f.dec((r.count / r.population) * 100000, 0) : "—",
      f.pct(agg.n ? (r.count / agg.n) * 100 : 0),
    ]);
    const table = A.buildTable(
      [breakdown.label, "Incidents", "Arrests", "Arrest rate", "Per 100k", "Share"],
      tableRows,
      `The numbers behind this view — ${breakdown.label.toLowerCase()}, ${state.from} to ${state.to}`
    );
    const host = $("[data-table]");
    host.innerHTML = "";
    host.appendChild(table);

    /* --- Provenance --- */
    $("[data-slice]").innerHTML = [
      `${f.int(agg.n)} incidents`,
      `${state.from}–${state.to}`,
      state.season === "all" ? "all months" : state.season,
      state.types.length ? `${state.types.length} offence groups` : "all offences",
      state.areas.length ? `${state.areas.length} areas` : "all areas",
      state.arrest === "all" ? "arrest: either" : state.arrest === "1" ? "arrest made" : "no arrest",
      state.domestic === "all" ? "domestic: either" : state.domestic === "1" ? "domestic only" : "non-domestic",
    ].join("  ·  ");

    $("[data-provenance]").textContent =
      `Computed in the browser from ${f.int(main.length)} pre-grouped rows covering every geographically coded incident from ${years.lo} onward. ${partialYear} is a partial year. Figures broken out by community area exclude 2001, which carries no geographic coding.`;

    charts.forEach((c) => c.classList.remove("is-busy"));
  }

  readControls();
  render();
  loading.hidden = true;
  app.hidden = false;
})();
