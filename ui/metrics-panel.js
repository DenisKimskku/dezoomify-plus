(function () {
  "use strict";

  function getRuntimeUtils() {
    return window.dezoomifyRuntimeUtils || {};
  }

  function getStorageUtils() {
    return window.dezoomifyStorageUtils || {};
  }

  function getHttpClient() {
    return window.dezoomifyHttpClient || {};
  }

  function loadArrayState(storageKey, fallback) {
    var storage = getStorageUtils();
    if (typeof storage.readJSON === "function") {
      var loaded = storage.readJSON(storageKey, fallback);
      return Array.isArray(loaded) ? loaded : (Array.isArray(fallback) ? fallback : []);
    }
    try {
      var raw = localStorage.getItem(storageKey);
      if (!raw) return Array.isArray(fallback) ? fallback : [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : (Array.isArray(fallback) ? fallback : []);
    } catch (_) {
      return Array.isArray(fallback) ? fallback : [];
    }
  }

  function saveArrayState(storageKey, value) {
    var storage = getStorageUtils();
    if (typeof storage.writeJSON === "function") {
      storage.writeJSON(storageKey, value);
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (_) { }
  }

  function createMetricsPanelController(options) {
    var opts = options || {};
    var endpoint = String(opts.endpoint || "/api/metrics");
    var tokenStorageKey = String(opts.tokenStorageKey || "dezoomify:metrics-token:v1");
    var trendStorageKey = String(opts.trendStorageKey || "dezoomify:metrics-trend:v1");
    var maxTrendPoints = Math.max(parseInt(opts.maxTrendPoints, 10) || 100, 2);
    var searchParams = opts.searchParams;

    var refs = {
      tokenInput: document.getElementById("metrics-token-input"),
      tokenSaveButton: document.getElementById("metrics-token-save"),
      tokenClearButton: document.getElementById("metrics-token-clear"),
      refreshButton: document.getElementById("metrics-refresh"),
      autoRefreshCheckbox: document.getElementById("metrics-auto-refresh"),
      status: document.getElementById("metrics-status"),
      summary: document.getElementById("metrics-summary"),
      alerts: document.getElementById("metrics-alerts"),
      changeSummary: document.getElementById("metrics-change"),
      kpiRequests: document.getElementById("metrics-kpi-requests"),
      kpiErrorRate: document.getElementById("metrics-kpi-error-rate"),
      kpiQuota: document.getElementById("metrics-kpi-quota"),
      requestsChart: document.getElementById("metrics-chart-requests"),
      healthChart: document.getElementById("metrics-chart-health"),
    };

    var metricsFetchBusy = false;
    var metricsEnabled = true;
    var lastMetricsSnapshot = null;
    var lastTrendDelta = null;
    var metricsTrend = loadArrayState(trendStorageKey, []);
    var alertHistoryStorageKey = trendStorageKey + ":alerts";
    var alertHistory = loadArrayState(alertHistoryStorageKey, []);
    if (!Array.isArray(metricsTrend)) metricsTrend = [];
    if (!Array.isArray(alertHistory)) alertHistory = [];
    if (metricsTrend.length > maxTrendPoints) {
      metricsTrend = metricsTrend.slice(metricsTrend.length - maxTrendPoints);
    }

    function formatDate(ts) {
      if (typeof opts.formatDate === "function") {
        return opts.formatDate(ts);
      }
      var utils = getRuntimeUtils();
      if (typeof utils.formatDate === "function") {
        return utils.formatDate(ts);
      }
      if (!ts) return "n/a";
      return new Date(ts).toLocaleString();
    }

    function setStatus(text) {
      if (!refs.status) return;
      refs.status.textContent = text || "";
    }

    function getEndpointURL() {
      var token = refs.tokenInput ? refs.tokenInput.value.trim() : "";
      if (!token) return endpoint;
      return endpoint + "?token=" + encodeURIComponent(token);
    }

    function formatCounterValue(value) {
      var n = parseInt(value, 10);
      return isFinite(n) ? String(n) : "0";
    }

    function getCounter(counters, key) {
      if (!counters || !Object.prototype.hasOwnProperty.call(counters, key)) return 0;
      var value = parseInt(counters[key], 10);
      return isFinite(value) ? value : 0;
    }

    function buildEndpointStatusLine(counters, endpointName) {
      var base = "http.status." + endpointName + ".";
      var twoXX = getCounter(counters, base + "2xx");
      var fourXX = getCounter(counters, base + "4xx");
      var fiveXX = getCounter(counters, base + "5xx");
      return endpointName + " status (2xx/4xx/5xx): " + twoXX + "/" + fourXX + "/" + fiveXX;
    }

    function sumCounters(counters, matcher) {
      if (!counters || typeof counters !== "object") return 0;
      var total = 0;
      var keys = Object.keys(counters);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!matcher(key)) continue;
        var value = parseInt(counters[key], 10);
        if (isFinite(value)) total += value;
      }
      return total;
    }

    function countFiveXXFromCounters(counters) {
      return sumCounters(counters, function (key) {
        return key.indexOf("http.status.") === 0 && /\\.5xx$/.test(key);
      });
    }

    function countQuotaLimitedFromCounters(counters) {
      return sumCounters(counters, function (key) {
        if (key.indexOf("http.reason.") !== 0) return false;
        return /(?:quota_exceeded|ip_rate_limited)$/.test(key);
      });
    }

    function countLatencyBucket(counters, endpoint, bucket) {
      return getCounter(counters, "http.duration." + endpoint + "." + bucket);
    }

    function asNumber(value, fallback) {
      var n = Number(value);
      return isFinite(n) ? n : fallback;
    }

    function roundTo(value, places) {
      var n = asNumber(value, 0);
      var p = isFinite(places) ? places : 2;
      var factor = Math.pow(10, p);
      return Math.round(n * factor) / factor;
    }

    function formatRatioPercent(ratio) {
      var safeRatio = asNumber(ratio, 0);
      return roundTo(safeRatio * 100, 2) + "%";
    }

    function normalizeMetricsRollup(snapshot) {
      if (!snapshot || typeof snapshot !== "object") {
        return {
          windowMinutes: 0,
          requests: 0,
          errors5xx: 0,
          quotaLimited: 0,
          errorRatio5xx: 0,
          quotaPerMinute: 0,
        };
      }

      var rollup = snapshot.rollups && typeof snapshot.rollups === "object" ? snapshot.rollups : null;
      if (rollup) {
        return {
          windowMinutes: asNumber(rollup.windowMinutes, 0),
          requests: asNumber(rollup.requests, 0),
          errors5xx: asNumber(rollup.errors5xx, 0),
          quotaLimited: asNumber(rollup.quotaLimited, 0),
          errorRatio5xx: asNumber(rollup.errorRatio5xx, 0),
          quotaPerMinute: asNumber(rollup.quotaPerMinute, 0),
        };
      }

      var counters = snapshot.counters || {};
      var requests = getCounter(counters, "http.requests.total");
      var errors5xx = countFiveXXFromCounters(counters);
      var quotaLimited = countQuotaLimitedFromCounters(counters);
      return {
        windowMinutes: 0,
        requests: requests,
        errors5xx: errors5xx,
        quotaLimited: quotaLimited,
        errorRatio5xx: requests > 0 ? errors5xx / requests : 0,
        quotaPerMinute: 0,
      };
    }

    function appendMetricsTrendSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== "object") return;
      var counters = snapshot.counters || {};
      var previous = metricsTrend.length ? metricsTrend[metricsTrend.length - 1] : null;
      var nextPoint = {
        ts: Date.now(),
        requests: getCounter(counters, "http.requests.total"),
        errors5xx: countFiveXXFromCounters(counters),
        quotaLimited: countQuotaLimitedFromCounters(counters),
      };
      metricsTrend.push({
        ts: nextPoint.ts,
        requests: nextPoint.requests,
        errors5xx: nextPoint.errors5xx,
        quotaLimited: nextPoint.quotaLimited,
      });
      if (metricsTrend.length > maxTrendPoints) {
        metricsTrend = metricsTrend.slice(metricsTrend.length - maxTrendPoints);
      }
      if (previous) {
        lastTrendDelta = {
          requestDelta: Math.max(nextPoint.requests - asNumber(previous.requests, 0), 0),
          errorsDelta: Math.max(nextPoint.errors5xx - asNumber(previous.errors5xx, 0), 0),
          quotaDelta: Math.max(nextPoint.quotaLimited - asNumber(previous.quotaLimited, 0), 0),
        };
      }
      saveArrayState(trendStorageKey, metricsTrend);
    }

    function buildSeriesFromRecentBuckets(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.recentBuckets) || !snapshot.recentBuckets.length) {
        return null;
      }
      var buckets = snapshot.recentBuckets.slice().sort(function (a, b) {
        return asNumber(a.ts, 0) - asNumber(b.ts, 0);
      });
      var requests = [];
      var health = [];
      for (var i = 0; i < buckets.length; i++) {
        var counters = buckets[i] && buckets[i].counters ? buckets[i].counters : {};
        var reqCount = getCounter(counters, "http.requests.total");
        var healthCount = countFiveXXFromCounters(counters) + countQuotaLimitedFromCounters(counters);
        requests.push(reqCount);
        health.push(healthCount);
      }
      return {
        requests: requests,
        health: health,
      };
    }

    function buildSeriesFromLocalTrend() {
      if (!Array.isArray(metricsTrend) || metricsTrend.length < 2) {
        return { requests: [], health: [] };
      }
      var points = metricsTrend.slice(-maxTrendPoints).sort(function (a, b) {
        return asNumber(a.ts, 0) - asNumber(b.ts, 0);
      });
      var requests = [];
      var health = [];
      for (var i = 1; i < points.length; i++) {
        var prev = points[i - 1] || {};
        var curr = points[i] || {};
        var deltaMs = Math.max(asNumber(curr.ts, 0) - asNumber(prev.ts, 0), 1);
        var deltaMinutes = deltaMs / 60000;
        var reqDelta = Math.max(asNumber(curr.requests, 0) - asNumber(prev.requests, 0), 0);
        var fiveDelta = Math.max(asNumber(curr.errors5xx, 0) - asNumber(prev.errors5xx, 0), 0);
        var quotaDelta = Math.max(asNumber(curr.quotaLimited, 0) - asNumber(prev.quotaLimited, 0), 0);
        requests.push(roundTo(reqDelta / deltaMinutes, 2));
        health.push(roundTo((fiveDelta + quotaDelta) / deltaMinutes, 2));
      }
      return {
        requests: requests,
        health: health,
      };
    }

    function getMetricsSeries(snapshot) {
      var serverSeries = buildSeriesFromRecentBuckets(snapshot);
      if (serverSeries && (serverSeries.requests.length || serverSeries.health.length)) {
        return serverSeries;
      }
      return buildSeriesFromLocalTrend();
    }

    function clearNode(node) {
      if (!node) return;
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function createSVGNode(tagName, attrs) {
      var ns = "http://www.w3.org/2000/svg";
      var node = document.createElementNS(ns, tagName);
      var keys = Object.keys(attrs || {});
      for (var i = 0; i < keys.length; i++) {
        node.setAttribute(keys[i], String(attrs[keys[i]]));
      }
      return node;
    }

    function renderSparkline(svgNode, values, strokeColor, fillColor) {
      if (!svgNode) return;
      clearNode(svgNode);

      var width = 220;
      var height = 52;
      var pad = 3;
      var baselineY = height - pad;
      svgNode.appendChild(createSVGNode("line", {
        x1: pad,
        y1: baselineY,
        x2: width - pad,
        y2: baselineY,
        stroke: "#dbe3e8",
        "stroke-width": "1",
      }));

      if (!Array.isArray(values) || !values.length) return;

      var maxValue = 0;
      for (var i = 0; i < values.length; i++) {
        var n = asNumber(values[i], 0);
        if (n > maxValue) maxValue = n;
      }
      if (maxValue <= 0) maxValue = 1;

      var points = [];
      var len = values.length;
      var usableWidth = width - pad * 2;
      var usableHeight = height - pad * 2;
      for (var p = 0; p < len; p++) {
        var x = len > 1 ? (pad + (usableWidth * p) / (len - 1)) : (pad + usableWidth / 2);
        var ratio = Math.max(Math.min(asNumber(values[p], 0) / maxValue, 1), 0);
        var y = pad + (1 - ratio) * usableHeight;
        points.push(roundTo(x, 2) + "," + roundTo(y, 2));
      }

      var areaPoints = [pad + "," + baselineY].concat(points).concat([(width - pad) + "," + baselineY]);
      svgNode.appendChild(createSVGNode("polygon", {
        points: areaPoints.join(" "),
        fill: fillColor || "rgba(30,106,132,0.2)",
      }));

      svgNode.appendChild(createSVGNode("polyline", {
        points: points.join(" "),
        fill: "none",
        stroke: strokeColor || "#1e6a84",
        "stroke-width": "2",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }));

      var lastPoint = points[points.length - 1].split(",");
      svgNode.appendChild(createSVGNode("circle", {
        cx: lastPoint[0],
        cy: lastPoint[1],
        r: "2.3",
        fill: strokeColor || "#1e6a84",
      }));
    }

    function renderMetricsAlerts(snapshot) {
      if (!refs.alerts) return;
      clearNode(refs.alerts);
      var alerts = snapshot && Array.isArray(snapshot.alerts) ? snapshot.alerts : [];
      if (alerts.length) {
        alertHistory.unshift({
          ts: Date.now(),
          alerts: alerts.map(function (alert) {
            return {
              id: String(alert && alert.id || ""),
              severity: String(alert && alert.severity || "warning"),
              message: String(alert && alert.message || ""),
              value: asNumber(alert && alert.value, 0),
              threshold: asNumber(alert && alert.threshold, 0),
            };
          }),
        });
        if (alertHistory.length > 20) {
          alertHistory = alertHistory.slice(0, 20);
        }
        saveArrayState(alertHistoryStorageKey, alertHistory);
      }
      if (!alerts.length) {
        var empty = document.createElement("p");
        empty.className = "ops-empty";
        empty.textContent = "No active alerts.";
        refs.alerts.appendChild(empty);
        if (alertHistory.length) {
          var last = alertHistory[0];
          var historyNote = document.createElement("p");
          historyNote.className = "ops-note";
          historyNote.textContent = "Last alert at " + formatDate(last.ts);
          refs.alerts.appendChild(historyNote);
        }
        return;
      }

      for (var i = 0; i < alerts.length; i++) {
        var alert = alerts[i] || {};
        var severity = alert.severity === "critical" ? "critical" : "warning";
        var card = document.createElement("div");
        card.className = "metrics-alert " + severity;

        var label = severity === "critical" ? "Critical" : "Warning";
        var valueText = "";
        if (alert.id === "five_xx_ratio") {
          valueText = formatRatioPercent(asNumber(alert.value, 0));
        } else {
          valueText = roundTo(asNumber(alert.value, 0), 2) + "/min";
        }
        var thresholdText = "";
        if (alert.id === "five_xx_ratio") {
          thresholdText = formatRatioPercent(asNumber(alert.threshold, 0));
        } else {
          thresholdText = roundTo(asNumber(alert.threshold, 0), 2) + "/min";
        }

        card.textContent =
          label + ": " +
          (alert.message || "Service metric threshold exceeded.") +
          " (" + valueText + " vs " + thresholdText + ")";
        refs.alerts.appendChild(card);
      }
    }

    function renderChangeSummary() {
      if (!refs.changeSummary) return;
      if (!lastTrendDelta) {
        refs.changeSummary.textContent = "No trend delta yet.";
        return;
      }
      refs.changeSummary.textContent =
        "Delta since last snapshot: +" + lastTrendDelta.requestDelta +
        " requests, +" + lastTrendDelta.errorsDelta +
        " 5xx, +" + lastTrendDelta.quotaDelta + " quota blocks.";
    }

    function renderMetricsKpis(snapshot) {
      var rollup = normalizeMetricsRollup(snapshot);
      if (refs.kpiRequests) {
        refs.kpiRequests.textContent = String(Math.round(rollup.requests));
        refs.kpiRequests.title = rollup.windowMinutes
          ? ("Requests in last " + rollup.windowMinutes + " minutes")
          : "Lifetime requests";
      }
      if (refs.kpiErrorRate) {
        refs.kpiErrorRate.textContent = formatRatioPercent(rollup.errorRatio5xx);
        refs.kpiErrorRate.title = "5xx ratio in selected window";
      }
      if (refs.kpiQuota) {
        refs.kpiQuota.textContent = String(roundTo(rollup.quotaPerMinute, 2));
        refs.kpiQuota.title = "Quota blocks per minute in selected window";
      }
    }

    function renderMetricsCharts(snapshot) {
      var series = getMetricsSeries(snapshot);
      renderSparkline(refs.requestsChart, series.requests, "#1e6a84", "rgba(30,106,132,0.22)");
      renderSparkline(refs.healthChart, series.health, "#9b423f", "rgba(155,66,63,0.2)");
    }

    function buildMetricsSummaryText(snapshot) {
      if (!snapshot || typeof snapshot !== "object") {
        return "No metrics loaded.";
      }
      var counters = snapshot.counters || {};
      var rollup = normalizeMetricsRollup(snapshot);
      var lines = [];
      lines.push("created: " + formatDate(snapshot.createdAt));
      lines.push("updated: " + formatDate(snapshot.updatedAt));
      lines.push("total requests: " + formatCounterValue(counters["http.requests.total"] || 0));
      if (rollup.windowMinutes) {
        lines.push(
          "window (" + rollup.windowMinutes + "m): req " + rollup.requests +
          " • 5xx " + rollup.errors5xx +
          " • quota/min " + roundTo(rollup.quotaPerMinute, 2)
        );
      }
      lines.push("");

      var endpoints = ["proxy", "jobs", "cron", "metrics", "benchmarks", "submit", "status", "download", "list", "history", "retry", "retry_bulk", "remove_bulk", "cancel"];
      for (var i = 0; i < endpoints.length; i++) {
        var endpointName = endpoints[i];
        lines.push(
          endpointName + " requests: " + formatCounterValue(counters["http.requests.endpoint." + endpointName] || 0)
        );
        lines.push(buildEndpointStatusLine(counters, endpointName));
      }

      lines.push("");
      lines.push(
        "proxy latency buckets: <50ms " + countLatencyBucket(counters, "proxy", "lt_50ms") +
        " • <200ms " + countLatencyBucket(counters, "proxy", "lt_200ms") +
        " • <1s " + countLatencyBucket(counters, "proxy", "lt_1s") +
        " • <5s " + countLatencyBucket(counters, "proxy", "lt_5s") +
        " • >=5s " + countLatencyBucket(counters, "proxy", "gte_5s")
      );

      return lines.join("\n");
    }

    function renderMetricsSnapshot(snapshot) {
      lastMetricsSnapshot = snapshot || null;
      renderMetricsAlerts(lastMetricsSnapshot);
      renderMetricsKpis(lastMetricsSnapshot);
      renderMetricsCharts(lastMetricsSnapshot);
      renderChangeSummary();
      if (refs.summary) {
        refs.summary.textContent = buildMetricsSummaryText(lastMetricsSnapshot);
      }
    }

    async function refresh(force) {
      if (!window.fetch || metricsFetchBusy) return false;
      if (!metricsEnabled && !force) return false;
      if (!refs.summary || !refs.status) return false;
      if (!force && refs.autoRefreshCheckbox && !refs.autoRefreshCheckbox.checked) return false;

      metricsFetchBusy = true;
      setStatus("Loading metrics...");
      try {
        var http = getHttpClient();
        var result;
        if (typeof http.getJSON === "function") {
          result = await http.getJSON(getEndpointURL(), {
            credentials: "same-origin",
            cache: "no-store",
          });
        } else {
          var response = await fetch(getEndpointURL(), {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
          });
          var payloadFallback = await response.json().catch(function () { return null; });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: payloadFallback,
            category: response.status === 401 ? "unauthorized" : (response.status === 404 || response.status === 405 ? "unavailable" : "client_error"),
            retryAfterSeconds: 0,
            message: "",
          };
        }

        if (!result.ok) {
          if (result.category === "unavailable" || result.category === "not_found") {
            metricsEnabled = false;
            setStatus("Metrics unavailable on this deployment.");
            return false;
          }
          if (result.category === "unauthorized") {
            setStatus("Unauthorized. Add a metrics token.");
            return false;
          }
          if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
            setStatus("Metrics rate-limited. Retry in " + result.retryAfterSeconds + "s.");
            return false;
          }
          setStatus("Metrics error (" + result.status + ")");
          return false;
        }

        var payload = result.payload;
        if (!payload || !payload.metrics) {
          setStatus("Invalid metrics response.");
          return false;
        }

        metricsEnabled = true;
        setStatus("Metrics updated at " + formatDate(Date.now()));
        appendMetricsTrendSnapshot(payload.metrics);
        renderMetricsSnapshot(payload.metrics);
        return true;
      } catch (error) {
        setStatus("Metrics fetch failed.");
        return false;
      } finally {
        metricsFetchBusy = false;
      }
    }

    function initialize() {
      if (!refs.summary || !refs.status) return false;
      var storage = getStorageUtils();
      var initialToken = "";
      if (searchParams && typeof searchParams.get === "function") {
        initialToken = searchParams.get("metrics_token") || "";
      }
      if (!initialToken) {
        if (typeof storage.readString === "function") {
          initialToken = storage.readString(tokenStorageKey, "");
        } else {
          try {
            initialToken = localStorage.getItem(tokenStorageKey) || "";
          } catch (_) { }
        }
      }
      if (refs.tokenInput) refs.tokenInput.value = initialToken;

      if (refs.tokenSaveButton) {
        refs.tokenSaveButton.addEventListener("click", function () {
          var token = refs.tokenInput ? refs.tokenInput.value.trim() : "";
          if (typeof storage.writeString === "function") {
            storage.writeString(tokenStorageKey, token);
          } else {
            try {
              localStorage.setItem(tokenStorageKey, token);
            } catch (_) { }
          }
          refresh(true);
        });
      }
      if (refs.tokenClearButton) {
        refs.tokenClearButton.addEventListener("click", function () {
          if (refs.tokenInput) refs.tokenInput.value = "";
          if (typeof storage.remove === "function") {
            storage.remove(tokenStorageKey);
          } else {
            try {
              localStorage.removeItem(tokenStorageKey);
            } catch (_) { }
          }
          refresh(true);
        });
      }
      if (refs.refreshButton) {
        refs.refreshButton.addEventListener("click", function () {
          refresh(true);
        });
      }
      if (refs.autoRefreshCheckbox) {
        refs.autoRefreshCheckbox.addEventListener("change", function () {
          if (refs.autoRefreshCheckbox.checked) refresh(true);
        });
      }

      renderMetricsSnapshot(null);
      setStatus("Waiting for metrics snapshot.");
      refresh(true);
      return true;
    }

    return {
      initialize: initialize,
      refresh: refresh,
    };
  }

  window.createMetricsPanelController = createMetricsPanelController;
})();
