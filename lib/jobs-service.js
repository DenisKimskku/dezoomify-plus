"use strict";

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const authService = require("./auth-service");

const OWNER_REGISTRY_KEY = process.env.JOBS_OWNER_REGISTRY_KEY || "dz:jobs:owners:v1";
const OWNER_STATE_KEY_PREFIX = process.env.JOBS_STATE_KEY_PREFIX || "dz:jobs:state:v1:";
const MAX_SCHEDULE_ITEMS = Math.max(parseInt(process.env.JOBS_MAX_SCHEDULES, 10) || 120, 1);
const MAX_HISTORY_ITEMS = Math.max(parseInt(process.env.JOBS_MAX_HISTORY, 10) || 200, 1);
const CRON_MAX_JOBS_PER_RUN = Math.max(parseInt(process.env.CRON_MAX_JOBS_PER_RUN, 10) || 25, 1);
const JOB_PROBE_TIMEOUT_MS = Math.max(parseInt(process.env.JOBS_PROBE_TIMEOUT_MS, 10) || 15000, 1000);
const JOB_PROBE_MAX_REDIRECTS = Math.max(parseInt(process.env.JOBS_PROBE_MAX_REDIRECTS, 10) || 2, 0);
const JOBS_MIN_URL_SPACING_MS = Math.max(parseInt(process.env.JOBS_MIN_URL_SPACING_MS, 10) || 60000, 0);
const JOBS_HISTORY_RETENTION_MS = Math.max(parseInt(process.env.JOBS_HISTORY_RETENTION_MS, 10) || (30 * 24 * 60 * 60 * 1000), 0);
const JOBS_REQUIRE_API_KEY = /^(1|true|yes)$/i.test(
  process.env.JOBS_REQUIRE_API_KEY || process.env.API_AUTH_REQUIRED || ""
);
const JOBS_DISABLE_ANON = /^(1|true|yes)$/i.test(
  process.env.JOBS_DISABLE_ANON || process.env.API_DISABLE_ANON || ""
);
const HOBBY_CRON_ONLY = !!authService.HOBBY_CRON_ONLY;
const JOB_PROBE_USER_AGENT = "dezoomify-scheduler/1.0 (+https://github.com/lovasoa/dezoomify)";

class MemoryJSONStore {
  constructor() {
    this.values = new Map();
  }

  backendName() {
    return "memory";
  }

  async getJSON(key) {
    if (!this.values.has(key)) return null;
    return this.values.get(key);
  }

  async setJSON(key, value) {
    this.values.set(key, value);
  }
}

class KVRestJSONStore {
  constructor(baseURL, token) {
    this.baseURL = String(baseURL || "").replace(/\/+$/, "");
    this.token = String(token || "");
  }

  backendName() {
    return "vercel-kv-rest";
  }

  async command(command, args) {
    const path = [command].concat(args.map((arg) => encodeURIComponent(String(arg)))).join("/");
    const response = await fetch(this.baseURL + "/" + path, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + this.token,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) {
      const message = body && body.error ? body.error : ("KV command failed: " + response.status);
      throw new Error(message);
    }
    return body.result;
  }

  async getJSON(key) {
    const rawValue = await this.command("get", [key]);
    if (rawValue === null || typeof rawValue === "undefined") return null;
    if (typeof rawValue === "string") {
      try {
        return JSON.parse(rawValue);
      } catch (_) {
        return null;
      }
    }
    if (typeof rawValue === "object") return rawValue;
    return null;
  }

  async setJSON(key, value) {
    await this.command("set", [key, JSON.stringify(value)]);
  }
}

function getMemoryStore() {
  if (!global.__dezoomifyJobsMemoryStore) {
    global.__dezoomifyJobsMemoryStore = new MemoryJSONStore();
  }
  return global.__dezoomifyJobsMemoryStore;
}

function createPrimaryJSONStore() {
  const restURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (restURL && restToken) {
    return new KVRestJSONStore(restURL, restToken);
  }
  return memoryJSONStore;
}

const memoryJSONStore = getMemoryStore();
const primaryJSONStore = createPrimaryJSONStore();

function sendJSON(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function sendErrorJSON(res, statusCode, message, extras) {
  sendJSON(
    res,
    statusCode,
    Object.assign(
      {
        ok: false,
        error: String(message || "Request failed."),
      },
      extras || {}
    )
  );
}

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function clipString(value, maxLength) {
  const str = String(value || "");
  if (!maxLength || str.length <= maxLength) return str;
  return str.slice(0, maxLength);
}

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTimestamp(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function hashString(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function createID(prefix) {
  return (
    String(prefix || "id") +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(16).slice(2, 10)
  );
}

function getClientKey(req) {
  const forwarded = toSingle(req.headers["x-forwarded-for"]);
  if (forwarded) return String(forwarded).split(",")[0].trim();
  const realIP = toSingle(req.headers["x-real-ip"]);
  if (realIP) return String(realIP).trim();
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return "unknown";
}

function extractApiKey(req) {
  const query = req.query || {};
  const queryKey = toSingle(query.api_key || query.apiKey || "");
  if (queryKey) return String(queryKey).trim();
  const headerKey = toSingle(req.headers["x-api-key"] || "");
  if (headerKey) return String(headerKey).trim();
  const auth = toSingle(req.headers.authorization || "");
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  if (match) return String(match[1]).trim();
  return "";
}

function sanitizeApiKey(rawKey) {
  if (!rawKey) return "";
  const apiKey = String(rawKey).trim();
  if (apiKey.length > 256) {
    throw new Error("API key is too long.");
  }
  return apiKey;
}

async function resolveOwnerContext(req) {
  let apiKey = "";
  try {
    apiKey = sanitizeApiKey(extractApiKey(req));
  } catch (error) {
    return { error: error.message || String(error), statusCode: 400, code: "INVALID_API_KEY" };
  }

  const hasSessionCookie = !!authService.extractSessionIDFromReq(req);
  const hasAuthHints = !!apiKey || hasSessionCookie;
  const enforceAuth = !!authService.AUTH_ENFORCE_ADVANCED;

  if (enforceAuth && !authService.isStorageReadyForAuth()) {
    return {
      error: "Persistent storage is required for authenticated advanced routes.",
      statusCode: 503,
      code: "STORAGE_UNAVAILABLE",
    };
  }

  if ((hasAuthHints || enforceAuth) && authService.isStorageReadyForAuth()) {
    const authResult = await authService.resolveRequestAuth(req);
    if (authResult && authResult.ok) {
      const ownerContext = authService.toOwnerContext(authResult);
      if (ownerContext) return ownerContext;
    }
    if (enforceAuth) {
      return {
        error: (authResult && authResult.message) || "Authentication required.",
        statusCode: (authResult && authResult.statusCode) || 401,
        code: (authResult && authResult.code) || "UNAUTHORIZED",
      };
    }
    if (authResult && authResult.code === "INVALID_API_KEY") {
      return {
        error: authResult.message || "Invalid API key.",
        statusCode: authResult.statusCode || 401,
        code: "INVALID_API_KEY",
      };
    }
  } else if (enforceAuth) {
    return { error: "Authentication required.", statusCode: 401, code: "UNAUTHORIZED" };
  }

  if (apiKey) {
    const apiHash = hashString(apiKey);
    return {
      ownerId: "apikey:" + apiHash,
      ownerLabel: "apikey-" + apiHash.slice(0, 8),
      authType: "api_key",
    };
  }

  if (JOBS_REQUIRE_API_KEY || JOBS_DISABLE_ANON) {
    return { error: "Missing API key.", statusCode: 401, code: "UNAUTHORIZED" };
  }

  const anonHash = hashString(getClientKey(req));
  return {
    ownerId: "anon:" + anonHash,
    ownerLabel: "anon-" + anonHash.slice(0, 8),
    authType: "anonymous",
  };
}

function ownerStateKey(ownerId) {
  return OWNER_STATE_KEY_PREFIX + String(ownerId || "");
}

async function loadJSONFromStore(key, fallbackValue) {
  try {
    const value = await primaryJSONStore.getJSON(key);
    if (value === null || typeof value === "undefined") {
      return { value: fallbackValue, backend: primaryJSONStore.backendName() };
    }
    return { value: value, backend: primaryJSONStore.backendName() };
  } catch (error) {
    console.error("Primary jobs backend failed, falling back to memory:", error);
    const value = await memoryJSONStore.getJSON(key);
    if (value === null || typeof value === "undefined") {
      return { value: fallbackValue, backend: memoryJSONStore.backendName() };
    }
    return { value: value, backend: memoryJSONStore.backendName() };
  }
}

async function saveJSONToStore(key, value) {
  try {
    await primaryJSONStore.setJSON(key, value);
    return primaryJSONStore.backendName();
  } catch (error) {
    console.error("Primary jobs backend write failed, falling back to memory:", error);
    await memoryJSONStore.setJSON(key, value);
    return memoryJSONStore.backendName();
  }
}

function defaultOwnerState() {
  return {
    version: 1,
    schedules: [],
    history: [],
    updatedAt: Date.now(),
  };
}

function sanitizeSchedule(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const url = clipString(raw.url || "", 4096).trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch (_) {
    return null;
  }

  let repeat = raw.repeat === "hourly" || raw.repeat === "daily" ? raw.repeat : "none";
  // Vercel Hobby supports daily cron only.
  if (HOBBY_CRON_ONLY && repeat === "hourly") {
    repeat = "daily";
  }
  const defaultStatus = repeat === "none" ? "scheduled" : "scheduled";
  const status =
    raw.status === "paused" || raw.status === "completed" || raw.status === "scheduled"
      ? raw.status
      : defaultStatus;

  return {
    id: clipString(raw.id || createID("schedule-" + (index || 0)), 128),
    url: url,
    repeat: repeat,
    status: status,
    nextRunAt: parseTimestamp(raw.nextRunAt, null),
    createdAt: parseTimestamp(raw.createdAt, Date.now()),
    lastRunAt: parseTimestamp(raw.lastRunAt, null),
    lastResult: clipString(raw.lastResult || "pending", 300),
  };
}

function sanitizeHistoryEntry(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const url = clipString(raw.url || "", 4096).trim();
  if (!url) return null;

  const status =
    raw.status === "success" || raw.status === "error" || raw.status === "running"
      ? raw.status
      : "error";

  const startedAt = parseTimestamp(raw.startedAt, Date.now());
  const finishedAt = parseTimestamp(raw.finishedAt, null);
  const durationMs = parseNumber(raw.durationMs, null);

  return {
    id: clipString(raw.id || createID("job-" + (index || 0)), 128),
    url: url,
    source: clipString(raw.source || "manual", 60),
    scheduleId: clipString(raw.scheduleId || "", 128) || null,
    status: status,
    startedAt: startedAt,
    finishedAt: finishedAt,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
    message: clipString(raw.message || "", 400),
  };
}

function normalizeState(rawState) {
  const state = rawState && typeof rawState === "object" ? rawState : defaultOwnerState();

  const schedules = Array.isArray(state.schedules)
    ? state.schedules
        .map((schedule, index) => sanitizeSchedule(schedule, index))
        .filter(Boolean)
        .slice(0, MAX_SCHEDULE_ITEMS)
    : [];

  const history = Array.isArray(state.history)
    ? state.history
        .map((entry, index) => sanitizeHistoryEntry(entry, index))
        .filter(Boolean)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_HISTORY_ITEMS)
    : [];

  return {
    version: 1,
    schedules: schedules,
    history: history,
    updatedAt: parseTimestamp(state.updatedAt, Date.now()),
  };
}

function applyStatePatch(currentState, patch) {
  const next = normalizeState(currentState);
  if (!patch || typeof patch !== "object") {
    next.updatedAt = Date.now();
    return next;
  }

  if (Array.isArray(patch.schedules)) {
    next.schedules = normalizeState({ schedules: patch.schedules }).schedules;
  }
  if (Array.isArray(patch.history)) {
    next.history = normalizeState({ history: patch.history }).history;
  }
  if (patch.clearHistory) {
    next.history = [];
  }

  next.updatedAt = Date.now();
  return next;
}

async function loadOwnerState(ownerId) {
  const loaded = await loadJSONFromStore(ownerStateKey(ownerId), defaultOwnerState());
  return {
    state: normalizeState(loaded.value),
    backend: loaded.backend,
  };
}

async function saveOwnerState(ownerId, state) {
  const normalized = normalizeState(state);
  normalized.updatedAt = Date.now();
  const stateBackend = await saveJSONToStore(ownerStateKey(ownerId), normalized);
  const registryBackend = await registerOwner(ownerId);
  return {
    state: normalized,
    backend: stateBackend === registryBackend ? stateBackend : (stateBackend + "+" + registryBackend),
  };
}

async function listOwnerIds() {
  const loaded = await loadJSONFromStore(OWNER_REGISTRY_KEY, []);
  const rawOwners = Array.isArray(loaded.value) ? loaded.value : [];
  const owners = rawOwners
    .map((owner) => String(owner || "").trim())
    .filter(Boolean)
    .slice(-5000);
  return {
    owners: owners,
    backend: loaded.backend,
  };
}

async function registerOwner(ownerId) {
  const listed = await listOwnerIds();
  if (listed.owners.indexOf(ownerId) !== -1) {
    return listed.backend;
  }
  listed.owners.push(ownerId);
  return saveJSONToStore(OWNER_REGISTRY_KEY, listed.owners);
}

function computeNextRun(repeat, fromTs) {
  if (!Number.isFinite(fromTs) || fromTs <= 0) return null;
  if (HOBBY_CRON_ONLY && repeat === "hourly") return fromTs + 86400000;
  if (repeat === "hourly") return fromTs + 3600000;
  if (repeat === "daily") return fromTs + 86400000;
  return null;
}

function advanceNextRun(repeat, currentNextRunAt, nowTs) {
  let next = parseTimestamp(currentNextRunAt, nowTs);
  let safety = 0;
  while (Number.isFinite(next) && next <= nowTs && safety < 1000) {
    next = computeNextRun(repeat, next);
    if (next === null) return null;
    safety += 1;
  }
  if (safety >= 1000) return null;
  return next;
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0 || parts[0] >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) {
    return isPrivateIPv4(lower.slice(7));
  }
  return false;
}

function isPublicIP(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !isPrivateIPv4(ip);
  if (family === 6) return !isPrivateIPv6(ip);
  return false;
}

function isDisallowedHostname(hostname) {
  const lower = String(hostname || "").toLowerCase();
  return (
    lower === "localhost" ||
    lower === "localhost." ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  );
}

function validatePublicTargetURL(rawURL) {
  let targetURL;
  try {
    targetURL = new URL(rawURL);
  } catch (_) {
    throw new Error("Invalid URL.");
  }
  if (targetURL.protocol !== "http:" && targetURL.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (!targetURL.hostname) {
    throw new Error("Missing URL hostname.");
  }
  if (targetURL.username || targetURL.password) {
    throw new Error("Credentials in URLs are not allowed.");
  }
  if (isDisallowedHostname(targetURL.hostname)) {
    throw new Error("Target hostname is not allowed.");
  }
  return targetURL;
}

async function assertPublicResolution(targetURL) {
  const hostname = targetURL.hostname;
  if (net.isIP(hostname)) {
    if (!isPublicIP(hostname)) {
      throw new Error("Private and reserved IPs are blocked.");
    }
    return;
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error("Unable to resolve target host.");
  }
  const hasPrivateRecord = records.some((record) => !isPublicIP(record.address));
  if (hasPrivateRecord) {
    throw new Error("Target host resolves to a private or reserved IP.");
  }
}

async function fetchProbe(rawURL) {
  let currentURL = rawURL;
  for (let attempt = 0; attempt <= JOB_PROBE_MAX_REDIRECTS; attempt += 1) {
    const validatedURL = validatePublicTargetURL(currentURL);
    await assertPublicResolution(validatedURL);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JOB_PROBE_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(validatedURL.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": JOB_PROBE_USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400 && !!location;
    if (!isRedirect) {
      if (response.body && typeof response.body.cancel === "function") {
        response.body.cancel().catch(() => {});
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        message: "HTTP " + response.status,
      };
    }

    if (attempt === JOB_PROBE_MAX_REDIRECTS) {
      return { ok: false, statusCode: response.status, message: "Too many redirects." };
    }
    currentURL = new URL(location, validatedURL).toString();
  }
  return { ok: false, statusCode: 0, message: "Probe failed." };
}

function buildHistoryEntryFromRun(schedule, runResult, startedAt, finishedAt) {
  return {
    id: createID("job"),
    url: schedule.url,
    source: "server-cron",
    scheduleId: schedule.id,
    status: runResult.ok ? "success" : "error",
    startedAt: startedAt,
    finishedAt: finishedAt,
    durationMs: Math.max(finishedAt - startedAt, 0),
    message: clipString(runResult.message || "", 400),
  };
}

function normalizeScheduleURL(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  try {
    return new URL(value).toString();
  } catch (_) {
    return value;
  }
}

async function runSingleSchedule(schedule, nowTs, probeRunner) {
  const startedAt = Date.now();
  let runResult;
  const runner = typeof probeRunner === "function" ? probeRunner : fetchProbe;
  try {
    runResult = await runner(schedule.url);
  } catch (error) {
    runResult = {
      ok: false,
      statusCode: 0,
      message: error && error.message ? error.message : String(error),
    };
  }
  const finishedAt = Date.now();
  const historyEntry = buildHistoryEntryFromRun(schedule, runResult, startedAt, finishedAt);

  schedule.lastRunAt = nowTs;
  schedule.lastResult = historyEntry.status + (historyEntry.message ? (": " + historyEntry.message) : "");

  if (schedule.repeat === "none") {
    schedule.status = "completed";
    schedule.nextRunAt = null;
  } else {
    schedule.nextRunAt = advanceNextRun(schedule.repeat, schedule.nextRunAt || nowTs, nowTs);
    if (!schedule.nextRunAt) {
      schedule.status = "completed";
      schedule.lastResult = "error: unable to compute next run";
    }
  }

  return historyEntry;
}

async function runDueSchedulesForState(state, maxJobs, nowTs, options) {
  const normalized = normalizeState(state);
  const now = parseTimestamp(nowTs, Date.now());
  let jobsRun = 0;
  let successCount = 0;
  let errorCount = 0;
  let skippedDuplicateCount = 0;
  let historyPurged = 0;
  let changed = false;
  const probeRunner = options && typeof options.probeRunner === "function"
    ? options.probeRunner
    : fetchProbe;
  const recentURLRuns = Object.create(null);

  const dueSchedules = normalized.schedules
    .filter((schedule) => {
      return (
        schedule.status === "scheduled" &&
        Number.isFinite(schedule.nextRunAt) &&
        schedule.nextRunAt <= now
      );
    })
    .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0));

  const runLimit = Math.max(parseInt(maxJobs, 10) || 0, 0);
  for (let i = 0; i < dueSchedules.length; i += 1) {
    if (jobsRun >= runLimit) break;
    const schedule = dueSchedules[i];
    const normalizedURL = normalizeScheduleURL(schedule.url);
    if (
      normalizedURL &&
      Number.isFinite(recentURLRuns[normalizedURL]) &&
      (now - recentURLRuns[normalizedURL]) < JOBS_MIN_URL_SPACING_MS
    ) {
      schedule.lastRunAt = now;
      schedule.lastResult = "skipped: duplicate URL in current cron window";
      schedule.status = "scheduled";
      schedule.nextRunAt = now + JOBS_MIN_URL_SPACING_MS;
      skippedDuplicateCount += 1;
      changed = true;
      continue;
    }
    const entry = await runSingleSchedule(schedule, now, probeRunner);
    normalized.history.unshift(entry);
    jobsRun += 1;
    changed = true;
    if (normalizedURL) {
      recentURLRuns[normalizedURL] = now;
    }
    if (entry.status === "success") successCount += 1;
    else errorCount += 1;
  }

  if (JOBS_HISTORY_RETENTION_MS > 0) {
    const cutoffTs = now - JOBS_HISTORY_RETENTION_MS;
    const before = normalized.history.length;
    normalized.history = normalized.history.filter((entry) => {
      const ts = parseTimestamp(entry && entry.startedAt, 0);
      if (!ts) return true;
      return ts >= cutoffTs;
    });
    historyPurged += Math.max(before - normalized.history.length, 0);
    if (historyPurged > 0) changed = true;
  }

  if (normalized.history.length > MAX_HISTORY_ITEMS) {
    const beforeTrim = normalized.history.length;
    normalized.history = normalized.history.slice(0, MAX_HISTORY_ITEMS);
    historyPurged += Math.max(beforeTrim - normalized.history.length, 0);
    if (beforeTrim !== normalized.history.length) changed = true;
  }
  normalized.updatedAt = Date.now();

  return {
    state: normalized,
    jobsRun: jobsRun,
    successCount: successCount,
    errorCount: errorCount,
    skippedDuplicateCount: skippedDuplicateCount,
    historyPurged: historyPurged,
    changed: changed,
  };
}

function validateCronSecret(req) {
  const expected = String(process.env.CRON_SECRET || "").trim();
  if (!expected) {
    return { ok: true };
  }

  const query = req.query || {};
  const querySecret = toSingle(query.secret || query.cron_secret || "");
  const headerSecret = toSingle(req.headers["x-cron-secret"] || "");
  const auth = toSingle(req.headers.authorization || "");
  const authMatch = String(auth).match(/^Bearer\s+(.+)$/i);
  const bearerSecret = authMatch ? String(authMatch[1]).trim() : "";

  if (querySecret === expected || headerSecret === expected || bearerSecret === expected) {
    return { ok: true };
  }
  return { ok: false, statusCode: 401, message: "Unauthorized cron request." };
}

async function readJSONBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    try {
      return req.body ? JSON.parse(req.body) : {};
    } catch (_) {
      throw new Error("Invalid JSON body.");
    }
  }
  if (Buffer.isBuffer(req.body)) {
    const raw = req.body.toString("utf8");
    try {
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      throw new Error("Invalid JSON body.");
    }
  }

  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

module.exports = {
  CRON_MAX_JOBS_PER_RUN: CRON_MAX_JOBS_PER_RUN,
  MAX_HISTORY_ITEMS: MAX_HISTORY_ITEMS,
  applyStatePatch: applyStatePatch,
  loadOwnerState: loadOwnerState,
  saveOwnerState: saveOwnerState,
  listOwnerIds: listOwnerIds,
  readJSONBody: readJSONBody,
  resolveOwnerContext: resolveOwnerContext,
  runDueSchedulesForState: runDueSchedulesForState,
  JOBS_MIN_URL_SPACING_MS: JOBS_MIN_URL_SPACING_MS,
  JOBS_HISTORY_RETENTION_MS: JOBS_HISTORY_RETENTION_MS,
  sendErrorJSON: sendErrorJSON,
  sendJSON: sendJSON,
  validateCronSecret: validateCronSecret,
};
