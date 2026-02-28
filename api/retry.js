"use strict";

const { createRequestObserver } = require("../lib/observability");
const { readJSONBody, resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const { buildPublicJob, retryJobForOwner } = require("../lib/async-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function shouldProcessNow(req, body) {
  const query = req.query || {};
  const queryFlag = toSingle(query.process_now || query.processNow || "");
  const bodyFlag = body && typeof body === "object" ? (body.process_now || body.processNow) : "";
  const value = String(queryFlag || bodyFlag || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("retry", req);

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

  const rawID = payload && typeof payload === "object"
    ? (payload.id || payload.job_id || payload.jobId)
    : "";
  const jobID = String(rawID || "").trim();
  if (!jobID) {
    sendErrorJSON(res, 400, "Missing required field: id.");
    finish(400, { reason: "missing_id" });
    return;
  }

  const processNow = shouldProcessNow(req, payload);
  let retried;
  try {
    retried = await retryJobForOwner(owner.ownerId, jobID, {
      processNow: processNow,
    });
  } catch (error) {
    sendErrorJSON(res, 500, error && error.message ? error.message : String(error));
    finish(500, { reason: "retry_failed" });
    return;
  }

  if (!retried.job) {
    sendErrorJSON(res, retried.statusCode || 404, retried.message || "Job not found.");
    finish(retried.statusCode || 404, { reason: retried.reason || "not_found" });
    return;
  }

  const encodedID = encodeURIComponent(retried.job.id);
  sendJSON(res, 202, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    reason: retried.reason || "retried",
    sourceJobId: retried.sourceJob ? retried.sourceJob.id : null,
    job: buildPublicJob(retried.job),
    links: {
      status: "/api/status?id=" + encodedID,
      download: "/api/download?id=" + encodedID,
    },
  });
  finish(202, {
    reason: retried.reason || "retried",
    status: retried.job.status,
    owner: owner.authType,
  });
};
