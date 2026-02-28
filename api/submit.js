"use strict";

const { createRequestObserver } = require("../lib/observability");
const { readJSONBody, resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const {
  buildPublicJob,
  getJobForOwner,
  runJobNowForOwner,
  runPendingJobsForOwner,
  submitJob,
  validateTargetURL,
} = require("../lib/async-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function shouldProcessNow(req, body) {
  const query = req.query || {};
  const queryFlag = toSingle(query.process_now || query.processNow || "");
  const bodyFlag = body && typeof body === "object" ? (body.process_now || body.processNow) : "";
  const envDefault = /^(1|true|yes)$/i.test(process.env.ASYNC_SUBMIT_PROCESS_NOW || "");
  const value = String(queryFlag || bodyFlag || (envDefault ? "1" : "")).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function buildResponse(req, owner, job) {
  const encodedID = encodeURIComponent(job.id);
  const statusPath = "/api/status?id=" + encodedID;
  const downloadPath = "/api/download?id=" + encodedID;
  return {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    job: buildPublicJob(job),
    links: {
      status: statusPath,
      download: downloadPath,
      self: req.url || "/api/submit",
    },
  };
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("submit", req);

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

  const rawURL = payload && typeof payload === "object" ? payload.url : "";
  if (!rawURL) {
    sendErrorJSON(res, 400, "Missing required field: url.");
    finish(400, { reason: "missing_url" });
    return;
  }

  let normalizedURL;
  try {
    normalizedURL = validateTargetURL(rawURL);
  } catch (error) {
    sendErrorJSON(res, 400, error.message || String(error));
    finish(400, { reason: "invalid_url" });
    return;
  }

  let created;
  try {
    created = await submitJob(owner.ownerId, owner.ownerLabel, normalizedURL);
  } catch (error) {
    sendErrorJSON(res, 500, error.message || String(error));
    finish(500, { reason: "submit_failed" });
    return;
  }

  const processNow = shouldProcessNow(req, payload);
  let job = created.job;
  if (processNow) {
    const processed = await runJobNowForOwner(owner.ownerId, created.job.id, null);
    if (processed.job) {
      job = processed.job;
    } else {
      await runPendingJobsForOwner(owner.ownerId, 1, null);
      const loaded = await getJobForOwner(owner.ownerId, created.job.id);
      if (loaded.job) job = loaded.job;
    }
  }

  sendJSON(res, 202, buildResponse(req, owner, job));
  finish(202, {
    reason: processNow ? "submitted_processed" : "submitted",
    status: job.status,
    owner: owner.authType,
  });
};
