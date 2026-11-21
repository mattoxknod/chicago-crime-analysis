/* ===========================================================================
   atlas-charts.js — the chart library for both pages.
   ---------------------------------------------------------------------------
   Deliberately dependency-free. The scales here are a dozen lines each, and
   Chicago spans about a third of a degree of longitude, so a cosine-scaled
   equirectangular projection is accurate to well under a pixel at the sizes
   these maps draw at. Vendoring a plotting library would be more code shipped
   to the reader, not less.

   Conventions every renderer in this file follows, which come from the chart
   rules this project was built against:

     - 2px lines, >=8px markers, a 2px surface gap between adjacent or stacked
       fills, a 2px surface ring on overlapping marks.
     - Hairline axes and grid, one shade off the surface, always solid. Dashing
       is reserved for annotations, where it means "this is not data".
     - A legend whenever there are two or more series; never for one, because
       the title names it.
     - Direct labels selectively — an endpoint or an extreme — never a number
       on every point.
     - Every chart gets a table twin, so no value is reachable only by hover.
     - Text wears ink tokens, never a series colour.
     - One y-axis, ever. Two measures of different scale become two charts or
       get indexed to a common base.
   =========================================================================== */

const Atlas = (() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /* --- Number formatting ------------------------------------------------- */

  const fmt = {
    int: (n) => (n == null || Number.isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US")),
    dec: (n, d = 1) =>
      n == null || Number.isNaN(n)
        ? "—"
        : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }),
    pct: (n, d = 1) => (n == null || Number.isNaN(n) ? "—" : `${fmt.dec(n, d)}%`),
    signedPct: (n, d = 1) =>
      n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${fmt.dec(n, d)}%`,
    /* Axis ticks want to stay short: 1.8M, 240k, 1,200. */
    compact: (n) => {
      if (n == null || Number.isNaN(n)) return "—";
      const a = Math.abs(n);
      if (a >= 1e6) return `${fmt.dec(n / 1e6, a >= 1e7 ? 0 : 1)}M`;
      if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
      if (a >= 1e3) return Math.round(n).toLocaleString("en-US");
      return fmt.dec(n, Number.isInteger(n) ? 0 : 1);
    },
  };

  /* --- Scales ------------------------------------------------------------- */

  function linear(domain, range) {
    let [d0, d1] = domain;
    const [r0, r1] = range;
    if (d0 === d1) {
      d0 -= 0.5;
      d1 += 0.5;
    }
    const m = (r1 - r0) / (d1 - d0);
    const s = (v) => r0 + (v - d0) * m;
    s.invert = (p) => d0 + (p - r0) / m;
    s.domain = [d0, d1];
    s.range = [r0, r1];
    return s;
  }

  function band(values, range, padding = 0.18) {
    const [r0, r1] = range;
    const step = (r1 - r0) / Math.max(values.length, 1);
    const w = step * (1 - padding);
    const index = new Map(values.map((v, i) => [v, i]));
    const s = (v) => r0 + index.get(v) * step + (step - w) / 2;
    s.bandwidth = () => w;
    s.step = () => step;
    s.center = (v) => s(v) + w / 2;
    s.values = values;
    /* Which band does a pixel fall in — used by the hover layer. */
    s.invert = (p) => values[Math.max(0, Math.min(values.length - 1, Math.floor((p - r0) / step)))];
    return s;
  }

  /* Axis ticks on round numbers, at most `count` of them. */
  function niceTicks(min, max, count = 5) {
    if (min === max) return [min];
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const stepMul = norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1;
    const step = stepMul * mag;
    const out = [];
    for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
      out.push(Math.abs(t) < step * 1e-9 ? 0 : +t.toFixed(10));
    }
    return out;
  }

  /* A y-domain that starts at zero for counts, and is padded for rates that
     never approach zero — truncating a bar axis would misstate magnitude, but
     a line chart of a rate between 11% and 31% should not waste 11 units. */
  function yDomain(values, { zero = true, pad = 0.08 } = {}) {
    const vals = values.filter((v) => v != null && !Number.isNaN(v));
    if (!vals.length) return [0, 1];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (zero) lo = Math.min(0, lo);
    const span = hi - lo || Math.abs(hi) || 1;
    if (!zero) lo -= span * pad;
    hi += span * pad;
    return [lo, hi];
  }

  /* --- Element helpers ---------------------------------------------------- */

  function el(name, attrs = {}, parent = null) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      node.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function text(parent, str, attrs = {}) {
    const t = el("text", attrs, parent);
    t.textContent = str;
    return t;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* Read a palette token so JS never hard-codes a hex that CSS owns. */
  const tokenCache = new Map();
  function token(name) {
    if (!tokenCache.has(name)) {
      tokenCache.set(
        name,
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#000"
      );
    }
    return tokenCache.get(name);
  }

  const SERIES = (i) => token(`--series-${(i % 8) + 1}`);
  const SEQ = [3, 4, 5, 6, 7].map((i) => token(`--seq-${i}`));
  const DIVERGING = [
    token("--div-cool-3"),
    token("--div-cool-2"),
    token("--div-cool-1"),
    token("--div-mid"),
    token("--div-warm-1"),
    token("--div-warm-2"),
    token("--div-warm-3"),
  ];

  /* --- Tooltip ------------------------------------------------------------ */
  /* One shared node for the whole page. Tooltips enhance; they never gate a
     value, which is what the table twins are for. */

  let tipNode = null;
  function tooltip() {
    if (!tipNode) {
      tipNode = document.createElement("div");
      tipNode.className = "tooltip";
      tipNode.setAttribute("role", "status");
      document.body.appendChild(tipNode);
    }
    return tipNode;
  }

  function showTip(html, clientX, clientY) {
    const t = tooltip();
    t.innerHTML = html;
    t.dataset.visible = "true";
    /* Position against the document so page scroll does not detach it. */
    t.style.left = `${clientX + window.scrollX}px`;
    t.style.top = `${clientY + window.scrollY}px`;
  }

  function hideTip() {
    if (tipNode) tipNode.dataset.visible = "false";
  }

  /* --- Table twins -------------------------------------------------------- */

  function buildTable(columns, rows, caption) {
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "data";
    if (caption) {
      const cap = document.createElement("caption");
      cap.textContent = caption;
      table.appendChild(cap);
    }
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const c of columns) {
      const th = document.createElement("th");
      th.textContent = c;
      th.scope = "col";
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      r.forEach((cell, i) => {
        const td = document.createElement(i === 0 ? "th" : "td");
        if (i === 0) td.scope = "row";
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    return scroll;
  }

  /* Wires up a "show the numbers" toggle that swaps a chart for its table. */
  function attachTable(figure, tableEl, label = "the numbers") {
    const chartBox = figure.querySelector(".figure__frame");
    if (!chartBox) return;
    let tools = figure.querySelector(".figure__tools");
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "figure__tools";
      const caption = figure.querySelector(".figure__caption");
      if (caption) caption.after(tools);
      else figure.appendChild(tools);
    }
    const holder = document.createElement("div");
    holder.hidden = true;
    holder.appendChild(tableEl);
    chartBox.after(holder);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "figure__toggle";
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = `Show ${label}`;
    btn.addEventListener("click", () => {
      const open = holder.hidden;
      holder.hidden = !open;
      chartBox.hidden = open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Show the chart" : `Show ${label}`;
    });
    tools.appendChild(btn);
  }

  /* --- Legend ------------------------------------------------------------- */

  function legend(series) {
    const ul = document.createElement("ul");
    ul.className = "legend";
    for (const s of series) {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "legend__swatch";
      sw.style.backgroundColor = s.color;
      li.appendChild(sw);
      li.appendChild(document.createTextNode(s.name));
      ul.appendChild(li);
    }
    return ul;
  }

  /* --- Chart frame -------------------------------------------------------- */

  const DEFAULT_MARGIN = { top: 18, right: 24, bottom: 34, left: 54 };

  function frame(host, { width = 820, height = 360, margin = {}, title } = {}) {
    const m = { ...DEFAULT_MARGIN, ...margin };
    clear(host);
    const svg = el("svg", {
      class: "chart",
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
    });
    if (title) {
      const t = el("title", {}, svg);
      t.textContent = title;
    }
    host.appendChild(svg);
    const plot = {
      svg,
      m,
      width,
      height,
      iw: width - m.left - m.right,
      ih: height - m.top - m.bottom,
      g: el("g", { transform: `translate(${m.left},${m.top})` }, svg),
    };
    return plot;
  }

  function yAxis(plot, y, { ticks, format = fmt.compact, title: axisTitle } = {}) {
    const tv = ticks || niceTicks(y.domain[0], y.domain[1], 5);
    const grid = el("g", { class: "grid" }, plot.g);
    const axis = el("g", { class: "axis" }, plot.g);
    for (const t of tv) {
      const yy = Math.round(y(t)) + 0.5;
      el("line", { x1: 0, x2: plot.iw, y1: yy, y2: yy }, grid);
      text(axis, format(t), { x: -8, y: yy, "text-anchor": "end", "dominant-baseline": "middle" });
    }
    if (axisTitle) {
      text(plot.g, axisTitle, {
        class: "axis-title",
        x: 0,
        y: -8,
        "text-anchor": "start",
      });
    }
    return tv;
  }

  function xAxisBand(plot, x, { everyNth = 1, rotate = false, format = (d) => d } = {}) {
    const axis = el("g", { class: "axis" }, plot.g);
    el("line", { x1: 0, x2: plot.iw, y1: plot.ih + 0.5, y2: plot.ih + 0.5 }, axis);
    x.values.forEach((v, i) => {
      if (i % everyNth !== 0) return;
      const cx = x.center(v);
      if (rotate) {
        const t = text(axis, format(v), {
          x: 0,
          y: 0,
          "text-anchor": "end",
          transform: `translate(${cx},${plot.ih + 8}) rotate(-42)`,
          "dominant-baseline": "middle",
        });
        t.setAttribute("dx", "-2");
      } else {
        text(axis, format(v), {
          x: cx,
          y: plot.ih + 16,
          "text-anchor": "middle",
        });
      }
    });
  }

  function xAxisLinear(plot, x, { ticks, format = fmt.compact, title: axisTitle } = {}) {
    const tv = ticks || niceTicks(x.domain[0], x.domain[1], 6);
    const axis = el("g", { class: "axis" }, plot.g);
    el("line", { x1: 0, x2: plot.iw, y1: plot.ih + 0.5, y2: plot.ih + 0.5 }, axis);
    for (const t of tv) {
      const xx = x(t);
      if (xx < -1 || xx > plot.iw + 1) continue;
      text(axis, format(t), { x: xx, y: plot.ih + 16, "text-anchor": "middle" });
    }
    if (axisTitle) {
      text(plot.g, axisTitle, {
        class: "axis-title",
        x: plot.iw,
        y: plot.ih + 30,
        "text-anchor": "end",
      });
    }
    return tv;
  }

  /* --- Line chart --------------------------------------------------------- */
  /* series: [{ name, color, points: [{x, y}] }]
     x is numeric (a year, or a month index). One y-axis, always. */

  function lineChart(host, opts) {
    const {
      series,
      height = 360,
      width = 820,
      margin,
      yZero = true,
      yFormat = fmt.compact,
      tipFormat = fmt.int,
      xFormat = (v) => String(v),
      yTitle,
      xTitle,
      annotations = [],
      directLabel = true,
      title,
      figure,
      tableColumns,
      tableLabel,
    } = opts;

    const plot = frame(host, { width, height, margin, title });
    const allX = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
    const allY = series.flatMap((s) => s.points.map((p) => p.y));

    const x = linear([allX[0], allX[allX.length - 1]], [0, plot.iw]);
    const y = linear(yDomain(allY, { zero: yZero }), [plot.ih, 0]);

    yAxis(plot, y, { format: yFormat, title: yTitle });
    xAxisLinear(plot, x, {
      ticks: niceTicks(allX[0], allX[allX.length - 1], Math.min(8, allX.length)).filter(
        (t) => Number.isInteger(t)
      ),
      format: xFormat,
      title: xTitle,
    });

    /* Annotations sit under the data: they are context, not the subject. */
    for (const a of annotations) {
      const gA = el("g", { class: "annotation" }, plot.g);
      const ax = x(a.x);
      el("line", { x1: ax, x2: ax, y1: 0, y2: plot.ih }, gA);
      const t = text(gA, a.label, {
        x: ax + (a.align === "left" ? -6 : 6),
        y: a.y != null ? y(a.y) : 12,
        "text-anchor": a.align === "left" ? "end" : "start",
      });
      t.setAttribute("dominant-baseline", "middle");
    }

    for (const [i, s] of series.entries()) {
      const color = s.color || SERIES(i);
      const pts = s.points.filter((p) => p.y != null && !Number.isNaN(p.y));
      if (!pts.length) continue;
      const d = pts.map((p, j) => `${j ? "L" : "M"}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`).join("");
      el("path", { class: "line", d, stroke: color }, plot.g);

      /* Selective direct labels: the last point of each series, and only when
         there are few enough series that the labels will not collide. */
      if (directLabel && series.length <= 4) {
        const last = pts[pts.length - 1];
        const label = text(plot.g, s.name, {
          class: "mark-label",
          x: x(last.x) - 4,
          y: y(last.y) - 9,
          "text-anchor": "end",
        });
        label.setAttribute("fill", "var(--ink)");
      }
    }

    /* Hover layer: one overlay for the whole plot, snapping to the nearest x.
       The hit area is the entire plot, so there is no pinpoint target. */
    const focus = el("g", { opacity: 0 }, plot.g);
    const crosshair = el(
      "line",
      { y1: 0, y2: plot.ih, stroke: token("--rule-strong"), "stroke-width": 1 },
      focus
    );
    const dots = series.map((s, i) =>
      el(
        "circle",
        { r: 4.5, fill: s.color || SERIES(i), stroke: token("--leaf"), "stroke-width": 2 },
        focus
      )
    );

    let activeIndex = null;
    const setActive = (idx, clientX, clientY) => {
      if (idx == null || idx < 0 || idx >= allX.length) return;
      activeIndex = idx;
      const xv = allX[idx];
      focus.setAttribute("opacity", 1);
      crosshair.setAttribute("x1", x(xv));
      crosshair.setAttribute("x2", x(xv));
      const rows = [];
      series.forEach((s, i) => {
        const p = s.points.find((q) => q.x === xv);
        if (!p || p.y == null) {
          dots[i].setAttribute("opacity", 0);
          return;
        }
        dots[i].setAttribute("opacity", 1);
        dots[i].setAttribute("cx", x(xv));
        dots[i].setAttribute("cy", y(p.y));
        rows.push(
          `<span class="tooltip__key">${s.name}</span> <b>${(s.tipFormat || tipFormat)(p.y)}</b>`
        );
      });
      const box = plot.svg.getBoundingClientRect();
      const px = clientX != null ? clientX : box.left + (x(xv) / plot.width) * box.width;
      const py = clientY != null ? clientY : box.top + box.height / 2;
      showTip(`<b>${xFormat(xv)}</b><br>${rows.join("<br>")}`, px, py);
    };

    const overlay = el(
      "rect",
      { x: 0, y: 0, width: plot.iw, height: plot.ih, fill: "transparent", cursor: "crosshair" },
      plot.g
    );
    overlay.addEventListener("mousemove", (ev) => {
      const box = plot.svg.getBoundingClientRect();
      const localX = ((ev.clientX - box.left) / box.width) * plot.width - plot.m.left;
      const xv = x.invert(localX);
      let best = 0;
      let bestD = Infinity;
      allX.forEach((v, i) => {
        const d = Math.abs(v - xv);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      setActive(best, ev.clientX, ev.clientY);
    });
    overlay.addEventListener("mouseleave", () => {
      focus.setAttribute("opacity", 0);
      hideTip();
    });

    /* Keyboard parity with hover: arrow keys step along the series. */
    plot.svg.setAttribute("tabindex", "0");
    plot.svg.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      ev.preventDefault();
      const next =
        activeIndex == null ? 0 : activeIndex + (ev.key === "ArrowRight" ? 1 : -1);
      setActive(Math.max(0, Math.min(allX.length - 1, next)));
    });
    plot.svg.addEventListener("blur", () => {
      focus.setAttribute("opacity", 0);
      hideTip();
    });

    if (series.length >= 2) host.prepend(legend(series.map((s, i) => ({ name: s.name, color: s.color || SERIES(i) }))));

    if (figure) {
      const cols = tableColumns || [xTitle || "Period", ...series.map((s) => s.name)];
      const rows = allX.map((xv) => [
        xFormat(xv),
        ...series.map((s) => {
          const p = s.points.find((q) => q.x === xv);
          return p && p.y != null ? (s.tipFormat || tipFormat)(p.y) : "—";
        }),
      ]);
      attachTable(figure, buildTable(cols, rows), tableLabel);
    }
    return plot;
  }

  /* --- Bar chart ---------------------------------------------------------- */
  /* Nominal categories take one hue (slot 1) unless a bar names its own.
     Horizontal when labels are long, which for 36 offence names is always. */

  function barChart(host, opts) {
    const {
      bars,
      horizontal = false,
      width = 820,
      height = 360,
      margin,
      valueFormat = fmt.int,
      axisFormat = fmt.compact,
      color,
      title,
      figure,
      tableColumns,
      tableLabel,
      valueTitle,
    } = opts;

    const m = horizontal ? { left: 150, right: 56, top: 10, bottom: 30, ...(margin || {}) } : margin;
    const plot = frame(host, { width, height, margin: m, title });
    const labels = bars.map((b) => b.label);
    const values = bars.map((b) => b.value);
    const baseColor = color || SERIES(0);
    /* 4px rounded data-ends, anchored to the baseline: only the far corners
       are rounded, so the bar still reads as starting at zero. */
    const R = 4;

    /* Category labels sit in the left margin, and a label longer than that
       margin overflows the SVG and gets clipped by whatever contains it —
       losing the start or end of a word with no indication. So they are
       truncated to what actually fits, measured against the mono's advance
       width, with the full text still reachable in the tooltip and the table.
       The mono renders at 0.66rem; its advance is 0.6em, so ~6.3px a
       character. */
    const CHAR_W = 6.3;
    const truncate = (s, px) => {
      const max = Math.floor(px / CHAR_W);
      const str = String(s);
      return str.length <= max ? str : `${str.slice(0, Math.max(1, max - 1))}…`;
    };

    if (horizontal) {
      const yb = band(labels, [0, plot.ih], 0.22);
      const labelRoom = plot.m.left - 12;
      const x = linear([Math.min(0, ...values), Math.max(0, ...values) * 1.02], [0, plot.iw]);
      const grid = el("g", { class: "grid" }, plot.g);
      for (const t of niceTicks(x.domain[0], x.domain[1], 5)) {
        const xx = Math.round(x(t)) + 0.5;
        el("line", { x1: xx, x2: xx, y1: 0, y2: plot.ih }, grid);
        text(plot.g, axisFormat(t), { x: xx, y: plot.ih + 16, "text-anchor": "middle" });
      }
      const x0 = x(0);
      bars.forEach((b) => {
        const w = Math.abs(x(b.value) - x0);
        const bw = yb.bandwidth();
        const yy = yb(b.label);
        const neg = b.value < 0;
        const left = neg ? x(b.value) : x0;
        const rr = Math.min(R, w);
        /* Path instead of <rect> so only the data end is rounded. */
        const d = neg
          ? `M${left + rr},${yy} h${w - rr} v${bw} h${-(w - rr)} a${rr},${rr} 0 0 1 ${-rr},${-rr} v${-(bw - 2 * rr)} a${rr},${rr} 0 0 1 ${rr},${-rr} z`
          : `M${left},${yy} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${bw - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(w - rr)} z`;
        el("path", { class: "bar", d, fill: b.color || baseColor }, plot.g);
        const labelNode = text(plot.g, truncate(b.label, labelRoom), {
          x: -8,
          y: yy + bw / 2,
          "text-anchor": "end",
          "dominant-baseline": "middle",
        });
        if (String(b.label).length * CHAR_W > labelRoom) {
          const t = el("title", {}, labelNode);
          t.textContent = b.label;
        }
        /* Value at the bar end, outside the mark, so it is never clipped. */
        text(plot.g, valueFormat(b.value), {
          class: "mark-label",
          x: (neg ? left : left + w) + (neg ? -6 : 6),
          y: yy + bw / 2,
          "text-anchor": neg ? "end" : "start",
          "dominant-baseline": "middle",
        });
        /* Hit area spans the full row and clears the 24px minimum. */
        const hit = el(
          "rect",
          { x: 0, y: yy - (yb.step() - bw) / 2, width: plot.iw, height: Math.max(yb.step(), 24), fill: "transparent" },
          plot.g
        );
        hit.addEventListener("mousemove", (ev) =>
          showTip(`<b>${b.label}</b><br>${valueFormat(b.value)}`, ev.clientX, ev.clientY)
        );
        hit.addEventListener("mouseleave", hideTip);
      });
    } else {
      const xb = band(labels, [0, plot.iw], 0.2);
      const y = linear(yDomain(values, { zero: true }), [plot.ih, 0]);
      yAxis(plot, y, { format: axisFormat, title: valueTitle });
      xAxisBand(plot, xb, { rotate: labels.some((l) => String(l).length > 4) });
      const y0 = y(0);
      bars.forEach((b) => {
        const h = Math.abs(y(b.value) - y0);
        const bw = xb.bandwidth();
        const xx = xb(b.label);
        const top = b.value < 0 ? y0 : y(b.value);
        const rr = Math.min(R, h, bw / 2);
        const d =
          b.value < 0
            ? `M${xx},${top} h${bw} v${h - rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(bw - 2 * rr)} a${rr},${rr} 0 0 1 ${-rr},${-rr} z`
            : `M${xx},${top + rr} a${rr},${rr} 0 0 1 ${rr},${-rr} h${bw - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} h${-bw} z`;
        el("path", { class: "bar", d, fill: b.color || baseColor }, plot.g);
        const hit = el(
          "rect",
          { x: xb(b.label) - (xb.step() - bw) / 2, y: 0, width: Math.max(xb.step(), 24), height: plot.ih, fill: "transparent" },
          plot.g
        );
        hit.addEventListener("mousemove", (ev) =>
          showTip(`<b>${b.label}</b><br>${valueFormat(b.value)}`, ev.clientX, ev.clientY)
        );
        hit.addEventListener("mouseleave", hideTip);
      });
    }

    if (figure) {
      attachTable(
        figure,
        buildTable(tableColumns || ["Category", "Value"], bars.map((b) => [b.label, valueFormat(b.value)])),
        tableLabel
      );
    }
    return plot;
  }

  /* --- Stacked area ------------------------------------------------------- */
  /* For share-of-total over time. Capped at the adjacent-pair palette, with a
     2px surface gap between segments rather than a border. */

  function stackedArea(host, opts) {
    const {
      xs,
      series,
      width = 820,
      height = 360,
      margin,
      yFormat = (v) => `${Math.round(v)}%`,
      xFormat = (v) => String(v),
      tipFormat = fmt.pct,
      title,
      figure,
      tableLabel,
      yTitle,
    } = opts;

    const plot = frame(host, { width, height, margin, title });
    const x = linear([xs[0], xs[xs.length - 1]], [0, plot.iw]);
    const totals = xs.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] || 0), 0));
    const y = linear([0, Math.max(...totals) * 1.02], [plot.ih, 0]);

    yAxis(plot, y, { format: yFormat, title: yTitle });
    xAxisLinear(plot, x, {
      ticks: niceTicks(xs[0], xs[xs.length - 1], 8).filter((t) => Number.isInteger(t)),
      format: xFormat,
    });

    const baselines = xs.map(() => 0);
    series.forEach((s, i) => {
      const color = s.color || SERIES(i);
      const top = xs.map((_, j) => baselines[j] + (s.values[j] || 0));
      const up = xs.map((xv, j) => `${j ? "L" : "M"}${x(xv).toFixed(2)},${y(top[j]).toFixed(2)}`);
      const down = xs
        .map((xv, j) => ({ xv, j }))
        .reverse()
        .map(({ xv, j }) => `L${x(xv).toFixed(2)},${y(baselines[j]).toFixed(2)}`);
      el(
        "path",
        {
          d: `${up.join("")}${down.join("")}Z`,
          fill: color,
          stroke: token("--leaf"),
          "stroke-width": 2,
        },
        plot.g
      );
      xs.forEach((_, j) => (baselines[j] = top[j]));
    });

    host.prepend(legend(series.map((s, i) => ({ name: s.name, color: s.color || SERIES(i) }))));

    /* Shared hover: report every segment at the hovered period. */
    const overlay = el(
      "rect",
      { x: 0, y: 0, width: plot.iw, height: plot.ih, fill: "transparent", cursor: "crosshair" },
      plot.g
    );
    overlay.addEventListener("mousemove", (ev) => {
      const box = plot.svg.getBoundingClientRect();
      const localX = ((ev.clientX - box.left) / box.width) * plot.width - plot.m.left;
      const xv = x.invert(localX);
      let idx = 0;
      let bd = Infinity;
      xs.forEach((v, i) => {
        const d = Math.abs(v - xv);
        if (d < bd) {
          bd = d;
          idx = i;
        }
      });
      const rows = series
        .map(
          (s, i) =>
            `<span class="tooltip__key">${s.name}</span> <b>${tipFormat(s.values[idx])}</b>`
        )
        .reverse();
      showTip(`<b>${xFormat(xs[idx])}</b><br>${rows.join("<br>")}`, ev.clientX, ev.clientY);
    });
    overlay.addEventListener("mouseleave", hideTip);

    if (figure) {
      attachTable(
        figure,
        buildTable(
          ["Period", ...series.map((s) => s.name)],
          xs.map((xv, i) => [xFormat(xv), ...series.map((s) => tipFormat(s.values[i]))])
        ),
        tableLabel
      );
    }
    return plot;
  }

  /* --- Heatmap ------------------------------------------------------------ */
  /* Sequential magnitude: one hue, light to dark, with a scale legend. */

  function heatmap(host, opts) {
    const {
      rows,
      cols,
      cells,
      width = 820,
      height = 360,
      margin,
      rowLabel = (r) => r,
      colLabel = (c) => c,
      valueFormat = fmt.dec,
      title,
      figure,
      tableLabel,
      ramp = SEQ,
    } = opts;

    const m = { left: 76, right: 20, top: 10, bottom: 34, ...(margin || {}) };
    const plot = frame(host, { width, height, margin: m, title });
    const xb = band(cols, [0, plot.iw], 0);
    const yb = band(rows, [0, plot.ih], 0);
    const values = cells.map((c) => c.v).filter((v) => v != null);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const colorOf = (v) => {
      if (v == null) return token("--rule");
      const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
      return ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
    };

    const byKey = new Map(cells.map((c) => [`${c.r}|${c.c}`, c.v]));
    for (const r of rows) {
      for (const c of cols) {
        const v = byKey.get(`${r}|${c}`);
        /* 2px surface gap between cells rather than a stroke border. */
        const cell = el(
          "rect",
          {
            x: xb(c) + 1,
            y: yb(r) + 1,
            width: Math.max(xb.bandwidth() - 2, 1),
            height: Math.max(yb.bandwidth() - 2, 1),
            fill: colorOf(v),
            rx: 1,
          },
          plot.g
        );
        cell.addEventListener("mousemove", (ev) =>
          showTip(
            `<b>${rowLabel(r)} · ${colLabel(c)}</b><br>${v == null ? "no data" : valueFormat(v)}`,
            ev.clientX,
            ev.clientY
          )
        );
        cell.addEventListener("mouseleave", hideTip);
      }
    }

    const axis = el("g", { class: "axis" }, plot.g);
    rows.forEach((r) =>
      text(axis, rowLabel(r), {
        x: -8,
        y: yb.center(r),
        "text-anchor": "end",
        "dominant-baseline": "middle",
      })
    );
    cols.forEach((c, i) => {
      if (cols.length > 14 && i % 2) return;
      text(axis, colLabel(c), { x: xb.center(c), y: plot.ih + 16, "text-anchor": "middle" });
    });

    host.prepend(rampLegend(ramp, lo, hi, valueFormat));

    if (figure) {
      attachTable(
        figure,
        buildTable(
          ["", ...cols.map(colLabel)],
          rows.map((r) => [
            rowLabel(r),
            ...cols.map((c) => {
              const v = byKey.get(`${r}|${c}`);
              return v == null ? "—" : valueFormat(v);
            }),
          ])
        ),
        tableLabel
      );
    }
    return plot;
  }

  /* A scale legend for any sequential or binned ramp. */
  function rampLegend(ramp, lo, hi, format = fmt.compact, labels = null) {
    const wrap = document.createElement("ul");
    wrap.className = "legend";
    ramp.forEach((c, i) => {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "legend__swatch";
      sw.style.backgroundColor = c;
      li.appendChild(sw);
      const lab =
        labels
          ? labels[i]
          : i === 0
            ? format(lo)
            : i === ramp.length - 1
              ? format(hi)
              : "";
      if (lab) li.appendChild(document.createTextNode(lab));
      wrap.appendChild(li);
    });
    return wrap;
  }

  /* --- Sparkline ---------------------------------------------------------- */
  /* For the small-multiples grid. Nominal panels, so every one is slot 1. */

  function sparkline(host, opts) {
    const { points, width = 150, height = 42, color = SERIES(0), yZero = true, title } = opts;
    const plot = frame(host, {
      width,
      height,
      margin: { top: 4, right: 4, bottom: 4, left: 4 },
      title,
    });
    const xs = points.map((p) => p.x);
    const x = linear([Math.min(...xs), Math.max(...xs)], [0, plot.iw]);
    const y = linear(yDomain(points.map((p) => p.y), { zero: yZero, pad: 0.12 }), [plot.ih, 0]);
    const d = points
      .map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`)
      .join("");
    /* A whisper-weight fill under the line gives the panel a readable shape at
       this size without adding a second encoding. */
    el(
      "path",
      {
        d: `${d}L${x(xs[xs.length - 1]).toFixed(2)},${plot.ih}L${x(xs[0]).toFixed(2)},${plot.ih}Z`,
        fill: color,
        opacity: 0.12,
      },
      plot.g
    );
    el("path", { class: "line", d, stroke: color }, plot.g);
    const last = points[points.length - 1];
    el(
      "circle",
      { cx: x(last.x), cy: y(last.y), r: 2.6, fill: color, stroke: token("--leaf"), "stroke-width": 1.5 },
      plot.g
    );
    return plot;
  }

  /* --- Scatter ------------------------------------------------------------ */
  /* All-pairs form: at most three colour-coded groups. */

  function scatter(host, opts) {
    const {
      points,
      width = 820,
      height = 420,
      margin,
      xFormat = fmt.compact,
      yFormat = fmt.compact,
      xTitle,
      yTitle,
      labelFormat = (p) => p.label,
      title,
      figure,
      tableColumns,
      tableLabel,
      trend = false,
    } = opts;

    const m = { left: 60, right: 24, top: 16, bottom: 44, ...(margin || {}) };
    const plot = frame(host, { width, height, margin: m, title });
    const x = linear(yDomain(points.map((p) => p.x), { zero: false, pad: 0.06 }), [0, plot.iw]);
    const y = linear(yDomain(points.map((p) => p.y), { zero: false, pad: 0.08 }), [plot.ih, 0]);

    yAxis(plot, y, { format: yFormat, title: yTitle });
    xAxisLinear(plot, x, { format: xFormat, title: xTitle });

    /* Least-squares fit, drawn dashed because a fit is not data. */
    if (trend && points.length > 2) {
      const n = points.length;
      const mx = points.reduce((s, p) => s + p.x, 0) / n;
      const my = points.reduce((s, p) => s + p.y, 0) / n;
      const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
      const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
      if (den !== 0) {
        const slope = num / den;
        const at = (xv) => my + slope * (xv - mx);
        el(
          "line",
          {
            x1: x(x.domain[0]),
            y1: y(at(x.domain[0])),
            x2: x(x.domain[1]),
            y2: y(at(x.domain[1])),
            stroke: token("--ink-muted"),
            "stroke-width": 1.5,
            "stroke-dasharray": "4 4",
          },
          plot.g
        );
      }
    }

    for (const p of points) {
      /* >=8px marker with a 2px surface ring so overlaps stay readable. */
      const dot = el(
        "circle",
        {
          class: "dot",
          cx: x(p.x),
          cy: y(p.y),
          r: p.r || 5,
          fill: p.color || SERIES(0),
          "fill-opacity": 0.9,
        },
        plot.g
      );
      /* An invisible 24px hit target over the small visible mark. */
      const hit = el("circle", { cx: x(p.x), cy: y(p.y), r: 12, fill: "transparent" }, plot.g);
      const show = (ev) =>
        showTip(
          `<b>${labelFormat(p)}</b><br><span class="tooltip__key">${xTitle || "x"}</span> <b>${xFormat(p.x)}</b><br><span class="tooltip__key">${yTitle || "y"}</span> <b>${yFormat(p.y)}</b>`,
          ev.clientX,
          ev.clientY
        );
      hit.addEventListener("mousemove", show);
      hit.addEventListener("mouseleave", hideTip);
      dot.addEventListener("mousemove", show);
    }

    if (figure) {
      attachTable(
        figure,
        buildTable(
          tableColumns || ["Name", xTitle || "x", yTitle || "y"],
          points.map((p) => [labelFormat(p), xFormat(p.x), yFormat(p.y)])
        ),
        tableLabel
      );
    }
    return plot;
  }

  /* --- Slope chart -------------------------------------------------------- */
  /* Two ranked columns joined by a line per entity. The right form for "the
     order changes when you measure it differently": the crossings *are* the
     finding, which a pair of bar charts would hide. Rank is plotted, not the
     raw value, because the question is about order.
     items: [{ name, leftRank, rightRank, leftValue, rightValue }] */

  function slopeChart(host, opts) {
    const {
      items,
      width = 820,
      height = 560,
      leftTitle = "Left",
      rightTitle = "Right",
      leftFormat = fmt.int,
      rightFormat = fmt.dec,
      highlight = [],
      title,
      figure,
      tableColumns,
      tableLabel,
    } = opts;

    const m = { left: 168, right: 168, top: 34, bottom: 16 };
    const plot = frame(host, { width, height, margin: m, title });
    const maxRank = Math.max(...items.flatMap((d) => [d.leftRank, d.rightRank]));
    const y = linear([1, maxRank], [0, plot.ih]);
    const hi = new Set(highlight);

    text(plot.g, leftTitle, {
      class: "axis-title",
      x: 0,
      y: -14,
      "text-anchor": "start",
    });
    text(plot.g, rightTitle, {
      class: "axis-title",
      x: plot.iw,
      y: -14,
      "text-anchor": "end",
    });

    /* Labels are placed before anything is drawn. With 77 entities over a few
       hundred pixels the top ranks sit ~9px apart while the text needs ~13px,
       so labelling them at their true y produces an unreadable block. Each
       side is de-collided independently: walk down enforcing a minimum gap,
       then walk back up to pull anything pushed past the bottom edge back in.
       A label that ends up displaced gets a hairline leader to its dot. */
    const GAP = 13;
    function placeLabels(side) {
      const wanted = items
        .filter((d) => hi.size === 0 || hi.has(d.name))
        .map((d) => ({ d, target: y(side === "left" ? d.leftRank : d.rightRank) }))
        .sort((a, b) => a.target - b.target);

      let prev = -Infinity;
      for (const L of wanted) {
        L.y = Math.max(L.target, prev + GAP);
        prev = L.y;
      }
      /* Pull back inside the plot if the forward pass overflowed. */
      let next = Infinity;
      for (let i = wanted.length - 1; i >= 0; i--) {
        const L = wanted[i];
        L.y = Math.min(L.y, next - GAP, plot.ih);
        next = L.y;
      }
      return new Map(wanted.map((L) => [L.d.name, L]));
    }
    const leftLabels = placeLabels("left");
    const rightLabels = placeLabels("right");

    for (const d of items) {
      const emphasised = hi.size === 0 || hi.has(d.name);
      /* Emphasis by weight and ink, not by a second hue: everything here is
         one entity type, so colour would be encoding nothing. */
      const stroke = emphasised
        ? d.rightRank < d.leftRank
          ? token("--series-2")
          : d.rightRank > d.leftRank
            ? token("--series-1")
            : token("--ink-muted")
        : token("--rule-strong");
      const g = el("g", {}, plot.g);
      el(
        "line",
        {
          x1: 0,
          y1: y(d.leftRank),
          x2: plot.iw,
          y2: y(d.rightRank),
          stroke,
          "stroke-width": emphasised ? 1.8 : 1,
          opacity: emphasised ? 0.95 : 0.35,
        },
        g
      );
      [
        [0, d.leftRank],
        [plot.iw, d.rightRank],
      ].forEach(([cx, rank]) => {
        el(
          "circle",
          {
            cx,
            cy: y(rank),
            r: emphasised ? 3.6 : 2.4,
            fill: stroke,
            stroke: token("--leaf"),
            "stroke-width": 2,
          },
          g
        );
      });

      if (emphasised) {
        const L = leftLabels.get(d.name);
        const R = rightLabels.get(d.name);
        /* A leader only where the label had to move, so the ones that sit at
           their true position stay clean. */
        if (L && Math.abs(L.y - L.target) > 2) {
          el(
            "line",
            { x1: -8, y1: L.y, x2: -2, y2: L.target, stroke: token("--rule-strong"), "stroke-width": 1 },
            g
          );
        }
        if (R && Math.abs(R.y - R.target) > 2) {
          el(
            "line",
            { x1: plot.iw + 8, y1: R.y, x2: plot.iw + 2, y2: R.target, stroke: token("--rule-strong"), "stroke-width": 1 },
            g
          );
        }
        text(g, `${d.leftRank}. ${d.name}`, {
          x: -12,
          y: L ? L.y : y(d.leftRank),
          "text-anchor": "end",
          "dominant-baseline": "middle",
          fill: "var(--ink)",
        });
        text(g, `${d.rightRank}. ${d.name}`, {
          x: plot.iw + 12,
          y: R ? R.y : y(d.rightRank),
          "text-anchor": "start",
          "dominant-baseline": "middle",
          fill: "var(--ink)",
        });
      }

      const hit = el(
        "rect",
        { x: -m.left, y: Math.min(y(d.leftRank), y(d.rightRank)) - 7, width: plot.iw + m.left + m.right, height: Math.abs(y(d.rightRank) - y(d.leftRank)) + 14, fill: "transparent" },
        g
      );
      hit.addEventListener("mousemove", (ev) =>
        showTip(
          `<b>${d.name}</b><br><span class="tooltip__key">${leftTitle}</span> <b>${leftFormat(d.leftValue)}</b> (rank ${d.leftRank})<br><span class="tooltip__key">${rightTitle}</span> <b>${rightFormat(d.rightValue)}</b> (rank ${d.rightRank})`,
          ev.clientX,
          ev.clientY
        )
      );
      hit.addEventListener("mouseleave", hideTip);
    }

    if (figure) {
      attachTable(
        figure,
        buildTable(
          tableColumns || ["Community area", leftTitle, `Rank`, rightTitle, "Rank"],
          [...items]
            .sort((a, b) => a.leftRank - b.leftRank)
            .map((d) => [
              d.name,
              leftFormat(d.leftValue),
              String(d.leftRank),
              rightFormat(d.rightValue),
              String(d.rightRank),
            ])
        ),
        tableLabel
      );
    }
    return plot;
  }

  /* --- Choropleth --------------------------------------------------------- */
  /* Binned ordinal ramp starting at --seq-3, the lightest step that clears
     2:1 against paper. Chicago spans ~0.3deg, so a cosine-scaled
     equirectangular projection is sub-pixel accurate here. */

  function choropleth(host, opts) {
    const {
      features,
      values,
      idOf = (f) => f.properties.area_numbe,
      nameOf = (f) => f.properties.community,
      width = 560,
      height = 720,
      bins = 5,
      valueFormat = fmt.dec,
      ramp = SEQ,
      title,
      onSelect,
      selected = null,
      figure,
      tableColumns,
      tableLabel,
    } = opts;

    clear(host);
    const svg = el("svg", {
      class: "chart",
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
    });
    if (title) {
      const t = el("title", {}, svg);
      t.textContent = title;
    }
    host.appendChild(svg);
    const g = el("g", {}, svg);

    /* Bounds across every ring of every feature. */
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const eachRing = (f, cb) => {
      const geom = f.geometry;
      if (!geom) return;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (const poly of polys) for (const ring of poly) cb(ring);
    };
    for (const f of features) {
      eachRing(f, (ring) => {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      });
    }
    const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
    const kx = Math.cos(midLat);
    const spanX = (maxLon - minLon) * kx;
    const spanY = maxLat - minLat;
    const pad = 12;
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const offX = (width - spanX * scale) / 2;
    const offY = (height - spanY * scale) / 2;
    const project = ([lon, lat]) => [
      offX + (lon - minLon) * kx * scale,
      offY + (maxLat - lat) * scale,
    ];

    /* Quantile bins, so a few extreme areas cannot flatten the rest. */
    const present = features.map((f) => values.get(String(idOf(f)))).filter((v) => v != null && !Number.isNaN(v));
    const sorted = [...present].sort((a, b) => a - b);
    const cuts = [];
    for (let i = 1; i < bins; i++) cuts.push(sorted[Math.floor((i / bins) * sorted.length)]);
    const binOf = (v) => {
      if (v == null || Number.isNaN(v)) return -1;
      let i = 0;
      while (i < cuts.length && v >= cuts[i]) i++;
      return i;
    };
    const paint = ramp.slice(0, bins);

    for (const f of features) {
      const id = String(idOf(f));
      const v = values.get(id);
      const b = binOf(v);
      const segs = [];
      eachRing(f, (ring) => {
        segs.push(
          ring.map((pt, i) => {
            const [px, py] = project(pt);
            return `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`;
          }).join("") + "Z"
        );
      });
      const path = el(
        "path",
        {
          d: segs.join(""),
          fill: b < 0 ? token("--rule") : paint[b],
          stroke: token("--leaf"),
          "stroke-width": selected === id ? 2.5 : 1,
          "data-ca": id,
          cursor: onSelect ? "pointer" : "default",
        },
        g
      );
      if (selected === id) path.setAttribute("stroke", token("--ink"));
      path.addEventListener("mousemove", (ev) =>
        showTip(
          `<b>${nameOf(f)}</b><br>${v == null ? "no data" : valueFormat(v)}`,
          ev.clientX,
          ev.clientY
        )
      );
      path.addEventListener("mouseleave", hideTip);
      if (onSelect) path.addEventListener("click", () => onSelect(id, f));
    }

    /* Bin labels, so the legend states the ranges rather than just "more". */
    const labels = paint.map((_, i) => {
      if (i === 0) return `< ${valueFormat(cuts[0])}`;
      if (i === paint.length - 1) return `${valueFormat(cuts[cuts.length - 1])} +`;
      return `${valueFormat(cuts[i - 1])}–${valueFormat(cuts[i])}`;
    });
    host.prepend(rampLegend(paint, sorted[0], sorted[sorted.length - 1], valueFormat, labels));

    if (figure) {
      const rows = features
        .map((f) => ({ name: nameOf(f), v: values.get(String(idOf(f))) }))
        .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
        .map((r) => [r.name, r.v == null ? "—" : valueFormat(r.v)]);
      attachTable(figure, buildTable(tableColumns || ["Community area", "Value"], rows), tableLabel);
    }
    return { svg, project };
  }

  return {
    fmt,
    linear,
    band,
    niceTicks,
    yDomain,
    token,
    SERIES,
    SEQ,
    DIVERGING,
    legend,
    rampLegend,
    buildTable,
    attachTable,
    showTip,
    hideTip,
    lineChart,
    barChart,
    stackedArea,
    heatmap,
    sparkline,
    scatter,
    slopeChart,
    choropleth,
  };
})();
