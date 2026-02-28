"use strict";

const { appendBenchmarkRun, listBenchmarkRuns } = require("../lib/benchmark-trends");
const { createRequestObserver, getMetricsSnapshot } = require("../lib/observability");
const { checkStorageHealth } = require("../lib/storage-service");
const authService = require("../lib/auth-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendJSON(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function sendAuthError(res, statusCode, code, message, extras) {
  sendJSON(res, statusCode, authService.buildErrorPayload(code, message, extras));
}

function resolveScope(req) {
  const query = req.query || {};
  const queryScope = String(toSingle(query.scope || query.route || query.endpoint || "")).trim().toLowerCase();
  if (["metrics", "benchmarks", "auth", "storage"].indexOf(queryScope) !== -1) {
    return queryScope;
  }

  const url = String((req && req.url) || "").toLowerCase();
  if (url.indexOf("/api/metrics") >= 0) return "metrics";
  if (url.indexOf("/api/benchmarks") >= 0) return "benchmarks";
  if (url.indexOf("/api/auth") >= 0) return "auth";
  if (url.indexOf("/api/storage-health") >= 0) return "storage";
  return "";
}

function parseAuthAction(req) {
  const query = req.query || {};
  const fromQuery = String(toSingle(query.action || query.auth_action || "")).trim().toLowerCase();
  if (fromQuery) return fromQuery;

  const url = String((req && req.url) || "");
  const match = url.match(/\/api\/auth\/?([^?]*)/i);
  if (!match || !match[1]) return "session";
  return String(match[1]).trim().toLowerCase().replace(/\//g, "_");
}

function readJSONBody(req) {
  if (req && req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  if (req && typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch (_) {
      return Promise.reject(new Error("Invalid JSON body."));
    }
  }

  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

function getRequestToken(req) {
  const query = req.query || {};
  const queryToken = toSingle(query.token || query.bench_token || query.benchmark_token || "");
  if (queryToken) return String(queryToken).trim();
  const headerToken = toSingle(req.headers["x-benchmark-token"] || "");
  if (headerToken) return String(headerToken).trim();
  const auth = toSingle(req.headers.authorization || "");
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  if (match) return String(match[1]).trim();
  return "";
}

function isBenchmarkAuthorized(req, expectedToken) {
  const expected = String(expectedToken || "").trim();
  if (!expected) return true;
  return getRequestToken(req) === expected;
}

function isMetricsTokenAuthorized(req) {
  const expected = String(process.env.METRICS_READ_TOKEN || "").trim();
  if (!expected) return true;

  const queryToken = toSingle((req.query && (req.query.token || req.query.metrics_token)) || "");
  const headerToken = toSingle(req.headers["x-metrics-token"] || "");
  const auth = toSingle(req.headers.authorization || "");
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  const bearerToken = match ? String(match[1]).trim() : "";

  return queryToken === expected || headerToken === expected || bearerToken === expected;
}

function ensureAuthStorage(res) {
  if (authService.isStorageReadyForAuth()) return true;
  sendAuthError(
    res,
    503,
    "STORAGE_UNAVAILABLE",
    "Persistent storage is required for authentication and account features."
  );
  return false;
}

async function requireAuthenticatedUser(req, res) {
  if (!ensureAuthStorage(res)) return null;
  const authResult = await authService.resolveRequestAuth(req);
  if (authResult && authResult.ok) return authResult;
  sendAuthError(
    res,
    (authResult && authResult.statusCode) || 401,
    (authResult && authResult.code) || "UNAUTHORIZED",
    (authResult && authResult.message) || "Sign in is required."
  );
  return null;
}

async function handleAuth(req, res) {
  const action = parseAuthAction(req);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.end();
    return { statusCode: 204, reason: "preflight", action: action };
  }

  if (action === "register") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendAuthError(res, 405, "METHOD_NOT_ALLOWED", "Only POST requests are supported.");
      return { statusCode: 405, reason: "method_not_allowed", action: action };
    }
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (error) {
      sendAuthError(res, 400, "INVALID_BODY", error && error.message ? error.message : String(error));
      return { statusCode: 400, reason: "invalid_body", action: action };
    }

    const result = await authService.registerUser(payload && payload.email, payload && payload.password, req);
    if (!result.ok) {
      sendAuthError(res, result.statusCode || 400, result.code || "REGISTER_FAILED", result.message || "Unable to register account.");
      return { statusCode: result.statusCode || 400, reason: result.code || "register_failed", action: action };
    }

    if (result.session && result.session.id) {
      res.setHeader("Set-Cookie", authService.createSessionCookieHeader(result.session.id, req));
    }

    sendJSON(res, 201, {
      ok: true,
      user: result.user,
      session: result.session,
      config: authService.getPublicRuntimeConfig(),
    });
    return { statusCode: 201, reason: "registered", action: action };
  }

  if (action === "login") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendAuthError(res, 405, "METHOD_NOT_ALLOWED", "Only POST requests are supported.");
      return { statusCode: 405, reason: "method_not_allowed", action: action };
    }

    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (error) {
      sendAuthError(res, 400, "INVALID_BODY", error && error.message ? error.message : String(error));
      return { statusCode: 400, reason: "invalid_body", action: action };
    }

    const result = await authService.loginUser(payload && payload.email, payload && payload.password, req);
    if (!result.ok) {
      sendAuthError(res, result.statusCode || 401, result.code || "LOGIN_FAILED", result.message || "Unable to sign in.");
      return { statusCode: result.statusCode || 401, reason: result.code || "login_failed", action: action };
    }

    if (result.session && result.session.id) {
      res.setHeader("Set-Cookie", authService.createSessionCookieHeader(result.session.id, req));
    }

    sendJSON(res, 200, {
      ok: true,
      user: result.user,
      session: result.session,
      config: authService.getPublicRuntimeConfig(),
    });
    return { statusCode: 200, reason: "logged_in", action: action };
  }

  if (action === "logout") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendAuthError(res, 405, "METHOD_NOT_ALLOWED", "Only POST requests are supported.");
      return { statusCode: 405, reason: "method_not_allowed", action: action };
    }

    const sessionID = authService.extractSessionIDFromReq(req);
    if (sessionID) {
      await authService.destroySession(sessionID);
    }
    res.setHeader("Set-Cookie", authService.createClearedSessionCookieHeader(req));
    sendJSON(res, 200, { ok: true });
    return { statusCode: 200, reason: "logged_out", action: action };
  }

  if (action === "key") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      sendAuthError(res, 405, "METHOD_NOT_ALLOWED", "Only GET requests are supported.");
      return { statusCode: 405, reason: "method_not_allowed", action: action };
    }

    const result = await authService.getAPIKeyInfoForSession(req);
    if (!result.ok) {
      sendAuthError(res, result.statusCode || 401, result.code || "UNAUTHORIZED", result.message || "Sign in is required.");
      return { statusCode: result.statusCode || 401, reason: result.code || "unauthorized", action: action };
    }

    sendJSON(res, 200, {
      ok: true,
      keyPreview: result.keyPreview,
      createdAt: result.createdAt,
      rotatedAt: result.rotatedAt,
    });
    return { statusCode: 200, reason: "key_info", action: action };
  }

  if (action === "key_rotate") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendAuthError(res, 405, "METHOD_NOT_ALLOWED", "Only POST requests are supported.");
      return { statusCode: 405, reason: "method_not_allowed", action: action };
    }

    const result = await authService.rotateAPIKeyForSession(req);
    if (!result.ok) {
      sendAuthError(res, result.statusCode || 401, result.code || "UNAUTHORIZED", result.message || "Sign in is required.");
      return { statusCode: result.statusCode || 401, reason: result.code || "unauthorized", action: action };
    }

    sendJSON(res, 200, {
      ok: true,
      apiKey: result.apiKey,
      keyPreview: result.keyPreview,
      createdAt: result.createdAt,
      rotatedAt: result.rotatedAt,
    });
    return { statusCode: 200, reason: "key_rotated", action: action };
  }

  if (action === "session" || !action) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      sendAuthError(res, 405, "METHOD_NOT_ALLOWED", "Only GET requests are supported.");
      return { statusCode: 405, reason: "method_not_allowed", action: action || "session" };
    }

    const state = await authService.getSessionState(req);
    sendJSON(res, 200, state);
    return {
      statusCode: 200,
      reason: state.authenticated ? "session_authenticated" : "session_anonymous",
      action: "session",
    };
  }

  sendAuthError(res, 404, "NOT_FOUND", "Unknown auth action.");
  return { statusCode: 404, reason: "unknown_auth_action", action: action };
}

async function handleStorage(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJSON(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", message: "Only GET requests are supported." });
    return { statusCode: 405, reason: "method_not_allowed" };
  }

  const health = await checkStorageHealth();
  if (!health.ok) {
    sendJSON(res, 503, {
      ok: false,
      code: "STORAGE_UNAVAILABLE",
      message: "Storage health check failed.",
      storage: health,
    });
    return { statusCode: 503, reason: "storage_unavailable", backend: health.backend };
  }

  sendJSON(res, 200, {
    ok: true,
    storage: health,
  });
  return { statusCode: 200, reason: "storage_ok", backend: health.backend };
}

async function handleMetrics(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJSON(res, 405, { ok: false, error: "Only GET requests are supported." });
    return { statusCode: 405, reason: "method_not_allowed" };
  }

  if (authService.AUTH_ENFORCE_ADVANCED) {
    const authResult = await requireAuthenticatedUser(req, res);
    if (!authResult) {
      return { statusCode: 401, reason: "unauthorized" };
    }
    if (!authResult.user || authResult.user.role !== "admin") {
      sendAuthError(res, 403, "FORBIDDEN", "Admin role is required for service metrics.");
      return { statusCode: 403, reason: "forbidden" };
    }
  }

  if (!isMetricsTokenAuthorized(req)) {
    sendJSON(res, 401, { ok: false, error: "Unauthorized." });
    return { statusCode: 401, reason: "unauthorized" };
  }

  sendJSON(res, 200, {
    ok: true,
    metrics: getMetricsSnapshot(),
  });
  return { statusCode: 200, reason: "snapshot" };
}

async function handleBenchmarks(req, res) {
  const readToken = String(process.env.BENCHMARK_READ_TOKEN || "").trim();
  const writeToken = String(process.env.BENCHMARK_WRITE_TOKEN || readToken).trim();

  if (req.method === "GET") {
    if (!isBenchmarkAuthorized(req, readToken)) {
      sendJSON(res, 401, { ok: false, error: "Unauthorized." });
      return { statusCode: 401, reason: "unauthorized_read" };
    }
    const query = req.query || {};
    const suite = toSingle(query.suite || "jobs-state");
    const limit = toSingle(query.limit || 30);
    const result = await listBenchmarkRuns(suite, limit);
    sendJSON(res, 200, {
      ok: true,
      suite: result.suite,
      backend: result.backend,
      runs: result.runs,
    });
    return {
      statusCode: 200,
      reason: "list",
      suite: result.suite,
      backend: result.backend,
      runs: result.runs.length,
    };
  }

  if (req.method === "POST") {
    if (!isBenchmarkAuthorized(req, writeToken)) {
      sendJSON(res, 401, { ok: false, error: "Unauthorized." });
      return { statusCode: 401, reason: "unauthorized_write" };
    }
    let payload;
    try {
      payload = await readJSONBody(req);
    } catch (error) {
      sendJSON(res, 400, { ok: false, error: error.message || String(error) });
      return { statusCode: 400, reason: "invalid_body" };
    }
    const result = await appendBenchmarkRun(
      payload && payload.suite ? payload.suite : "jobs-state",
      payload && payload.report ? payload.report : {},
      payload && payload.metadata ? payload.metadata : {}
    );
    sendJSON(res, 201, {
      ok: true,
      suite: result.suite,
      backend: result.backend,
      total: result.total,
      entry: result.entry,
    });
    return { statusCode: 201, reason: "append", suite: result.suite, backend: result.backend };
  }

  res.setHeader("Allow", "GET, POST");
  sendJSON(res, 405, { ok: false, error: "Only GET and POST requests are supported." });
  return { statusCode: 405, reason: "method_not_allowed" };
}

module.exports = async function handler(req, res) {
  const scope = resolveScope(req);
  const metricName = scope === "metrics"
    ? "metrics"
    : scope === "benchmarks"
      ? "benchmarks"
      : scope === "auth"
        ? "auth"
        : scope === "storage"
          ? "storage"
          : "observability";
  const finish = createRequestObserver(metricName, req);

  if (!scope) {
    sendJSON(res, 404, { ok: false, error: "Unknown observability endpoint." });
    finish(404, { reason: "unknown_scope" });
    return;
  }

  let result;
  if (scope === "metrics") {
    result = await handleMetrics(req, res);
  } else if (scope === "benchmarks") {
    result = await handleBenchmarks(req, res);
  } else if (scope === "auth") {
    result = await handleAuth(req, res);
  } else {
    result = await handleStorage(req, res);
  }

  finish(result.statusCode || 200, result);
};
