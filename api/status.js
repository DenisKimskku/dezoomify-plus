"use strict";

const { createRequestObserver } = require("../lib/observability");
const { resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const { buildPublicJob, getJobForOwner } = require("../lib/async-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("status", req);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendErrorJSON(res, 405, "Only GET requests are supported.");
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

  const query = req.query || {};
  const jobID = toSingle(query.id || query.job_id || "");
  if (!jobID) {
    sendErrorJSON(res, 400, "Missing required query parameter: id.");
    finish(400, { reason: "missing_id" });
    return;
  }

  const loaded = await getJobForOwner(owner.ownerId, jobID);
  if (!loaded.job) {
    sendErrorJSON(res, 404, "Job not found.");
    finish(404, { reason: "not_found" });
    return;
  }

  const encodedID = encodeURIComponent(loaded.job.id);
  sendJSON(res, 200, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    job: buildPublicJob(loaded.job),
    links: {
      status: "/api/status?id=" + encodedID,
      download: "/api/download?id=" + encodedID,
    },
  });
  finish(200, { reason: loaded.reason || "status", status: loaded.job.status });
};
