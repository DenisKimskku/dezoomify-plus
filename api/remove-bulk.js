"use strict";

const { createRequestObserver } = require("../lib/observability");
const { readJSONBody, resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");
const { removeJobsForOwner } = require("../lib/async-service");

function parseJobIDs(raw) {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || "").trim()).filter(Boolean);
  }
  if (!raw) return [];
  return String(raw).split(",").map((value) => String(value || "").trim()).filter(Boolean);
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("remove_bulk", req);

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
