"use strict";

const {
  applyStatePatch,
  loadOwnerState,
  readJSONBody,
  resolveOwnerContext,
  saveOwnerState,
  sendErrorJSON,
  sendJSON,
} = require("../lib/jobs-service");
const { createRequestObserver } = require("../lib/observability");

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("jobs", req);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "GET, PUT, OPTIONS");
    res.end();
    finish(204, { reason: "preflight" });
    return;
  }

  const owner = resolveOwnerContext(req);
  if (owner.error) {
    sendErrorJSON(res, owner.statusCode || 400, owner.error);
    finish(owner.statusCode || 400, { reason: "owner_resolution_failed" });
    return;
  }

  if (req.method === "GET") {
    const loaded = await loadOwnerState(owner.ownerId);
    sendJSON(res, 200, {
      ok: true,
      owner: owner.ownerLabel,
      authType: owner.authType,
      backend: loaded.backend,
      state: loaded.state,
    });
    finish(200, {
      authType: owner.authType,
      backend: loaded.backend,
      schedules: loaded.state && loaded.state.schedules ? loaded.state.schedules.length : 0,
      history: loaded.state && loaded.state.history ? loaded.state.history.length : 0,
    });
    return;
  }

  if (req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT, OPTIONS");
    sendErrorJSON(res, 405, "Only GET and PUT requests are supported.");
    finish(405, { reason: "method_not_allowed" });
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

  const current = await loadOwnerState(owner.ownerId);
  const nextState = applyStatePatch(current.state, payload);
  const saved = await saveOwnerState(owner.ownerId, nextState);

  sendJSON(res, 200, {
    ok: true,
    owner: owner.ownerLabel,
    authType: owner.authType,
    backend: saved.backend,
    state: saved.state,
  });
  finish(200, {
    authType: owner.authType,
    backend: saved.backend,
    schedules: saved.state && saved.state.schedules ? saved.state.schedules.length : 0,
    history: saved.state && saved.state.history ? saved.state.history.length : 0,
  });
};
