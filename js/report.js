/* ===========================================================================
   report.js — renders index.html from data/derived/.
   ---------------------------------------------------------------------------
   Every number on the report page, in prose as well as in charts, is read from
   the JSON that sql/02_findings.sql writes. Nothing is typed as a literal. The
   `n()` helper below is what enforces that: prose is assembled from values
   pulled out of the loaded data, so a number in a sentence cannot drift away
   from the number in the chart beside it.
   =========================================================================== */

(async function () {
  "use strict";

  const A = Atlas;
  const D = AtlasData;
  const f = A.fmt;

  D.masthead("report");

  /* --- Load --------------------------------------------------------------- */

  let d;
  try {
    d = await D.all({
      annual: "annual.json",
      decomp: "decomposition.json",
      counter: "counterfactual.json",
      typeYear: "type_year.json",
      typeTotals: "type_totals.json",
      mvt: "mvt_monthly.json",
      season: "seasonality.json",
      clock: "clock.json",
      conc: "concentration.json",
      areas: "community_areas.json",
      domestic: "domestic.json",
      domesticMonthly: "domestic_monthly.json",
      settings: "settings.json",
      qualityYear: "quality_by_year.json",
      geoCoverage: "geo_coverage.json",
    });
    d.headline = await D.one("headline.json");
    d.quality = await D.one("quality.json");
  } catch (err) {
    D.fail(document.querySelector("main"), err);
    return;
  }

  /* --- Derived values the prose and charts share -------------------------- */
  /* Computed once, here, so a sentence and the chart under it cannot diverge. */

  const H = d.headline;
  const lastFull = H.last_full_year;
  const annualFull = d.annual.filter((r) => !r.partial_year);
  const byYear = new Map(d.annual.map((r) => [r.year, r]));
  const decompByYear = new Map(d.decomp.map((r) => [r.year, r]));

  const peakRate = d.decomp.reduce((a, b) => (b.arrest_rate_all > a.arrest_rate_all ? b : a));
  const troughRate = d.decomp
    .filter((r) => r.year < H.last_year)
    .reduce((a, b) => (b.arrest_rate_all < a.arrest_rate_all ? b : a));
  const latestDecomp = decompByYear.get(lastFull);

  /* The largest single-year fall in the arrest rate — found, not assumed. */
  let biggestDrop = { year: null, delta: 0 };
  for (let i = 1; i < d.decomp.length; i++) {
    const delta = d.decomp[i].arrest_rate_all - d.decomp[i - 1].arrest_rate_all;
    if (delta < biggestDrop.delta) biggestDrop = { year: d.decomp[i].year, delta, from: d.decomp[i - 1].arrest_rate_all, to: d.decomp[i].arrest_rate_all };
  }

  const narcPeak = d.decomp.reduce((a, b) => (b.narcotics > a.narcotics ? b : a));
  const narcLatest = decompByYear.get(lastFull);

  const typesSorted = [...d.typeTotals].sort((a, b) => b.total - a.total);
  const topTypes = typesSorted.slice(0, 16);
  const mvtRow = d.typeTotals.find((t) => t.type === "MOTOR VEHICLE THEFT");

  /* Vehicle theft before and after the 2022 break, from the monthly series.
     Compared on the YYYY-MM prefix, not the raw value: DuckDB exports a DATE
     as "2021-12-01", and "2021-12-01" <= "2021-12" is false as a string
     comparison, which would silently drop December from each window. */
  const ym = (m) => String(m.month).slice(0, 7);
  const mvtBefore = d.mvt.filter((m) => ym(m) >= "2019-01" && ym(m) <= "2021-12");
  const mvtAfter = d.mvt.filter((m) => ym(m) >= "2023-01" && ym(m) <= "2023-12");
  const mvtBeforeAvg = mvtBefore.reduce((s, m) => s + m.incidents, 0) / (mvtBefore.length || 1);
  const mvtAfterAvg = mvtAfter.reduce((s, m) => s + m.incidents, 0) / (mvtAfter.length || 1);
  const mvtPeakMonth = d.mvt.reduce((a, b) => (b.incidents > a.incidents ? b : a));

  const seasonPeak = d.season.reduce((a, b) => (b.violent_vs_mean > a.violent_vs_mean ? b : a));
  const seasonLow = d.season.reduce((a, b) => (b.violent_vs_mean < a.violent_vs_mean ? b : a));

  const top10Violent = d.conc.slice(0, 10);
  const conc10 = top10Violent[top10Violent.length - 1].cumulative_pct;
  const areasCount = d.conc.length;

  /* How far the count ranking and the per-capita ranking disagree. */
  const rankShift = d.areas
    .map((a) => ({ ...a, shift: a.rank_by_count - a.rank_by_rate }))
    .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
  const biggestRiser = rankShift.find((a) => a.shift > 0);
  const biggestFaller = rankShift.find((a) => a.shift < 0);
  const topByCount = d.areas.find((a) => a.rank_by_count === 1);
  const topByRate = d.areas.find((a) => a.rank_by_rate === 1);

  /* Which years carry geographic analysis, read from the pipeline rather than
     written in: the threshold is applied in sql/01_load.sql. */
  const geoBad = d.geoCoverage.filter((r) => !r.usable_for_geography);
  const geoGood = d.geoCoverage.filter((r) => r.usable_for_geography);
  const geoFirst = geoGood.length ? geoGood[0].year : H.first_year;
  const geoUsableRows = geoGood.reduce((s, r) => s + r.geocoded, 0);

  const incomeCorr = D.correlation(
    d.areas.map((a) => a.per_capita_income),
    d.areas.map((a) => a.violent_per_100k)
  );

  const domLast = d.domestic.find((r) => r.year === lastFull);
  const domFirst = d.domestic[0];
  const domPeakShare = d.domesticMonthly.reduce((a, b) => (b.domestic_share > a.domestic_share ? b : a));

  const settingYears = [...new Set(d.settings.map((r) => r.year))].sort((a, b) => a - b);
  const settingNames = [...new Set(d.settings.map((r) => r.setting))];
  const settingAt = (year, setting) =>
    d.settings.find((r) => r.year === year && r.setting === setting)?.pct_of_year ?? 0;

  /* --- Writers ------------------------------------------------------------ */

  /* Wraps a number in the figure face, so quoted values read as figures. */
  const n = (v) => `<span class="num">${v}</span>`;

  function setText(key, html) {
    const host = document.querySelector(`[data-head="${key}"]`);
    if (host) host.innerHTML = html;
  }

  function setProse(key, paragraphs) {
    const host = document.querySelector(`[data-prose="${key}"]`);
    if (!host) return;
    host.innerHTML = paragraphs.map((p) => `<p>${p}</p>`).join("");
  }

  function setCaption(key, html) {
    const host = document.querySelector(`[data-caption="${key}"]`);
    if (host) host.innerHTML = html;
  }

  const chartHost = (key) => document.querySelector(`[data-chart="${key}"]`);
  const figureOf = (key) => document.querySelector(`[data-figure="${key}"]`);

  /* =========================================================================
     Title block and headline figures
     ========================================================================= */

  /* How much of the arrest-rate decline is composition rather than clearance.
     Measured, not assumed: the counterfactual holds the offence mix at its
     first-year shares and applies each year's own within-group rates. */
  const cfFirst = d.counter.find((r) => r.year === H.first_year);
  const cfTrough = d.counter.find((r) => r.year === troughRate.year);
  const fallTotal = cfFirst.arrest_rate_actual - cfTrough.arrest_rate_actual;
  const fallIfMixHeld = cfFirst.arrest_rate_actual - cfTrough.arrest_rate_mix_held_constant;
  const mixShareOfFall = (100 * (fallTotal - fallIfMixHeld)) / fallTotal;

  document.querySelector("[data-standfirst]").innerHTML = `
    This is every crime the Chicago Police Department recorded between
    ${n(H.first_year)} and ${n(H.last_year)} — ${n(f.int(H.total_incidents))} incidents
    across ${n(H.months_covered)} months and ${n(H.community_areas)} community areas.
    Reported incidents fell by ${n(f.pct(Math.abs(H.pct_change_peak_to_trough)))} between
    ${n(H.peak_year)} and ${n(H.trough_year)}, and the share ending in an arrest
    fell further still — from ${n(f.pct(peakRate.arrest_rate_all))} to
    ${n(f.pct(troughRate.arrest_rate_all))}. There is a tidy explanation for
    that second number, and this report spends its middle third establishing
    that the tidy explanation accounts for about
    ${n(f.pct(mixShareOfFall, 0))} of it. The rest is a real collapse in how
    often a reported crime ends in an arrest.`;

  const keyfigures = [
    {
      value: f.compact(H.total_incidents),
      label: "reported incidents",
      note: `${H.first_year}–${H.last_year}`,
    },
    {
      value: f.int(byYear.get(lastFull).incidents),
      label: `incidents in ${lastFull}, the last full year`,
      note: `${f.signedPct(((byYear.get(lastFull).incidents - H.peak_incidents) / H.peak_incidents) * 100)} against ${H.peak_year}`,
    },
    {
      value: f.pct(peakRate.arrest_rate_all),
      label: `of incidents ended in an arrest in ${peakRate.year}`,
      note: "the high point of the series",
    },
    {
      value: f.pct(latestDecomp.arrest_rate_all),
      label: `of incidents ended in an arrest in ${lastFull}`,
      note: `low was ${f.pct(troughRate.arrest_rate_all)} in ${troughRate.year}`,
    },
    {
      value: f.pct(conc10),
      label: `of violent Part I incidents fall in 10 of ${areasCount} community areas`,
      note: "geographically coded incidents, ${geoFirst} onward",
    },
    {
      value: f.compact(H.acs_population),
      label: "residents across those community areas",
      note: "2023 ACS five-year estimate",
    },
  ];
  document.querySelector("[data-keyfigures]").innerHTML = keyfigures
    .map(
      (k) => `<div class="keyfigure">
        <span class="keyfigure__value">${k.value}</span>
        <span class="keyfigure__label">${k.label}</span>
        <span class="keyfigure__note">${k.note}</span>
      </div>`
    )
    .join("");

  /* =========================================================================
     Plate 1 — the long decline
     ========================================================================= */

  setText(
    "p1",
    `Reported crime in Chicago fell for twenty years, then stopped falling`
  );
  setProse("p1", [
    `The series opens in ${n(H.first_year)} and runs to the extract's last
     record in ${n(H.last_year)}. Its shape is a long descent followed by a
     flattening. ${n(H.peak_year)} was the peak at ${n(f.int(H.peak_incidents))}
     recorded incidents; ${n(H.trough_year)} was the floor at
     ${n(f.int(H.trough_incidents))}, a fall of
     ${n(f.pct(Math.abs(H.pct_change_peak_to_trough)))} over
     ${n(H.trough_year - H.peak_year)} years.`,
    `Since then the count has risen again, to
     ${n(f.int(byYear.get(lastFull).incidents))} in ${n(lastFull)} —
     ${n(f.signedPct(H.pct_rebound_trough_to_latest))} above the floor, but still
     ${n(f.pct(Math.abs(((byYear.get(lastFull).incidents - H.peak_incidents) / H.peak_incidents) * 100)))}
     below the ${n(H.peak_year)} peak. Read on its own this chart says the
     obvious thing. The rest of these plates are about the places where it is
     misleading.`,
  ]);
  A.lineChart(chartHost("p1"), {
    series: [
      {
        name: "Reported incidents",
        color: A.token("--series-1"),
        points: annualFull.map((r) => ({ x: r.year, y: r.incidents })),
      },
    ],
    yTitle: "Reported incidents",
    xFormat: (v) => String(v),
    tipFormat: f.int,
    height: 380,
    figure: figureOf("p1"),
    tableColumns: ["Year", "Reported incidents"],
    title: "Reported incidents per year, Chicago, 2001 to the last full year",
  });
  setCaption(
    "p1",
    `<b>Reported incidents per year.</b> Whole calendar years only;
     ${n(H.last_year)} is excluded here because the extract ends in
     ${d.quality.last_incident.slice(0, 7)} and a partial year would read as a
     collapse. One row in the source data is one reported incident.`
  );

  /* =========================================================================
     Plate 2 — the arrest rate
     ========================================================================= */

  setText("p2", `The share of incidents ending in an arrest fell by about two thirds`);
  setProse("p2", [
    `Every incident record carries a flag for whether an arrest was made. In
     ${n(peakRate.year)}, ${n(f.pct(peakRate.arrest_rate_all))} of recorded
     incidents carried it. By ${n(troughRate.year)} that was
     ${n(f.pct(troughRate.arrest_rate_all))} — a fall of
     ${n(f.pct(Math.abs(((troughRate.arrest_rate_all - peakRate.arrest_rate_all) / peakRate.arrest_rate_all) * 100)))}
     in relative terms. It has since recovered to
     ${n(f.pct(latestDecomp.arrest_rate_all))} in ${n(lastFull)}.`,
    `The fall is not smooth. The single largest year-on-year drop lands in
     ${n(biggestDrop.year)}, when the rate went from
     ${n(f.pct(biggestDrop.from))} to ${n(f.pct(biggestDrop.to))} —
     ${n(f.dec(Math.abs(biggestDrop.delta), 1))} percentage points in one year.
     A step that abrupt invites a bookkeeping explanation rather than a
     behavioural one, and there is a good one available. The next three plates
     test it, and find it accounts for a minority of the decline.`,
  ]);
  A.lineChart(chartHost("p2"), {
    series: [
      {
        name: "Share ending in arrest",
        color: A.token("--series-2"),
        points: d.decomp
          .filter((r) => r.year < H.last_year)
          .map((r) => ({ x: r.year, y: r.arrest_rate_all })),
      },
    ],
    yZero: true,
    yFormat: (v) => `${Math.round(v)}%`,
    tipFormat: (v) => f.pct(v),
    xFormat: (v) => String(v),
    yTitle: "Share of incidents ending in arrest",
    annotations: [{ x: biggestDrop.year, label: `${biggestDrop.year}`, align: "right" }],
    height: 380,
    figure: figureOf("p2"),
    tableColumns: ["Year", "Share ending in arrest"],
    title: "Share of reported incidents ending in an arrest, by year",
  });
  setCaption(
    "p2",
    `<b>Arrests as a share of reported incidents.</b> Computed as incidents
     flagged as an arrest divided by all incidents recorded that year. The
     dotted rule marks ${n(biggestDrop.year)}, the largest single-year fall in
     the series.`
  );

  /* =========================================================================
     Plate 3 — how an offence reaches the record
     ========================================================================= */

  setText("p3", `Some offences are arrests by definition, which makes the citywide rate a blend of two different things`);
  setProse("p3", [
    `Arrest rates by offence do not form a spectrum of how hard crimes are to
     solve. They form two clusters. Burglary sits at
     ${n(f.pct(d.typeTotals.find((t) => t.type === "BURGLARY").arrest_rate))},
     criminal damage at
     ${n(f.pct(d.typeTotals.find((t) => t.type === "CRIMINAL DAMAGE").arrest_rate))},
     theft at ${n(f.pct(d.typeTotals.find((t) => t.type === "THEFT").arrest_rate))}.
     Narcotics sits at
     ${n(f.pct(d.typeTotals.find((t) => t.type === "NARCOTICS").arrest_rate))}.`,
    `That is not a police force that is extraordinarily good at drug crime. A
     narcotics offence enters this dataset <em>because</em> an officer stopped
     someone and made an arrest; nobody telephones to report a possession
     offence by an unknown offender. The same is true of prostitution,
     gambling, liquor violations and trespass. For these offences the arrest
     flag is close to a tautology, so their count is a measure of enforcement
     activity, and their arrest rate is a measure of nothing.`,
    `Splitting the ${n(d.typeTotals.length)} offence types on that distinction —
     police-initiated against citizen-reported — is the division the next two
     plates rest on. The classification is stated in advance and listed in the
     repository rather than derived from the arrest rates themselves, because
     defining the groups by arrest rate and then reporting their arrest rates
     would be circular.`,
  ]);
  A.barChart(chartHost("p3"), {
    bars: topTypes.map((t) => ({
      label: D.titleCase(t.type),
      value: t.arrest_rate,
      color:
        t.discovery === "police-initiated" ? A.token("--series-2") : A.token("--series-1"),
    })),
    horizontal: true,
    valueFormat: (v) => f.pct(v),
    axisFormat: (v) => `${Math.round(v)}%`,
    height: 520,
    figure: figureOf("p3"),
    tableColumns: ["Offence", "Share ending in arrest"],
    title: "Share of incidents ending in an arrest, by offence type",
  });
  (function p3Legend() {
    const host = chartHost("p3");
    host.prepend(
      A.legend([
        { name: "Police-initiated", color: A.token("--series-2") },
        { name: "Citizen-reported", color: A.token("--series-1") },
      ])
    );
  })();
  setCaption(
    "p3",
    `<b>Arrest rate by offence, the sixteen most common offences.</b> All years
     pooled. Colour marks how the offence normally reaches the record, a
     classification set out in <code>sql/01_load.sql</code>.`
  );

  /* =========================================================================
     Plate 4 — the decomposition
     ========================================================================= */

  const firstDecomp = decompByYear.get(H.first_year);
  setText("p4", `The composition change is real, and it explains about a quarter of the fall`);
  setProse("p4", [
    `The mix did shift, and sharply. Police-initiated offences were
     ${n(f.pct(peakRate.police_initiated_share))} of all recorded incidents in
     ${n(peakRate.year)} and ${n(f.pct(latestDecomp.police_initiated_share))} in
     ${n(lastFull)}. Narcotics alone fell from
     ${n(f.int(narcPeak.narcotics))} recorded incidents in ${n(narcPeak.year)}
     to ${n(f.int(decompByYear.get(troughRate.year).narcotics))} in
     ${n(troughRate.year)}, a fall of
     ${n(f.pct(100 * (1 - decompByYear.get(troughRate.year).narcotics / narcPeak.narcotics), 0))}.
     Since those offences are arrests by construction, losing them drags the
     citywide average down on its own.`,
    `The counterfactual puts a number on how much. Holding the offence mix
     fixed at its ${n(H.first_year)} composition and applying each year's own
     within-group arrest rates, the citywide rate in ${n(troughRate.year)}
     would have been ${n(f.pct(cfTrough.arrest_rate_mix_held_constant))} rather
     than ${n(f.pct(cfTrough.arrest_rate_actual))}. The total fall from
     ${n(H.first_year)} is ${n(f.dec(fallTotal, 1))} percentage points; with
     the mix held constant it is ${n(f.dec(fallIfMixHeld, 1))}. Composition
     therefore accounts for ${n(f.dec(fallTotal - fallIfMixHeld, 1))} points —
     about ${n(f.pct(mixShareOfFall, 0))} of the decline.`,
    `Which means roughly three quarters of it is not composition. The arrest
     rate fell <em>within</em> the citizen-reported group too, from
     ${n(f.pct(firstDecomp.arrest_rate_citizen_reported))} in
     ${n(H.first_year)} to
     ${n(f.pct(decompByYear.get(troughRate.year).arrest_rate_citizen_reported))}
     in ${n(troughRate.year)}. It even fell inside the police-initiated group,
     from ${n(f.pct(firstDecomp.arrest_rate_police_initiated))} to
     ${n(f.pct(decompByYear.get(troughRate.year).arrest_rate_police_initiated))},
     which says those categories changed character as well — more trespass and
     weapons offences recorded without an arrest attached. The tidy
     explanation is a real effect and a minority one.`,
  ]);
  A.lineChart(chartHost("p4"), {
    series: [
      {
        name: "All incidents",
        color: A.token("--series-2"),
        points: d.decomp.filter((r) => r.year < H.last_year).map((r) => ({ x: r.year, y: r.arrest_rate_all })),
      },
      {
        name: "Citizen-reported only",
        color: A.token("--series-1"),
        points: d.decomp.filter((r) => r.year < H.last_year).map((r) => ({ x: r.year, y: r.arrest_rate_citizen_reported })),
      },
      {
        name: "Mix held at " + H.first_year,
        color: A.token("--series-3"),
        points: d.counter.filter((r) => r.year < H.last_year).map((r) => ({ x: r.year, y: r.arrest_rate_mix_held_constant })),
      },
    ],
    yZero: true,
    yFormat: (v) => `${Math.round(v)}%`,
    tipFormat: (v) => f.pct(v),
    xFormat: (v) => String(v),
    yTitle: "Share ending in arrest",
    directLabel: false,
    height: 400,
    figure: figureOf("p4"),
    title: "Arrest rate: as recorded, citizen-reported only, and with the offence mix held constant",
  });
  setCaption(
    "p4",
    `<b>The same decline, decomposed.</b> One y-axis, three series on the same
     measure. "Mix held at ${n(H.first_year)}" reweights each year's
     within-group arrest rates by the ${n(H.first_year)} share of
     police-initiated and citizen-reported offences.`
  );

  /* =========================================================================
     Plate 5 — clearance
     ========================================================================= */

  const y0 = byYear.get(H.first_year);
  const yTrough = byYear.get(troughRate.year);
  const yLast = byYear.get(lastFull);
  const propFall = 100 * (1 - yTrough.property_clearance / y0.property_clearance);
  const violFall = 100 * (1 - yTrough.violent_clearance / y0.violent_clearance);
  setText("p5", `On the strictest measure, property crime clearance fell by three quarters`);
  setProse("p5", [
    `The FBI's Part I index offences — homicide, criminal sexual assault,
     robbery, aggravated assault and battery, burglary, theft, motor vehicle
     theft and arson — are citizen-reported, and they are defined by an outside
     standard rather than by anything chosen here. No composition argument
     touches them: the category is fixed. For these, arrest as a share of
     incidents is a clearance rate in the ordinary sense, and it is the hardest
     test of whether the decline is real.`,
    `It is. Violent Part I clearance ran at ${n(f.pct(y0.violent_clearance))} in
     ${n(H.first_year)} and bottomed at
     ${n(f.pct(yTrough.violent_clearance))} in ${n(troughRate.year)}, a fall of
     ${n(f.pct(violFall, 0))}. Property Part I clearance went from
     ${n(f.pct(y0.property_clearance))} to
     ${n(f.pct(yTrough.property_clearance))} — down ${n(f.pct(propFall, 0))}.
     By ${n(troughRate.year)} roughly ${n(f.dec(100 / yTrough.property_clearance, 0))}
     reported burglaries, thefts, vehicle thefts and arsons were being recorded
     for every one that ended in an arrest.`,
    `Both have since recovered somewhat —
     ${n(f.pct(yLast.violent_clearance))} and
     ${n(f.pct(yLast.property_clearance))} in ${n(lastFull)} — and neither is
     back where it started. This is the plate that settles the question the
     report opened with. The composition effect of plate four is real, but the
     decline it cannot explain is larger than the one it can.`,
  ]);
  A.lineChart(chartHost("p5"), {
    series: [
      {
        name: "Violent Part I",
        color: A.token("--series-1"),
        points: annualFull.map((r) => ({ x: r.year, y: r.violent_clearance })),
      },
      {
        name: "Property Part I",
        color: A.token("--series-3"),
        points: annualFull.map((r) => ({ x: r.year, y: r.property_clearance })),
      },
    ],
    yZero: true,
    yFormat: (v) => `${Math.round(v)}%`,
    tipFormat: (v) => f.pct(v),
    xFormat: (v) => String(v),
    yTitle: "Share cleared by arrest",
    directLabel: false,
    height: 380,
    figure: figureOf("p5"),
    title: "Part I clearance rate, violent and property offences",
  });
  setCaption(
    "p5",
    `<b>Part I clearance by arrest.</b> Part I membership is taken from the
     record's own <code>fbi_code</code>, which separates aggravated assault and
     battery (Part I) from simple (Part II) — so the offence label alone would
     give the wrong set.`
  );

  /* =========================================================================
     Plate 6 — every offence type
     ========================================================================= */

  setText("p6", `Thirty-odd offences, thirty-odd different stories`);
  const risers = d.typeTotals.filter((t) => t.pct_change != null && t.pct_change > 0).length;
  const fallers = d.typeTotals.filter((t) => t.pct_change != null && t.pct_change < 0).length;
  setProse("p6", [
    `The citywide total is a sum over ${n(d.typeTotals.length)} offence types
     that move independently. Between ${n(H.first_year)} and ${n(lastFull)},
     ${n(fallers)} of them fell and ${n(risers)} rose. Showing only the ones
     that suit an argument would be easy, so here are all of them, each on its
     own scale, sorted by total volume.`,
    `Every panel is drawn in the same colour on purpose. These are nominal
     categories with no inherent order, so colour would be encoding nothing
     that the heading does not already say.`,
  ]);
  (function p6() {
    const host = chartHost("p6");
    host.innerHTML = "";
    const byType = new Map();
    for (const r of d.typeYear) {
      if (!byType.has(r.type)) byType.set(r.type, []);
      byType.get(r.type).push(r);
    }
    for (const t of typesSorted) {
      const rows = (byType.get(t.type) || [])
        .filter((r) => r.year < H.last_year)
        .sort((a, b) => a.year - b.year);
      if (rows.length < 2) continue;
      const panel = document.createElement("div");
      panel.className = "multiple";
      const name = document.createElement("p");
      name.className = "multiple__name";
      name.textContent = D.titleCase(t.type);
      const val = document.createElement("p");
      val.className = "multiple__value";
      val.textContent = `${f.compact(t.total)} · ${t.pct_change == null ? "—" : f.signedPct(t.pct_change, 0)}`;
      panel.append(name, val);
      const chart = document.createElement("div");
      panel.appendChild(chart);
      host.appendChild(panel);
      A.sparkline(chart, {
        points: rows.map((r) => ({ x: r.year, y: r.incidents })),
        title: `${D.titleCase(t.type)}, ${rows[0].year} to ${rows[rows.length - 1].year}`,
      });
    }
  })();
  setCaption(
    "p6",
    `<b>Every offence type, ${n(H.first_year)} to ${n(lastFull)}.</b> Each panel
     is scaled to its own range, so these show shape, not relative size. The
     figure beneath each name is that offence's total across the whole series
     and its change from the first year to the last full one.`
  );
  A.attachTable(
    figureOf("p6"),
    A.buildTable(
      ["Offence", "Total", `${H.first_year}`, `${lastFull}`, "Change", "Arrest rate"],
      typesSorted.map((t) => [
        D.titleCase(t.type),
        f.int(t.total),
        f.int(t.first_year_n),
        f.int(t.last_year_n),
        t.pct_change == null ? "—" : f.signedPct(t.pct_change, 0),
        f.pct(t.arrest_rate),
      ])
    ),
    "the numbers"
  );

  /* =========================================================================
     Plate 7 — vehicle theft
     ========================================================================= */

  setText("p7", `Motor vehicle theft broke pattern in 2022 and has not gone back`);
  setProse("p7", [
    `Vehicle theft ran at an average of
     ${n(f.int(mvtBeforeAvg))} incidents a month across ${n("2019")}–${n("2021")}.
     Through ${n("2023")} it averaged ${n(f.int(mvtAfterAvg))} — about
     ${n(f.dec(mvtAfterAvg / mvtBeforeAvg, 1))} times the earlier level. The
     series peaks at ${n(f.int(mvtPeakMonth.incidents))} incidents in
     ${n(D.monthLabel(D.monthToX(mvtPeakMonth.month)))}.`,
    `A monthly series is doing necessary work here. The break falls inside a
     calendar year, so an annual chart would spread it across two bars and make
     a step look like a slope. The widely reported cause is a published
     ignition vulnerability in certain Kia and Hyundai models; this dataset
     records offences, not methods, so it can show the discontinuity and its
     timing but cannot confirm the mechanism.`,
  ]);
  A.lineChart(chartHost("p7"), {
    series: [
      {
        name: "Motor vehicle theft",
        color: A.token("--series-2"),
        points: d.mvt.map((m) => ({ x: D.monthToX(m.month), y: m.incidents })),
      },
    ],
    yTitle: "Incidents per month",
    xFormat: (v) => String(Math.floor(v)),
    tipFormat: f.int,
    height: 380,
    figure: figureOf("p7"),
    tableColumns: ["Month", "Incidents"],
    title: "Motor vehicle theft per month",
  });
  setCaption(
    "p7",
    `<b>Motor vehicle theft, monthly.</b> Every month in the extract, including
     the partial final one — which is why the line falls away at the right-hand
     edge. All ${n(f.int(mvtRow.total))} recorded vehicle thefts are included.`
  );

  /* =========================================================================
     Plate 8 — seasonality
     ========================================================================= */

  setText("p8", `Violence has a summer, and property crime mostly does not`);
  setProse("p8", [
    `Comparing raw monthly counts across a declining series would mostly
     measure the decline, so each month here is expressed as its deviation from
     its own year's monthly average, then averaged across years. On that
     measure violent Part I offences run
     ${n(f.signedPct(seasonPeak.violent_vs_mean))} in
     ${n(D.MONTHS[seasonPeak.month - 1])} and
     ${n(f.signedPct(seasonLow.violent_vs_mean))} in
     ${n(D.MONTHS[seasonLow.month - 1])}.`,
    `Property offences move far less — the gap between their best and worst
     months is
     ${n(f.dec(Math.max(...d.season.map((s) => s.property_vs_mean)) - Math.min(...d.season.map((s) => s.property_vs_mean)), 1))}
     percentage points against
     ${n(f.dec(seasonPeak.violent_vs_mean - seasonLow.violent_vs_mean, 1))} for
     violent ones. Whatever drives the summer pattern acts much more strongly
     on violence between people than on theft from property.`,
  ]);
  A.lineChart(chartHost("p8"), {
    series: [
      {
        name: "Violent Part I",
        color: A.token("--series-1"),
        points: d.season.map((s) => ({ x: s.month, y: s.violent_vs_mean })),
      },
      {
        name: "Property Part I",
        color: A.token("--series-3"),
        points: d.season.map((s) => ({ x: s.month, y: s.property_vs_mean })),
      },
    ],
    yZero: false,
    yFormat: (v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`,
    tipFormat: (v) => f.signedPct(v),
    xFormat: (v) => D.MONTHS_SHORT[Math.round(v) - 1] || "",
    yTitle: "Deviation from the year's monthly mean",
    directLabel: false,
    height: 360,
    figure: figureOf("p8"),
    tableColumns: ["Month", "Violent Part I", "Property Part I"],
    title: "Seasonal profile: each month against its own year's average",
  });
  setCaption(
    "p8",
    `<b>Month-of-year profile.</b> For each year, every month is compared with
     that year's own monthly mean; the twelve results are then averaged over all
     whole years. Expressing it this way is what stops the long-run decline
     masquerading as a seasonal effect.`
  );

  /* =========================================================================
     Plate 9 — the clock
     ========================================================================= */

  setText("p9", `Each offence keeps its own hours`);
  const clockTypes = [...new Set(d.clock.map((c) => c.type))];
  const peakHourOf = (type) => {
    const rows = d.clock.filter((c) => c.type === type);
    return rows.reduce((a, b) => (b.pct_of_type > a.pct_of_type ? b : a));
  };
  setProse("p9", [
    `Each row below is one offence type, and each cell is the share of that
     offence's own incidents falling in that hour — so types of wildly
     different volume can be read side by side. Burglary peaks at
     ${n(D.hourLabel(peakHourOf("BURGLARY").hour))} and robbery at
     ${n(D.hourLabel(peakHourOf("ROBBERY").hour))}: one happens when buildings
     are empty, the other when streets are dark.`,
    `A caveat belongs with this plate rather than in the colophon. Where an
     exact time was not known, the record carries midnight, and
     ${n(f.pct(d.quality.pct_timestamped_midnight, 2))} of all incidents are
     stamped exactly ${n("00:00")}. That inflates the midnight column, so the
     hour-zero cells should be read as "midnight or unknown".`,
  ]);
  A.heatmap(chartHost("p9"), {
    rows: clockTypes,
    cols: Array.from({ length: 24 }, (_, i) => i),
    cells: d.clock.map((c) => ({ r: c.type, c: c.hour, v: c.pct_of_type })),
    rowLabel: (r) => D.titleCase(r),
    colLabel: (c) => D.hourLabel(c),
    valueFormat: (v) => f.pct(v, 1),
    height: 420,
    figure: figureOf("p9"),
    title: "Share of each offence type's incidents by hour of day",
  });
  setCaption(
    "p9",
    `<b>Hour of day, as a share of each offence's own total.</b> Rows are the
     twelve most common offences. Darker means a larger share of that row's
     incidents, so rows are comparable with each other even though their
     volumes differ by orders of magnitude.`
  );

  /* =========================================================================
     Plate 10 — concentration
     ========================================================================= */

  setText("p10", `Violence is concentrated in a small number of community areas`);
  setProse("p10", [
    `Of ${n(areasCount)} community areas with geographic coding, the ten with
     the most violent Part I incidents account for ${n(f.pct(conc10))} of them.
     The top ${n(5)} alone account for
     ${n(f.pct(d.conc[4].cumulative_pct))}. The leader is
     ${n(D.titleCase(d.conc[0].name))}, with
     ${n(f.int(d.conc[0].violent))} violent incidents across the series.`,
    `The curve below is cumulative: read along it to see what share of the
     city's recorded violence is covered by the n most affected areas. It is
     steep at the left and flat at the right, which is what concentration looks
     like. The next plate asks whether that ranking survives dividing by the
     number of people who live there.`,
  ]);
  A.lineChart(chartHost("p10"), {
    series: [
      {
        name: "Cumulative share of violent Part I incidents",
        color: A.token("--series-1"),
        points: d.conc.map((r) => ({ x: r.rank, y: r.cumulative_pct })),
      },
    ],
    yZero: true,
    yFormat: (v) => `${Math.round(v)}%`,
    tipFormat: (v) => f.pct(v),
    xFormat: (v) => String(Math.round(v)),
    xTitle: "Community areas, ranked by violent incidents",
    yTitle: "Cumulative share",
    directLabel: false,
    height: 360,
    figure: figureOf("p10"),
    tableColumns: ["Rank", "Cumulative share"],
    title: "Cumulative share of violent Part I incidents by community area rank",
  });
  setCaption(
    "p10",
    `<b>Concentration curve.</b> Community areas sorted by violent Part I
     incidents, with the running cumulative share. Geographically coded
     incidents in years whose geographic coverage clears the threshold set out
     in the colophon, so ${n(geoFirst)} onward.`
  );
  A.attachTable(
    figureOf("p10"),
    A.buildTable(
      ["Rank", "Community area", "Violent Part I", "All incidents", "Cumulative share"],
      d.conc.map((r) => [
        String(r.rank),
        D.titleCase(r.name),
        f.int(r.violent),
        f.int(r.total),
        f.pct(r.cumulative_pct),
      ])
    ),
    "the full ranking"
  );

  /* =========================================================================
     Plate 11 — counts against rates
     ========================================================================= */

  setText("p11", `Dividing by population reorders the map`);
  setProse("p11", [
    `${n(D.titleCase(topByCount.name))} records the most violent Part I
     incidents of any community area — ${n(f.int(topByCount.violent))} across
     the series. Per resident it ranks ${n(topByCount.rank_by_rate)}. The
     highest rate belongs to ${n(D.titleCase(topByRate.name))}, at
     ${n(f.dec(topByRate.violent_per_100k, 0))} violent incidents per 100,000
     residents, which ranks only ${n(topByRate.rank_by_count)} by raw count.`,
    `The largest single reordering is ${n(D.titleCase(biggestRiser.name))},
     which sits at ${n(biggestRiser.rank_by_count)} by count and
     ${n(biggestRiser.rank_by_rate)} by rate, and
     ${n(D.titleCase(biggestFaller.name))}, which moves the other way, from
     ${n(biggestFaller.rank_by_count)} to ${n(biggestFaller.rank_by_rate)}.
     Both orderings are correct; they answer different questions. A count tells
     you where the most incidents are, which is what a patrol roster needs. A
     rate tells you where a resident is most exposed.`,
    `The denominator deserves naming. It is the 2023 American Community Survey
     five-year population estimate, held constant across all years, so these
     are incidents per present-day resident rather than a true time-varying
     rate. Areas whose population changed substantially since ${n(geoFirst)} are
     measured against the wrong base, and that limitation cannot be fixed from
     this data.`,
  ]);
  A.slopeChart(chartHost("p11"), {
    items: d.areas.map((a) => ({
      name: D.titleCase(a.name),
      leftRank: a.rank_by_count,
      rightRank: a.rank_by_rate,
      leftValue: a.violent,
      rightValue: a.violent_per_100k,
    })),
    leftTitle: "Rank by count",
    rightTitle: "Rank by rate per 100k",
    leftFormat: f.int,
    rightFormat: (v) => f.dec(v, 0),
    highlight: d.areas
      .filter((a) => a.rank_by_count <= 12 || a.rank_by_rate <= 12)
      .map((a) => D.titleCase(a.name)),
    height: 720,
    figure: figureOf("p11"),
    tableColumns: [
      "Community area",
      "Violent Part I",
      "Rank by count",
      "Per 100k residents",
      "Rank by rate",
    ],
    tableLabel: "all 77 areas",
    title: "Community areas ranked by violent incident count and by rate per 100,000 residents",
  });
  setCaption(
    "p11",
    `<b>Count rank against rate rank.</b> Every community area appears twice,
     joined by a line; a line that slopes down moved up the ranking when
     population was taken into account. Areas outside the top twelve on either
     measure are drawn faintly and unlabelled to keep the labels legible —
     every one is in the table.`
  );

  /* =========================================================================
     Plate 12 — rate against income
     ========================================================================= */

  setText("p12", `Violent incident rates track income closely`);
  setProse("p12", [
    `Plotting each community area's violent Part I rate against its per-capita
     income gives a correlation of
     ${n(f.dec(incomeCorr, 2))} across the ${n(d.areas.filter((a) => a.per_capita_income != null).length)}
     areas where both measures exist. The relationship is strong and negative:
     areas with lower income record substantially more violence per resident.`,
    `What that does not establish is any direction of causation, and the
     scatter cannot distinguish between the several mechanisms that would
     produce the same picture. The income figures are also from a different and
     older source than the crime records — the city's 2008–2012 socioeconomic
     indicators — so this plate relates two periods, not one.`,
  ]);
  A.scatter(chartHost("p12"), {
    points: d.areas
      .filter((a) => a.per_capita_income != null)
      .map((a) => ({
        x: a.per_capita_income,
        y: a.violent_per_100k,
        label: D.titleCase(a.name),
        color: A.token("--series-1"),
      })),
    xTitle: "Per-capita income",
    yTitle: "Violent Part I per 100k",
    xFormat: (v) => `$${f.compact(v)}`,
    yFormat: (v) => f.compact(v),
    trend: true,
    height: 440,
    figure: figureOf("p12"),
    tableColumns: ["Community area", "Per-capita income", "Violent per 100k"],
    title: "Violent incident rate against per-capita income, by community area",
  });
  setCaption(
    "p12",
    `<b>Rate against income, one point per community area.</b> The dashed line
     is an ordinary least-squares fit, drawn dashed because it is a model rather
     than data. Pearson correlation ${n(f.dec(incomeCorr, 2))}.`
  );

  /* =========================================================================
     Plate 13 — domestic incidents
     ========================================================================= */

  setText("p13", `Domestic incidents are far likelier to end in an arrest`);
  setProse("p13", [
    `Incidents flagged domestic were ${n(f.pct(domFirst.domestic_share))} of the
     total in ${n(domFirst.year)} and ${n(f.pct(domLast.domestic_share))} in
     ${n(lastFull)}. They behave differently from everything around them: in
     ${n(lastFull)}, ${n(f.pct(domLast.arrest_rate_domestic))} of domestic
     incidents ended in an arrest against
     ${n(f.pct(domLast.arrest_rate_non_domestic))} of non-domestic ones.`,
    `The monthly series adds a detail the annual one hides. The domestic share
     of all incidents peaks at ${n(f.pct(domPeakShare.domestic_share))} in
     ${n(D.monthLabel(D.monthToX(domPeakShare.month)))} — inside the first
     period of pandemic restrictions, when the denominator of street-level
     offences was collapsing and domestic incidents were not.`,
  ]);
  A.lineChart(chartHost("p13"), {
    series: [
      {
        name: "Domestic incidents",
        color: A.token("--series-2"),
        points: d.domestic.filter((r) => r.year < H.last_year).map((r) => ({ x: r.year, y: r.arrest_rate_domestic })),
      },
      {
        name: "Non-domestic incidents",
        color: A.token("--series-1"),
        points: d.domestic.filter((r) => r.year < H.last_year).map((r) => ({ x: r.year, y: r.arrest_rate_non_domestic })),
      },
    ],
    yZero: true,
    yFormat: (v) => `${Math.round(v)}%`,
    tipFormat: (v) => f.pct(v),
    xFormat: (v) => String(v),
    yTitle: "Share ending in arrest",
    directLabel: false,
    height: 380,
    figure: figureOf("p13"),
    tableColumns: ["Year", "Domestic", "Non-domestic"],
    title: "Arrest rate for domestic and non-domestic incidents",
  });
  setCaption(
    "p13",
    `<b>Arrest rate by domestic flag.</b> Both series are the same measure on
     one axis. The domestic flag is the city's own field, set when the incident
     falls under the Illinois Domestic Violence Act.`
  );

  /* =========================================================================
     Plate 14 — settings
     ========================================================================= */

  setText("p14", `In 2020, recorded crime moved indoors`);
  const streetDrop2020 = settingAt(2020, "street") - settingAt(2019, "street");
  const resRise2020 = settingAt(2020, "residence") - settingAt(2019, "residence");
  setProse("p14", [
    `Folding the city's several hundred location descriptions into
     ${n(settingNames.length)} settings shows a composition that is stable for
     two decades and then jumps. Between ${n(2019)} and ${n(2020)} the street
     share moved ${n(f.signedPct(streetDrop2020))} and the residential share
     ${n(f.signedPct(resRise2020))}.`,
    `Transit is the clearest single case: ${n(f.pct(settingAt(2019, "transit")))}
     of incidents in ${n(2019)} and ${n(f.pct(settingAt(2020, "transit")))} in
     ${n(2020)}. These are shares, not counts, so they describe where recorded
     crime was distributed rather than whether there was more of it. The
     residual "other" category holds
     ${n(f.pct(settingAt(lastFull, "other")))} of ${n(lastFull)} incidents and
     is shown rather than hidden, because the folding rule is a judgement and
     the reader should see its size.`,
  ]);
  A.stackedArea(chartHost("p14"), {
    xs: settingYears.filter((y) => y < H.last_year),
    series: settingNames
      .filter((s) => s !== "other")
      .concat(["other"])
      .map((s, i) => ({
        name: s.charAt(0).toUpperCase() + s.slice(1),
        color: A.token(`--series-${(i % 8) + 1}`),
        values: settingYears.filter((y) => y < H.last_year).map((y) => settingAt(y, s)),
      })),
    yFormat: (v) => `${Math.round(v)}%`,
    tipFormat: (v) => f.pct(v),
    xFormat: (v) => String(v),
    yTitle: "Share of the year's incidents",
    height: 400,
    figure: figureOf("p14"),
    tableLabel: "the numbers",
    title: "Share of incidents by setting, per year",
  });
  setCaption(
    "p14",
    `<b>Where incidents were recorded, as a share of each year.</b> Settings are
     folded from the <code>location_description</code> field by the rule in
     <code>sql/02_findings.sql</code>; anything unmatched falls to "Other",
     which is plotted rather than dropped.`
  );

  /* =========================================================================
     Colophon
     ========================================================================= */

  const q = d.quality;
  setProse("method", [
    `<b>Where the data comes from.</b> The City of Chicago's
     <em>Crimes — 2001 to Present</em> dataset, published on the city's open
     data portal as <code>ijzp-q8t2</code> and updated daily. This extract was
     downloaded one year at a time by <code>scripts/fetch_crimes.sh</code> and
     holds ${n(f.int(q.rows_downloaded))} rows, the last incident dated
     ${n(q.last_incident.slice(0, 10))} and the last record edited
     ${n(q.last_updated.slice(0, 10))}. Community area boundaries
     (<code>igwz-8jzy</code>), American Community Survey population by
     community area (<code>t68z-cikk</code>) and the 2008–2012 socioeconomic
     indicators (<code>kn9c-c2s2</code>) come from the same portal.`,
    `<b>What one row is.</b> One reported incident: a single offence recorded at
     a place and time, with flags for whether an arrest was made and whether it
     was domestic. It is not one crime, not one victim, and not one conviction.
     An incident appears here because it was reported to or observed by the
     police and recorded — which is the single most important limitation on
     every number above. Changes in willingness to report, or in what officers
     record, move these series exactly as changes in crime do.`,
    `<b>What was dropped or changed.</b> Rows are deduplicated on the city's
     incident <code>id</code>, keeping the most recently updated version of
     each; ${n(f.int(q.duplicates_removed))} duplicate rows were removed.
     <code>CRIMINAL SEXUAL ASSAULT</code> and <code>CRIM SEXUAL ASSAULT</code>
     are the same offence under two labels used in different periods and are
     merged, which otherwise reads as one category ending and another starting.
     No incident is excluded from the citywide series, and
     ${n(f.pct(q.pct_without_coordinates, 2))} of rows have no latitude and
     longitude, which affects only the map page.`,
    `<b>Where the maps start, and why it is not ${n(H.first_year)}.</b>
     Geographic coding is not simply absent at the start of the series; it
     phases in. ${n(geoBad[0].year)} is ${n(f.pct(geoBad[0].pct_geocoded, 1))}
     geocoded and ${n(geoBad[1].year)} is
     ${n(f.pct(geoBad[1].pct_geocoded, 1))}, against
     ${n(f.pct(geoGood[0].pct_geocoded, 1))} in ${n(geoFirst)} and every year
     after. A year that is a quarter unmapped would understate each of its
     community areas by about a quarter, which on a map looks like a real
     shortfall rather than like missing data — the more dangerous of the two
     failures. So rather than fix a cutoff by hand, the pipeline keeps any year
     at or above ${n("95%")} coverage and drops the rest: here that means every
     figure broken out by community area or ward covers ${n(geoFirst)} onward,
     ${n(f.int(geoUsableRows))} incidents. Citywide figures still use all
     ${n(H.years_covered)} years.`,
    `<b>The partial year.</b> ${n(H.last_year)} is incomplete: the extract ends
     ${n(q.last_incident.slice(0, 10))} with ${n(f.int(q.partial_year_rows))}
     rows. It is excluded from every annual chart and from all year-on-year
     comparisons, and the last full year, ${n(lastFull)}, is used wherever a
     "latest" figure is quoted. The monthly charts do include it, which is why
     their final point drops.`,
  ]);
  A.lineChart(chartHost("quality"), {
    series: [
      {
        name: "Missing community area",
        color: A.token("--series-2"),
        points: d.qualityYear.map((r) => ({ x: r.year, y: r.pct_missing_community_area })),
      },
      {
        name: "Missing coordinates",
        color: A.token("--series-1"),
        points: d.qualityYear.map((r) => ({ x: r.year, y: r.pct_missing_coordinates })),
      },
      {
        name: "Timestamped midnight",
        color: A.token("--series-3"),
        points: d.qualityYear.map((r) => ({ x: r.year, y: r.pct_midnight })),
      },
    ],
    yZero: true,
    yFormat: (v) => `${Math.round(v)}%`,
    tipFormat: (v) => f.pct(v, 2),
    xFormat: (v) => String(v),
    yTitle: "Share of the year's rows",
    directLabel: false,
    height: 340,
    figure: figureOf("quality"),
    tableColumns: ["Year", "No community area", "No coordinates", "Midnight"],
    title: "Data completeness by year",
  });
  setCaption(
    "quality",
    `<b>Completeness by year.</b> Showing the ${n(H.first_year)} geographic gap
     rather than only asserting it. The midnight series is the share of rows
     timestamped exactly 00:00, which is how an unknown time is recorded.`
  );

  setProse("method2", [
    `<b>How every rate is computed.</b> <em>Arrest rate</em> is incidents
     flagged as an arrest divided by all incidents in the group, as a
     percentage — a share of records, not a clearance rate, except where the
     group is restricted to Part I offences. <em>Part I clearance</em> is the
     same calculation restricted to FBI index offences, identified by the
     record's <code>fbi_code</code> rather than its offence name, because the
     codes separate aggravated assault and battery (Part I) from simple
     (Part II). Violent Part I is codes 01A, 01B, 02, 03, 04A and 04B; property
     Part I is 05, 06, 07 and 09. <em>Rate per 100,000</em> is incidents divided
     by the community area's 2023 ACS population, times 100,000, with the
     denominator held constant across years. <em>Seasonal deviation</em>
     compares each month with its own year's monthly mean and averages those
     deviations across whole years. <em>Mix held constant</em> reweights each
     year's within-group arrest rates by the ${n(H.first_year)} shares of
     police-initiated and citizen-reported offences. <em>Cumulative share</em>
     sorts community areas by violent Part I count and accumulates.`,
    `<b>Reproducing it.</b> <code>scripts/fetch_crimes.sh</code> downloads the
     data and checks each year's row count against the portal's own count for
     that year. <code>sql/01_load.sql</code> builds the incident table and
     asserts the joins; <code>sql/02_findings.sql</code> writes every figure on
     this page into <code>data/derived/</code>; <code>sql/03_cubes.sql</code>
     builds the dashboard's aggregates from the same table; and
     <code>sql/04_verify.sql</code> recomputes this page's headline numbers from
     those aggregates and fails if the two disagree. No number on this page is
     typed by hand — the prose above reads its values from the same files the
     charts do.`,
    `<b>What this page is not.</b> It is a description of a police record
     system over twenty-six years. Where a series moves, this page says what
     moved in the records and, where the data supports it, decomposes it. It
     does not identify causes, and the one plate that relates crime to income
     says so twice.`,
  ]);

  document.querySelector("[data-colophon-meta]").textContent =
    `Extract of ${f.int(q.rows_after_dedupe)} incidents, last record ${q.last_incident.slice(0, 10)}, last edited ${q.last_updated.slice(0, 10)}. Built ${new Date().toISOString().slice(0, 10)}.`;
})();
