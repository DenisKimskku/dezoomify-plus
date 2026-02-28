"use strict";

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

function isAuthorized(req) {
  const expected = String(process.env.METRICS_READ_TOKEN || "").trim();
  if (!expected) return true;

  const queryToken = toSingle((req.query && (req.query.token || req.query.metrics_token)) || "");
  const headerToken = toSingle(req.headers["x-metrics-token"] || "");
  const auth = toSingle(req.headers.authorization || "");
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  const bearerToken = match ? String(match[1]).trim() : "";

  return queryToken === expected || headerToken === expected || bearerToken === expected;
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("metrics", req);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJSON(res, 405, { ok: false, error: "Only GET requests are supported." });
    finish(405, { reason: "method_not_allowed" });
    return;
  }

  if (!isAuthorized(req)) {
    sendJSON(res, 401, { ok: false, error: "Unauthorized." });
    finish(401, { reason: "unauthorized" });
    return;
  }

  sendJSON(res, 200, {
    ok: true,
    metrics: getMetricsSnapshot(),
  });
  finish(200, { reason: "snapshot" });
};
