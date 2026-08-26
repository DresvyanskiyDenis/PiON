/* report-generation — chart layer.
   Reads figure specs from the #figures JSON block, themes ECharts from the
   CSS custom properties so a theme switch re-themes every chart, and inits
   each chart lazily so its animation plays when it scrolls into view. */

(function () {
  "use strict";

  document.documentElement.classList.add("js");

  var SPECS = [];
  try {
    var el = document.getElementById("figures");
    if (el) SPECS = JSON.parse(el.textContent) || [];
  } catch (e) {
    console.error("[report] figure specs failed to parse", e);
  }

  var charts = [];
  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* matchMedia unavailable */ }

  function v(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* One colour per series name, assigned in order of first appearance across
     the whole report, so a series keeps its colour in every figure. */
  var seriesColor = {};
  function buildSeriesColors() {
    /* Categorical tokens only. --good and --bad are reserved for figures
       where colour states a verdict (threshold pass/fail); a series must
       never inherit one by position. */
    var palette = [v("--cat-1"), v("--cat-2"), v("--cat-3"),
                   v("--cat-4"), v("--cat-5"), v("--cat-6")];
    var i = 0;
    seriesColor = {};
    SPECS.forEach(function (s) {
      (s.series || []).forEach(function (name) {
        if (!(name in seriesColor)) {
          seriesColor[name] = palette[i % palette.length];
          i += 1;
        }
      });
    });
  }

  function num(x) {
    var n = parseFloat(String(x).replace(/[^0-9.eE+-]/g, ""));
    return isFinite(n) ? n : 0;
  }

  function baseOption() {
    return {
      animationDuration: reduceMotion ? 0 : 700,
      animationEasing: "cubicOut",
      textStyle: { fontFamily: v("--font-text") || "sans-serif", color: v("--text-muted") },
      grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: v("--surface"),
        borderColor: v("--line"),
        textStyle: { color: v("--text") }
      }
    };
  }

  function axisStyle() {
    return {
      axisLine: { lineStyle: { color: v("--line") } },
      axisTick: { show: false },
      axisLabel: { color: v("--text-muted"), fontSize: 11 },
      splitLine: { lineStyle: { color: v("--line"), type: "dashed" } }
    };
  }

  function catAxis(names) {
    var a = axisStyle();
    a.type = "category";
    a.data = names;
    a.splitLine = { show: false };
    return a;
  }

  function valAxis(max, unit) {
    var a = axisStyle();
    a.type = "value";
    a.max = max;   /* explicit: an auto-fitted axis exaggerates small differences */
    a.min = 0;
    if (unit) a.name = unit;
    a.nameTextStyle = { color: v("--text-faint"), fontSize: 11 };
    return a;
  }

  function build(spec) {
    var o = baseOption();
    var cats = spec.rows.map(function (r) { return r[0]; });
    var max = spec.options["scale-max"] !== undefined ? num(spec.options["scale-max"]) : null;
    var unit = spec.options.unit || "";
    var horizontal = String(spec.options.horizontal || "") === "true";

    if (spec.kind === "bars" || spec.kind === "line" || spec.kind === "histogram") {
      var series = spec.series.map(function (name, si) {
        var data = spec.rows.map(function (r) { return num(r[si + 1]); });
        if (spec.kind === "line") {
          return {
            name: name, type: "line", data: data, smooth: false, symbolSize: 7,
            lineStyle: { width: 2.5, color: seriesColor[name] },
            itemStyle: { color: seriesColor[name] },
            areaStyle: String(spec.options.area || "") === "true"
              ? { color: seriesColor[name], opacity: 0.15 } : undefined
          };
        }
        return {
          name: name, type: "bar", data: data,
          barMaxWidth: spec.kind === "histogram" ? 40 : 28,
          barGap: spec.kind === "histogram" ? "-100%" : "10%",
          itemStyle: { color: seriesColor[name] }
        };
      });
      o.series = series;
      o.legend = spec.series.length > 1
        ? { top: 0, right: 0, textStyle: { color: v("--text-muted"), fontSize: 11 }, icon: "rect", itemWidth: 12, itemHeight: 8 }
        : undefined;
      if (horizontal) {
        o.xAxis = valAxis(max, unit);
        o.yAxis = catAxis(cats.slice().reverse());
        o.series.forEach(function (s) { s.data = s.data.slice().reverse(); });
      } else {
        o.xAxis = catAxis(cats);
        o.yAxis = valAxis(max, unit);
      }
      if (spec.kind === "histogram" && spec.options["x-label"]) {
        o.xAxis.name = spec.options["x-label"];
        o.xAxis.nameLocation = "middle";
        o.xAxis.nameGap = 26;
        o.xAxis.nameTextStyle = { color: v("--text-faint"), fontSize: 11 };
      }
      return o;
    }

    if (spec.kind === "threshold") {
      var thr = num(spec.options.threshold);
      var label = spec.options["threshold-label"] || "threshold";
      o.xAxis = valAxis(max, unit);
      o.yAxis = catAxis(cats.slice().reverse());
      o.tooltip.trigger = "item";
      o.series = [{
        type: "bar",
        data: spec.rows.slice().reverse().map(function (r) {
          /* clears the line = real; below it = indistinguishable from noise */
          var n = num(r[1]);
          return {
            value: n,
            /* raw carries the source string so the label reads 1.00, not 1 */
            raw: String(r[1]).trim(),
            itemStyle: { color: n >= thr ? v("--good") : v("--neutral") }
          };
        }),
        barMaxWidth: 22,
        label: {
          show: true, position: "right", color: v("--text-muted"), fontSize: 11,
          formatter: function (pp) { return pp.data.raw; }
        },
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ xAxis: thr }],
          lineStyle: { color: v("--bad"), type: "dashed", width: 2 },
          label: { formatter: label, color: v("--bad"), fontSize: 11, position: "end" }
        }
      }];
      return o;
    }

    if (spec.kind === "radar") {
      o.tooltip = { trigger: "item", backgroundColor: v("--surface"), borderColor: v("--line"), textStyle: { color: v("--text") } };
      o.radar = {
        indicator: cats.map(function (c) { return { name: c, max: max }; }),
        axisName: { color: v("--text-muted"), fontSize: 11 },
        splitLine: { lineStyle: { color: v("--line") } },
        splitArea: { show: false },
        axisLine: { lineStyle: { color: v("--line") } }
      };
      o.legend = { top: 0, right: 0, textStyle: { color: v("--text-muted"), fontSize: 11 }, icon: "rect", itemWidth: 12, itemHeight: 8 };
      o.series = [{
        type: "radar",
        data: spec.series.map(function (name, si) {
          return {
            name: name,
            value: spec.rows.map(function (r) { return num(r[si + 1]); }),
            lineStyle: { color: seriesColor[name], width: 2.5 },
            itemStyle: { color: seriesColor[name] },
            areaStyle: { color: seriesColor[name], opacity: 0.12 }
          };
        })
      }];
      delete o.grid;
      return o;
    }

    return null;
  }

  function initChart(host) {
    if (host.dataset.ready === "1") return;
    var spec = SPECS.filter(function (s) { return s.id === host.id; })[0];
    if (!spec) return;
    if (typeof echarts === "undefined") {
      console.error("[report] echarts missing; figure", host.id, "not rendered");
      return;
    }
    var option = build(spec);
    if (!option) return;
    var c = echarts.init(host, null, { renderer: "canvas" });
    c.setOption(option);
    charts.push({ chart: c, host: host });
    host.dataset.ready = "1";
  }

  function rethemeAll() {
    buildSeriesColors();
    charts.forEach(function (entry) {
      var spec = SPECS.filter(function (s) { return s.id === entry.host.id; })[0];
      if (!spec) return;
      var option = build(spec);
      if (option) entry.chart.setOption(option, true);
    });
  }

  /* ---------- lazy init + figure reveal ---------- */

  function setupObservers() {
    var hosts = [].slice.call(document.querySelectorAll(".echart"));
    var reveals = [].slice.call(document.querySelectorAll(".reveal"));

    if (!("IntersectionObserver" in window)) {
      hosts.forEach(initChart);
      reveals.forEach(function (r) { r.classList.add("in"); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        if (e.target.classList.contains("echart")) initChart(e.target);
        e.target.classList.add("in");
        io.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });

    hosts.forEach(function (h) { io.observe(h); });
    reveals.forEach(function (r) { io.observe(r); });
  }

  /* ---------- nav active state ---------- */

  function setupNav() {
    var links = [].slice.call(document.querySelectorAll(".navdots a"));
    if (!links.length || !("IntersectionObserver" in window)) return;
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var nav = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var a = byId[e.target.id];
        if (a && e.isIntersecting) {
          links.forEach(function (l) { l.classList.remove("active"); });
          a.classList.add("active");
        }
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
    Object.keys(byId).forEach(function (id) {
      var sec = document.getElementById(id);
      if (sec) nav.observe(sec);
    });
  }

  /* ---------- theme toggle ---------- */

  function setupTheme() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    var root = document.documentElement;

    function stored() {
      try { return localStorage.getItem("report-theme"); } catch (e) { return null; }
    }
    function store(val) {
      try { localStorage.setItem("report-theme", val); } catch (e) { /* private mode */ }
    }
    function current() {
      var explicit = root.getAttribute("data-theme");
      if (explicit) return explicit;
      try {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      } catch (e) { return "light"; }
    }
    function apply(t) {
      root.setAttribute("data-theme", t);
      btn.textContent = t === "dark" ? "Light" : "Dark";
      btn.setAttribute("aria-label", "Switch to " + (t === "dark" ? "light" : "dark") + " theme");
      rethemeAll();
    }

    var saved = stored();
    if (saved === "dark" || saved === "light") apply(saved);
    else btn.textContent = current() === "dark" ? "Light" : "Dark";

    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      store(next);
      apply(next);
    });
  }

  /* ---------- resize ---------- */

  var rt = null;
  window.addEventListener("resize", function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function () {
      charts.forEach(function (e) { e.chart.resize(); });
    }, 120);
  });

  function boot() {
    buildSeriesColors();
    setupObservers();
    setupNav();
    setupTheme();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
