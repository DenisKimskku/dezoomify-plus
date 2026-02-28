"use strict";

const { createRequestObserver } = require("../lib/observability");
const { readJSONBody, resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const { buildPublicJob, cancelJobForOwner } = require("../lib/async-service");

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("cancel", req);

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

  let body;
  try {
    body = await readJSONBody(req);
  } catch (error) {
    sendErrorJSON(res, 400, error.message || String(error));
    finish(400, { reason: "invalid_body", ownerId: owner.ownerId });
    return;
  }

  const jobID = String((body && body.id) || "").trim();
  if (!jobID) {
    sendErrorJSON(res, 400, "Missing required field: id.");
    finish(400, { reason: "missing_id", ownerId: owner.ownerId });
    return;
  }

  let canceled;
  try {
    canceled = await cancelJobForOwner(owner.ownerId, jobID);
  } catch (error) {
    sendErrorJSON(res, 500, error && error.message ? error.message : String(error));
    finish(500, { reason: "cancel_failed", ownerId: owner.ownerId });
    return;
  }

  if (!canceled || !canceled.job) {
    sendErrorJSON(res, canceled && canceled.statusCode ? canceled.statusCode : 404, canceled && canceled.message ? canceled.message : "Job not found.");
    finish(canceled && canceled.statusCode ? canceled.statusCode : 404, {
      reason: canceled && canceled.reason ? canceled.reason : "not_found",
      ownerId: owner.ownerId,
    });
    return;
  }

  sendJSON(res, 200, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    reason: canceled.reason || "canceled",
    job: buildPublicJob(canceled.job),
  });
  finish(200, {
    reason: canceled.reason || "canceled",
    status: canceled.job.status,
    ownerId: owner.ownerId,
  });
};
