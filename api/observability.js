"use strict";

const { appendBenchmarkRun, listBenchmarkRuns } = require("../lib/benchmark-trends");
const { createRequestObserver, getMetricsSnapshot } = require("../lib/observability");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendJSON(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function resolveScope(req) {
  const query = req.query || {};
  const queryScope = String(toSingle(query.scope || query.route || query.endpoint || "")).trim().toLowerCase();
  if (queryScope === "metrics" || queryScope === "benchmarks") return queryScope;

  const url = String((req && req.url) || "").toLowerCase();
  if (url.indexOf("/api/metrics") >= 0) return "metrics";
  if (url.indexOf("/api/benchmarks") >= 0) return "benchmarks";
  return "";
}

function isMetricsAuthorized(req) {
  const expected = String(process.env.METRICS_READ_TOKEN || "").trim();
  if (!expected) return true;

  const queryToken = toSingle((req.query && (req.query.token || req.query.metrics_token)) || "");
  const headerToken = toSingle(req.headers["x-metrics-token"] || "");
  const auth = toSingle(req.headers.authorization || "");
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  const bearerToken = match ? String(match[1]).trim() : "";

  return queryToken === expected || headerToken === expected || bearerToken === expected;
}

function readJSONBody(req) {
  if (req && req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  if (req && typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch (_) {
      return Promise.reject(new Error("Invalid JSON body."));
    }
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

function getRequestToken(req) {
  const query = req.query || {};
  const queryToken = toSingle(query.token || query.bench_token || query.benchmark_token || "");
  if (queryToken) return String(queryToken).trim();
  const headerToken = toSingle(req.headers["x-benchmark-token"] || "");
  if (headerToken) return String(headerToken).trim();
  const auth = toSingle(req.headers.authorization || "");
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  if (match) return String(match[1]).trim();
  return "";
}

function isBenchmarkAuthorized(req, expectedToken) {
  const expected = String(expectedToken || "").trim();
  if (!expected) return true;
  return getRequestToken(req) === expected;
}

async function handleMetrics(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJSON(res, 405, { ok: false, error: "Only GET requests are supported." });
    return { statusCode: 405, reason: "method_not_allowed" };
  }

  if (!isMetricsAuthorized(req)) {
    sendJSON(res, 401, { ok: false, error: "Unauthorized." });
    return { statusCode: 401, reason: "unauthorized" };
  }

  sendJSON(res, 200, {
    ok: true,
    metrics: getMetricsSnapshot(),
  });
  return { statusCode: 200, reason: "snapshot" };
}

async function handleBenchmarks(req, res) {
  const readToken = String(process.env.BENCHMARK_READ_TOKEN || "").trim();
  const writeToken = String(process.env.BENCHMARK_WRITE_TOKEN || readToken).trim();

  if (req.method === "GET") {
    if (!isBenchmarkAuthorized(req, readToken)) {
      sendJSON(res, 401, { ok: false, error: "Unauthorized." });
      return { statusCode: 401, reason: "unauthorized_read" };
    }
    const query = req.query || {};
    const suite = toSingle(query.suite || "jobs-state");
    const limit = toSingle(query.limit || 30);
    const result = await listBenchmarkRuns(suite, limit);
    sendJSON(res, 200, {
      ok: true,
      suite: result.suite,
      backend: result.backend,
      runs: result.runs,
    });
    return {
      statusCode: 200,
      reason: "list",
      suite: result.suite,
      backend: result.backend,
      runs: result.runs.length,
    };
  }

  if (req.method === "POST") {
    if (!isBenchmarkAuthorized(req, writeToken)) {
      sendJSON(res, 401, { ok: false, error: "Unauthorized." });
      return { statusCode: 401, reason: "unauthorized_write" };
    }
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (error) {
      sendJSON(res, 400, { ok: false, error: error.message || String(error) });
      return { statusCode: 400, reason: "invalid_body" };
    }
    const result = await appendBenchmarkRun(
      payload && payload.suite ? payload.suite : "jobs-state",
      payload && payload.report ? payload.report : {},
      payload && payload.metadata ? payload.metadata : {}
    );
    sendJSON(res, 201, {
      ok: true,
      suite: result.suite,
      backend: result.backend,
      total: result.total,
      entry: result.entry,
    });
    return { statusCode: 201, reason: "append", suite: result.suite, backend: result.backend };
  }

  res.setHeader("Allow", "GET, POST");
  sendJSON(res, 405, { ok: false, error: "Only GET and POST requests are supported." });
  return { statusCode: 405, reason: "method_not_allowed" };
}

module.exports = async function handler(req, res) {
  const scope = resolveScope(req);
  const metricName = scope === "metrics" ? "metrics" : scope === "benchmarks" ? "benchmarks" : "observability";
  const finish = createRequestObserver(metricName, req);

  if (!scope) {
    sendJSON(res, 404, { ok: false, error: "Unknown observability endpoint." });
    finish(404, { reason: "unknown_scope" });
    return;
  }

  const result = scope === "metrics"
    ? await handleMetrics(req, res)
    : await handleBenchmarks(req, res);
  finish(result.statusCode || 200, result);
};
