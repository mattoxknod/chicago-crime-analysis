/* ===========================================================================
   atlas-data.js — loading and shared helpers for both pages.
   ---------------------------------------------------------------------------
   Both pages read the same files out of data/derived/, which are written by
   sql/02_findings.sql and sql/03_cubes.sql from the same `crimes` table. That
   shared origin is what keeps the report and the dashboard from quoting
   different numbers for the same thing.
   =========================================================================== */

const AtlasData = (() => {
  "use strict";

  const BASE = "data/derived/";
  const cache = new Map();

  async function json(name) {
    if (!cache.has(name)) {
      cache.set(
        name,
        fetch(`${BASE}${name}`).then((r) => {
          if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
          return r.json();
        })
      );
    }
    return cache.get(name);
  }

  /* DuckDB's JSON export always writes an array, even for a single row. */
  async function one(name) {
    const rows = await json(name);
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async function all(names) {
    const out = {};
    await Promise.all(
      Object.entries(names).map(async ([key, file]) => {
        out[key] = await json(file);
      })
    );
    return out;
  }

  /* --- Small helpers used by both pages ---------------------------------- */

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  /* Offence names are stored upper-case. Title case reads better in prose and
     in chart labels, with the abbreviations the city uses left intact. */
  const KEEP_UPPER = new Set(["CTA", "ATM", "DUI"]);
  function titleCase(s) {
    if (s == null) return "";
    return String(s)
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\b(Cta|Atm|Dui)\b/g, (m) => m.toUpperCase())
      .replace(/\bCrim\b/, "Criminal");
  }
  void KEEP_UPPER;

  /* An hour as a clock label: 0 -> 12a, 13 -> 1p. */
  const hourLabel = (h) =>
    h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;

  /* "2026-11-11" -> a Date in local time, avoiding the UTC shift that
     new Date("2026-11-11") applies. */
  function parseDate(s) {
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  /* A month string to a fractional year, so monthly series can share the
     numeric x-axis the line chart uses for annual ones. */
  function monthToX(s) {
    const d = parseDate(s);
    return d.getFullYear() + d.getMonth() / 12;
  }

  const monthLabel = (x) => {
    const y = Math.floor(x);
    const m = Math.round((x - y) * 12);
    return `${MONTHS_SHORT[m]} ${y}`;
  };

  /* Index a series to 100 at its first value. The honest way to put two
     measures of different scale on one axis. */
  function indexTo100(values) {
    const base = values.find((v) => v != null && v !== 0);
    return values.map((v) => (v == null || !base ? null : (v / base) * 100));
  }

  /* Pearson correlation, for the scatter section. */
  function correlation(xs, ys) {
    const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => a != null && b != null);
    const n = pairs.length;
    if (n < 3) return null;
    const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
    const my = pairs.reduce((s, p) => s + p[1], 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (const [a, b] of pairs) {
      num += (a - mx) * (b - my);
      dx += (a - mx) ** 2;
      dy += (b - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
  }

  /* --- Page furniture ---------------------------------------------------- */

  /* Writes the shared masthead, so the nav exists once in code rather than
     being copied between two files and drifting. */
  function masthead(current) {
    const pages = [
      { href: "index.html", label: "Report", key: "report" },
      { href: "dashboard.html", label: "Dashboard", key: "dashboard" },
      { href: "map.html", label: "Map", key: "map" },
    ];
    const host = document.querySelector("[data-masthead]");
    if (!host) return;
    host.className = "masthead";
    host.innerHTML = `
      <div class="wrap masthead__inner">
        <p class="masthead__title"><a href="index.html">Chicago, Reported</a></p>
        <nav class="masthead__nav" aria-label="Pages">
          ${pages
            .map(
              (p) =>
                `<a href="${p.href}"${p.key === current ? ' aria-current="page"' : ""}>${p.label}</a>`
            )
            .join("")}
        </nav>
      </div>`;
  }

  function fail(host, err) {
    console.error(err);
    const p = document.createElement("p");
    p.style.color = "var(--series-8)";
    p.textContent = `Could not load the data for this section (${err.message}). The site reads data/derived/, which sql/02_findings.sql writes.`;
    host.appendChild(p);
  }

  return {
    json,
    one,
    all,
    MONTHS,
    MONTHS_SHORT,
    DAYS,
    titleCase,
    hourLabel,
    parseDate,
    monthToX,
    monthLabel,
    indexTo100,
    correlation,
    masthead,
    fail,
  };
})();
