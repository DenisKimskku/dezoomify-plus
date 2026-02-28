"use strict";

const { createRequestObserver } = require("../lib/observability");
const { readJSONBody, resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const { buildPublicJob, retryJobsForOwner, removeJobsForOwner } = require("../lib/async-service");

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

function resolveOperation(req) {
  const query = req.query || {};
  const op = String(toSingle(query.op || query.operation || query.action || "")).trim().toLowerCase();
  if (op === "retry" || op === "retry-bulk" || op === "retry_bulk") return "retry";
  if (op === "remove" || op === "remove-bulk" || op === "remove_bulk") return "remove";

  const url = String((req && req.url) || "").toLowerCase();
  if (url.indexOf("/retry-bulk") >= 0 || url.indexOf("/retry_bulk") >= 0) return "retry";
  if (url.indexOf("/remove-bulk") >= 0 || url.indexOf("/remove_bulk") >= 0) return "remove";
  return "";
}

module.exports = async function handler(req, res) {
  const operation = resolveOperation(req);
  const metricName = operation === "remove" ? "remove_bulk" : operation === "retry" ? "retry_bulk" : "bulk";
  const finish = createRequestObserver(metricName, req);

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

  if (!operation) {
    sendErrorJSON(res, 400, "Invalid bulk operation.");
    finish(400, { reason: "invalid_operation" });
    return;
  }

  const owner = await resolveOwnerContext(req);
  if (owner.error) {
    sendErrorJSON(res, owner.statusCode || 400, owner.error, {
      code: owner.code || "REQUEST_FAILED",
      message: owner.error,
    });
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

  if (operation === "retry") {
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
    return;
  }

  let removed;
  try {
    removed = await removeJobsForOwner(owner.ownerId, ids);
  } catch (error) {
    sendErrorJSON(res, 500, error && error.message ? error.message : String(error));
    finish(500, { reason: "bulk_remove_failed" });
    return;
  }

  sendJSON(res, 200, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    requested: removed.requested,
    removed: removed.removed,
    notFound: removed.notFound,
    skipped: removed.skipped,
    errors: removed.errors,
    removedIds: removed.removedIds || [],
    remaining: removed.remaining,
  });
  finish(200, {
    reason: "bulk_remove",
    owner: owner.authType,
    requested: removed.requested,
    removed: removed.removed,
    notFound: removed.notFound,
    errors: removed.errors,
  });
};
