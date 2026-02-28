"use strict";

const { createRequestObserver } = require("../lib/observability");
const { resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const { buildPublicJob, listJobsForOwner } = require("../lib/async-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseLimit(rawValue) {
  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return parsed;
}

function parseCursor(rawValue) {
  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseStatusFilters(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return [];
  return raw.split(",").map((item) => String(item || "").trim()).filter(Boolean);
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("list", req);

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
  const statuses = parseStatusFilters(toSingle(query.status || query.statuses || ""));
  const limit = parseLimit(toSingle(query.limit || ""));
  const cursor = parseCursor(toSingle(query.cursor || ""));
  const search = String(toSingle(query.q || query.query || "") || "").trim();

  let listed;
  try {
    listed = await listJobsForOwner(owner.ownerId, {
      status: statuses,
      limit: limit,
      cursor: cursor,
      query: search,
    });
  } catch (error) {
    sendErrorJSON(res, 500, error && error.message ? error.message : String(error));
    finish(500, { reason: "list_failed" });
    return;
  }

  sendJSON(res, 200, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    jobs: listed.jobs.map((job) => buildPublicJob(job)).filter(Boolean),
    total: listed.total,
    cursor: listed.cursor,
    nextCursor: listed.nextCursor,
    limit: listed.limit,
    filters: {
      status: listed.statuses,
      query: listed.query,
    },
  });
  finish(200, {
    reason: "listed",
    owner: owner.authType,
    count: listed.jobs.length,
    total: listed.total,
  });
};
