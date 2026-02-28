"use strict";

const { createRequestObserver } = require("../lib/observability");
const { readJSONBody, resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const { buildPublicJob, retryJobsForOwner } = require("../lib/async-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseJobIDs(raw) {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || "").trim()).filter(Boolean);
  }
  if (!raw) return [];
  return String(raw).split(",").map((value) => String(value || "").trim()).filter(Boolean);
}

function shouldProcessNow(req, body) {
  const query = req.query || {};
  const queryFlag = toSingle(query.process_now || query.processNow || "");
  const bodyFlag = body && typeof body === "object" ? (body.process_now || body.processNow) : "";
  const value = String(queryFlag || bodyFlag || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("retry_bulk", req);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "POST, OPTIONS");
    res.end();
    finish(204, { reason: "preflight" });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendErrorJSON(res, 405, "Only POST requests are supported.");
    finish(405, { reason: "method_not_allowed" });
    return;
  }

  const owner = resolveOwnerContext(req);
  if (owner.error) {
    sendErrorJSON(res, owner.statusCode || 400, owner.error);
    finish(owner.statusCode || 400, { reason: "owner_resolution_failed" });
    return;
  }

  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (error) {
    sendErrorJSON(res, 400, error.message || String(error));
    finish(400, { reason: "invalid_body" });
    return;
  }

  const ids = parseJobIDs(payload && typeof payload === "object" ? payload.ids : []);
  if (!ids.length) {
    sendErrorJSON(res, 400, "Missing required field: ids.");
    finish(400, { reason: "missing_ids" });
    return;
  }

  const processNow = shouldProcessNow(req, payload);
  let retried;
  try {
    retried = await retryJobsForOwner(owner.ownerId, ids, {
      processNow: processNow,
    });
  } catch (error) {
    sendErrorJSON(res, 500, error && error.message ? error.message : String(error));
    finish(500, { reason: "bulk_retry_failed" });
    return;
  }

  sendJSON(res, 200, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    requested: retried.requested,
    successCount: retried.successCount,
    failedCount: retried.failedCount,
    results: retried.results.map((result) => ({
      sourceJobId: result.sourceJobId,
      ok: !!result.ok,
      reason: result.reason || "",
      statusCode: result.statusCode || 0,
      message: result.message || "",
      job: result.job ? buildPublicJob(result.job) : null,
    })),
  });
  finish(200, {
    reason: "bulk_retry",
    owner: owner.authType,
    requested: retried.requested,
    success: retried.successCount,
    failed: retried.failedCount,
  });
};
