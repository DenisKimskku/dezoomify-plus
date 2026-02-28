"use strict";

const { createRequestObserver } = require("../lib/observability");
const { loadOwnerState, resolveOwnerContext, sendErrorJSON, sendJSON } = require("../lib/jobs-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseLimit(rawValue) {
  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 120);
}

function parseCursor(rawValue) {
  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseStatusFilters(rawValue) {
  const source = String(rawValue || "").trim();
  if (!source) return [];
  const allowed = ["success", "error", "running"];
  const values = source.split(",").map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
  const unique = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (allowed.indexOf(value) === -1) continue;
    if (unique.indexOf(value) !== -1) continue;
    unique.push(value);
  }
  return unique;
}

function matchesQuery(item, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack =
    String(item.id || "") + "\n" +
    String(item.url || "") + "\n" +
    String(item.status || "") + "\n" +
    String(item.source || "") + "\n" +
    String(item.scheduleId || "") + "\n" +
    String(item.message || "");
  return haystack.toLowerCase().indexOf(needle) >= 0;
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("history", req);

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
  const limit = parseLimit(toSingle(query.limit || ""));
  const cursor = parseCursor(toSingle(query.cursor || ""));
  const statuses = parseStatusFilters(toSingle(query.status || query.statuses || ""));
  const search = String(toSingle(query.q || query.query || "") || "").trim();

  const loaded = await loadOwnerState(owner.ownerId);
  const history = Array.isArray(loaded.state && loaded.state.history)
    ? loaded.state.history
    : [];

  const filtered = [];
  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    if (!item || typeof item !== "object") continue;
    const status = String(item.status || "").toLowerCase();
    if (statuses.length && statuses.indexOf(status) === -1) continue;
    if (!matchesQuery(item, search)) continue;
    filtered.push(item);
  }

  const page = filtered.slice(cursor, cursor + limit);
  const nextCursor = (cursor + limit) < filtered.length
    ? String(cursor + limit)
    : null;

  sendJSON(res, 200, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    items: page,
    total: filtered.length,
    cursor: cursor,
    nextCursor: nextCursor,
    limit: limit,
    filters: {
      status: statuses,
      query: search,
    },
    backend: loaded.backend,
  });
  finish(200, {
    reason: "listed",
    ownerId: owner.ownerId,
    count: page.length,
    total: filtered.length,
    backend: loaded.backend,
  });
};
