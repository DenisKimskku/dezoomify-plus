"use strict";

const crypto = require("crypto");

const OBSERVABILITY_ENABLED = !/^(0|false|no)$/i.test(process.env.OBSERVABILITY_ENABLED || "true");
const SUCCESS_LOG_SAMPLE_RATE = clampRate(
  parseFloat(process.env.OBS_SUCCESS_LOG_SAMPLE_RATE || "0.02"),
  0.02
);
const OBS_RECENT_BUCKET_LIMIT = Math.max(parseInteger(process.env.OBS_RECENT_BUCKET_LIMIT, 90), 1);
const OBS_BUCKET_RETENTION_MINUTES = Math.max(
  parseInteger(process.env.OBS_BUCKET_RETENTION_MINUTES, 180),
  10
);
const OBS_ALERT_WINDOW_MINUTES = Math.max(parseInteger(process.env.OBS_ALERT_WINDOW_MINUTES, 5), 1);
const OBS_ALERT_MIN_REQUESTS = Math.max(parseInteger(process.env.OBS_ALERT_MIN_REQUESTS, 25), 1);
const OBS_ALERT_5XX_WARN_RATIO = clampRate(
  parseFloat(process.env.OBS_ALERT_5XX_WARN_RATIO || "0.05"),
  0.05
);
const OBS_ALERT_5XX_CRIT_RATIO = clampRate(
  parseFloat(process.env.OBS_ALERT_5XX_CRIT_RATIO || "0.15"),
  0.15
);
const OBS_ALERT_QUOTA_WARN_PER_MIN = Math.max(
  parseNumber(process.env.OBS_ALERT_QUOTA_WARN_PER_MIN, 4),
  0
);
const OBS_ALERT_QUOTA_CRIT_PER_MIN = Math.max(
  parseNumber(process.env.OBS_ALERT_QUOTA_CRIT_PER_MIN, 10),
  0
);
const OBS_SCOPE_RETENTION_MINUTES = Math.max(
  parseInteger(process.env.OBS_SCOPE_RETENTION_MINUTES, 12 * 60),
  30
);
const OBS_SCOPE_MAX = Math.max(parseInteger(process.env.OBS_SCOPE_MAX, 500), 50);

function parseInteger(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampRate(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function createEmptyMetricsStore(nowTs) {
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  return {
    createdAt: now,
    updatedAt: now,
    counters: {},
    buckets: {},
  };
}

function getMetricsRegistry() {
  if (!global.__dezoomifyObservabilityMetrics) {
    global.__dezoomifyObservabilityMetrics = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      global: createEmptyMetricsStore(Date.now()),
      scopes: {},
    };
  }
  return global.__dezoomifyObservabilityMetrics;
}

function sanitizeScopeKey(value) {
  if (!value && value !== 0) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeMetricsScope(scopeId) {
  const raw = sanitizeScopeKey(scopeId);
  if (!raw) return "";
  if (raw.indexOf("user:") === 0) {
    const userId = sanitizeScopeKey(raw.slice(5));
    if (!userId) return "";
    return "user:" + userId;
  }
  if (raw.indexOf("owner:") === 0) {
    const ownerHash = sanitizeScopeKey(raw.slice(6));
    if (!ownerHash) return "";
    return "owner:" + ownerHash;
  }
  return "";
}

function metricsScopeFromOwnerId(ownerId) {
  const raw = String(ownerId || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.indexOf("user:") === 0) {
    return normalizeMetricsScope(raw);
  }
  return normalizeMetricsScope("owner:" + hashValue(raw));
}

function pruneScopedStores(registry, now) {
  if (!registry || !registry.scopes) return;
  const scopeKeys = Object.keys(registry.scopes);
  if (!scopeKeys.length) return;

  const cutoffTs = now - OBS_SCOPE_RETENTION_MINUTES * 60000;
  for (let i = 0; i < scopeKeys.length; i += 1) {
    const key = scopeKeys[i];
    const scopeStore = registry.scopes[key];
    if (!scopeStore || !Number.isFinite(scopeStore.updatedAt) || scopeStore.updatedAt < cutoffTs) {
      delete registry.scopes[key];
    }
  }

  const remaining = Object.keys(registry.scopes);
  if (remaining.length <= OBS_SCOPE_MAX) return;
  remaining.sort((a, b) => {
    const aUpdated = Number(registry.scopes[a] && registry.scopes[a].updatedAt) || 0;
    const bUpdated = Number(registry.scopes[b] && registry.scopes[b].updatedAt) || 0;
    return aUpdated - bUpdated;
  });
  const overflow = remaining.length - OBS_SCOPE_MAX;
  for (let i = 0; i < overflow; i += 1) {
    delete registry.scopes[remaining[i]];
  }
}

function getMetricsStore(scopeId, nowTs) {
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  const registry = getMetricsRegistry();
  const normalizedScope = normalizeMetricsScope(scopeId);
  if (!normalizedScope) {
    registry.updatedAt = now;
    return registry.global;
  }
  if (!registry.scopes[normalizedScope]) {
    registry.scopes[normalizedScope] = createEmptyMetricsStore(now);
  }
  registry.scopes[normalizedScope].updatedAt = now;
  registry.updatedAt = now;
  pruneScopedStores(registry, now);
  return registry.scopes[normalizedScope];
}

function sanitizeMetricLabel(value, fallback) {
  if (!value && value !== 0) return fallback || "";
  const sanitized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || (fallback || "");
}

function incrementCounterMap(map, key, amount) {
  if (!map[key]) map[key] = 0;
  map[key] += Number.isFinite(amount) ? amount : 1;
}

function minuteBucketTimestamp(now) {
  return Math.floor(now / 60000) * 60000;
}

function pruneBuckets(store, now) {
  if (!store || !store.buckets) return;
  const keys = Object.keys(store.buckets);
  if (!keys.length) return;

  const cutoffTs = now - OBS_BUCKET_RETENTION_MINUTES * 60000;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const bucket = store.buckets[key];
    if (!bucket || bucket.ts < cutoffTs) {
      delete store.buckets[key];
    }
  }

  const remainingKeys = Object.keys(store.buckets);
  const maxBuckets = Math.max(OBS_RECENT_BUCKET_LIMIT * 3, OBS_ALERT_WINDOW_MINUTES + 2);
  if (remainingKeys.length <= maxBuckets) return;
  remainingKeys.sort((a, b) => Number(a) - Number(b));
  const overflow = remainingKeys.length - maxBuckets;
  for (let i = 0; i < overflow; i += 1) {
    delete store.buckets[remainingKeys[i]];
  }
}

function recordMetricForStore(store, key, nowTs) {
  if (!store) return;
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  const metricKey = String(key || "unknown");
  incrementCounterMap(store.counters, metricKey, 1);

  const bucketTs = minuteBucketTimestamp(now);
  const bucketKey = String(bucketTs);
  if (!store.buckets[bucketKey]) {
    store.buckets[bucketKey] = {
      ts: bucketTs,
      counters: {},
    };
  }
  incrementCounterMap(store.buckets[bucketKey].counters, metricKey, 1);
  store.updatedAt = now;
  pruneBuckets(store, now);
}

function recordMetric(key, nowTs, scopeId) {
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  const store = getMetricsStore(scopeId, now);
  recordMetricForStore(store, key, now);
}

function durationBucket(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown";
  if (durationMs < 50) return "lt_50ms";
  if (durationMs < 200) return "lt_200ms";
  if (durationMs < 1000) return "lt_1s";
  if (durationMs < 5000) return "lt_5s";
  return "gte_5s";
}

function statusBucket(statusCode) {
  const code = Number(statusCode);
  if (!Number.isFinite(code) || code <= 0) return "unknown";
  if (code >= 500) return "5xx";
  if (code >= 400) return "4xx";
  if (code >= 300) return "3xx";
  if (code >= 200) return "2xx";
  if (code >= 100) return "1xx";
  return "unknown";
}

function hashValue(value) {
  if (!value) return "";
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getClientHash(req) {
  if (!req || !req.headers) return "";
  const forwarded = toSingle(req.headers["x-forwarded-for"] || "");
  if (forwarded) return hashValue(String(forwarded).split(",")[0].trim());
  const realIP = toSingle(req.headers["x-real-ip"] || "");
  if (realIP) return hashValue(String(realIP).trim());
  if (req.socket && req.socket.remoteAddress) {
    return hashValue(String(req.socket.remoteAddress));
  }
  return "";
}

function resolveMetricsScope(extra) {
  if (!extra || typeof extra !== "object") return "";
  if (typeof extra.metricsScope === "string" && extra.metricsScope.trim()) {
    return normalizeMetricsScope(extra.metricsScope);
  }
  if (typeof extra.ownerId === "string" && extra.ownerId.trim()) {
    return metricsScopeFromOwnerId(extra.ownerId);
  }
  return "";
}

function recordHttpRequestForScope(scopeId, endpoint, statusClass, latencyClass, reason, quotaType, now) {
  recordMetric("http.requests.total", now, scopeId);
  recordMetric("http.requests.endpoint." + endpoint, now, scopeId);
  recordMetric("http.status." + endpoint + "." + statusClass, now, scopeId);
  recordMetric("http.duration." + endpoint + "." + latencyClass, now, scopeId);
  if (reason) {
    recordMetric("http.reason." + endpoint + "." + reason, now, scopeId);
  }
  if (quotaType) {
    recordMetric("http.quota_type." + endpoint + "." + quotaType, now, scopeId);
  }
}

function recordHttpRequest(endpoint, statusCode, durationMs, extra) {
  const now = Date.now();
  const ep = sanitizeMetricLabel(endpoint, "unknown");
  const statusClass = statusBucket(statusCode);
  const latencyClass = durationBucket(durationMs);
  const reason = sanitizeMetricLabel(extra && extra.reason, "");
  const quotaType = sanitizeMetricLabel(extra && extra.quotaType, "");
  recordHttpRequestForScope("", ep, statusClass, latencyClass, reason, quotaType, now);

  const scopedMetrics = resolveMetricsScope(extra);
  if (scopedMetrics) {
    recordHttpRequestForScope(scopedMetrics, ep, statusClass, latencyClass, reason, quotaType, now);
  }
}

function shouldLog(statusCode) {
  const code = Number(statusCode);
  if (!Number.isFinite(code)) return false;
  if (code >= 400) return true;
  return Math.random() < SUCCESS_LOG_SAMPLE_RATE;
}

function logEvent(eventName, payload) {
  if (!OBSERVABILITY_ENABLED) return;
  const event = Object.assign(
    {
      ts: new Date().toISOString(),
      event: String(eventName || "event"),
    },
    payload || {}
  );
  try {
    console.log(JSON.stringify(event));
  } catch (_) {
    // no-op
  }
}

function createRequestObserver(endpoint, req) {
  const startedAt = Date.now();
  const method = (req && req.method) ? String(req.method) : "GET";
  const requestId = "req_" + hashValue(Math.random().toString(16) + ":" + startedAt + ":" + endpoint);
  const clientHash = getClientHash(req);
  let finished = false;

  return function finish(statusCode, extra) {
    if (finished) return;
    finished = true;

    const durationMs = Math.max(Date.now() - startedAt, 0);
    recordHttpRequest(endpoint, statusCode, durationMs, extra || null);

    if (!shouldLog(statusCode)) return;
    logEvent("http_request", Object.assign(
      {
        requestId: requestId,
        endpoint: String(endpoint || "unknown"),
        method: method,
        statusCode: Number(statusCode) || 0,
        durationMs: durationMs,
        durationBucket: durationBucket(durationMs),
        clientHash: clientHash || undefined,
      },
      extra || {}
    ));
  };
}

function countByMatcher(counters, matcher) {
  if (!counters || typeof counters !== "object") return 0;
  let total = 0;
  const keys = Object.keys(counters);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!matcher(key)) continue;
    const value = Number(counters[key]);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

function roundTo(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const places = Number.isFinite(digits) ? digits : 2;
  const factor = Math.pow(10, places);
  return Math.round(n * factor) / factor;
}

function buildRecentBuckets(store) {
  if (!store || !store.buckets) return [];
  const keys = Object.keys(store.buckets);
  if (!keys.length) return [];
  keys.sort((a, b) => Number(a) - Number(b));
  const tail = keys.slice(-OBS_RECENT_BUCKET_LIMIT);
  const buckets = [];
  for (let i = 0; i < tail.length; i += 1) {
    const key = tail[i];
    const bucket = store.buckets[key];
    if (!bucket || !bucket.counters) continue;
    buckets.push({
      ts: Number(bucket.ts) || Number(key) || 0,
      counters: Object.assign({}, bucket.counters),
    });
  }
  return buckets;
}

function buildRollups(recentBuckets) {
  const buckets = Array.isArray(recentBuckets) ? recentBuckets : [];
  const windowStart = Date.now() - OBS_ALERT_WINDOW_MINUTES * 60000;
  let requests = 0;
  let errors5xx = 0;
  let quotaLimited = 0;
  let bucketCount = 0;

  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    if (!bucket || !bucket.counters) continue;
    if (Number(bucket.ts) < windowStart) continue;
    const counters = bucket.counters;
    bucketCount += 1;
    requests += Number(counters["http.requests.total"]) || 0;
    errors5xx += countByMatcher(counters, function (key) {
      return key.indexOf("http.status.") === 0 && /\.5xx$/.test(key);
    });
    quotaLimited +=
      (Number(counters["http.reason.proxy.quota_exceeded"]) || 0) +
      (Number(counters["http.reason.proxy.ip_rate_limited"]) || 0);
  }

  const errorRatio5xx = requests > 0 ? (errors5xx / requests) : 0;
  const quotaPerMinute = quotaLimited / OBS_ALERT_WINDOW_MINUTES;
  return {
    windowMinutes: OBS_ALERT_WINDOW_MINUTES,
    bucketCount: bucketCount,
    requests: requests,
    errors5xx: errors5xx,
    quotaLimited: quotaLimited,
    errorRatio5xx: roundTo(errorRatio5xx, 4),
    quotaPerMinute: roundTo(quotaPerMinute, 2),
  };
}

function buildAlerts(rollups) {
  const safeRollups = rollups || {};
  const alerts = [];
  const errorWarn = Math.min(OBS_ALERT_5XX_WARN_RATIO, Math.max(OBS_ALERT_5XX_CRIT_RATIO, OBS_ALERT_5XX_WARN_RATIO));
  const errorCrit = Math.max(OBS_ALERT_5XX_CRIT_RATIO, errorWarn);
  const quotaWarn = Math.min(
    OBS_ALERT_QUOTA_WARN_PER_MIN,
    Math.max(OBS_ALERT_QUOTA_CRIT_PER_MIN, OBS_ALERT_QUOTA_WARN_PER_MIN)
  );
  const quotaCrit = Math.max(OBS_ALERT_QUOTA_CRIT_PER_MIN, quotaWarn);

  if (safeRollups.requests >= OBS_ALERT_MIN_REQUESTS && safeRollups.errorRatio5xx >= errorWarn) {
    const severe = safeRollups.errorRatio5xx >= errorCrit;
    alerts.push({
      id: "five_xx_ratio",
      severity: severe ? "critical" : "warning",
      value: roundTo(safeRollups.errorRatio5xx, 4),
      threshold: severe ? errorCrit : errorWarn,
      windowMinutes: safeRollups.windowMinutes || OBS_ALERT_WINDOW_MINUTES,
      message: "5xx ratio elevated in recent traffic window.",
    });
  }

  if (safeRollups.quotaPerMinute >= quotaWarn && safeRollups.quotaLimited > 0) {
    const severe = safeRollups.quotaPerMinute >= quotaCrit;
    alerts.push({
      id: "quota_spike",
      severity: severe ? "critical" : "warning",
      value: roundTo(safeRollups.quotaPerMinute, 2),
      threshold: severe ? quotaCrit : quotaWarn,
      windowMinutes: safeRollups.windowMinutes || OBS_ALERT_WINDOW_MINUTES,
      message: "Quota or IP rate-limit blocks are spiking.",
    });
  }

  return alerts;
}

function getMetricsSnapshot(scopeId) {
  const normalizedScope = normalizeMetricsScope(scopeId);
  const store = getMetricsStore(normalizedScope, Date.now());
  const recentBuckets = buildRecentBuckets(store);
  const rollups = buildRollups(recentBuckets);
  return {
    scope: normalizedScope || "global",
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
    counters: Object.assign({}, store.counters),
    recentBuckets: recentBuckets,
    rollups: rollups,
    alerts: buildAlerts(rollups),
    thresholds: {
      alertWindowMinutes: OBS_ALERT_WINDOW_MINUTES,
      alertMinRequests: OBS_ALERT_MIN_REQUESTS,
      errorWarnRatio: OBS_ALERT_5XX_WARN_RATIO,
      errorCritRatio: OBS_ALERT_5XX_CRIT_RATIO,
      quotaWarnPerMinute: OBS_ALERT_QUOTA_WARN_PER_MIN,
      quotaCritPerMinute: OBS_ALERT_QUOTA_CRIT_PER_MIN,
    },
  };
}

function resetMetricsStoreForTests() {
  delete global.__dezoomifyObservabilityMetrics;
}

module.exports = {
  createRequestObserver: createRequestObserver,
  getMetricsSnapshot: getMetricsSnapshot,
  metricsScopeFromOwnerId: metricsScopeFromOwnerId,
  logEvent: logEvent,
  resetMetricsStoreForTests: resetMetricsStoreForTests,
};
