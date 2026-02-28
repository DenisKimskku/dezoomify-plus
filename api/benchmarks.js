"use strict";

const { appendBenchmarkRun, listBenchmarkRuns } = require("../lib/benchmark-trends");
const { createRequestObserver } = require("../lib/observability");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendJSON(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
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

function isAuthorized(req, expectedToken) {
  const expected = String(expectedToken || "").trim();
  if (!expected) return true;
  return getRequestToken(req) === expected;
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("benchmarks", req);
  const readToken = String(process.env.BENCHMARK_READ_TOKEN || "").trim();
  const writeToken = String(process.env.BENCHMARK_WRITE_TOKEN || readToken).trim();

  if (req.method === "GET") {
    if (!isAuthorized(req, readToken)) {
      sendJSON(res, 401, { ok: false, error: "Unauthorized." });
      finish(401, { reason: "unauthorized_read" });
      return;
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
    finish(200, { reason: "list", suite: result.suite, backend: result.backend, runs: result.runs.length });
    return;
  }

  if (req.method === "POST") {
    if (!isAuthorized(req, writeToken)) {
      sendJSON(res, 401, { ok: false, error: "Unauthorized." });
      finish(401, { reason: "unauthorized_write" });
      return;
    }
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (error) {
      sendJSON(res, 400, { ok: false, error: error.message || String(error) });
      finish(400, { reason: "invalid_body" });
      return;
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
    finish(201, { reason: "append", suite: result.suite, backend: result.backend });
    return;
  }

  res.setHeader("Allow", "GET, POST");
  sendJSON(res, 405, { ok: false, error: "Only GET and POST requests are supported." });
  finish(405, { reason: "method_not_allowed" });
};
