"use strict";

const HISTORY_KEY_PREFIX = process.env.BENCHMARK_HISTORY_KEY_PREFIX || "dz:bench:history:v1:";
const BENCHMARK_HISTORY_MAX = Math.max(parseInt(process.env.BENCHMARK_HISTORY_MAX, 10) || 240, 1);

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
  if (!global.__dezoomifyBenchMemoryStore) {
    global.__dezoomifyBenchMemoryStore = new MemoryJSONStore();
  }
  return global.__dezoomifyBenchMemoryStore;
}

function createPrimaryStore() {
  const restURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (restURL && restToken) {
    return new KVRestJSONStore(restURL, restToken);
  }
  return memoryStore;
}

const memoryStore = getMemoryStore();
const primaryStore = createPrimaryStore();

function safeParseInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clipString(value, maxLength) {
  const str = String(value || "");
  if (!maxLength || str.length <= maxLength) return str;
  return str.slice(0, maxLength);
}

function normalizeSuiteName(value) {
  const raw = String(value || "jobs-state")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clipString(raw || "jobs-state", 64);
}

function createId() {
  return (
    "bench-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(16).slice(2, 10)
  );
}

function sanitizePayload(value, maxChars) {
  const fallback = { value: clipString(value, 512) };
  if (value === null || typeof value === "undefined") return {};
  if (typeof value === "string") return clipString(value, maxChars || 12000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return fallback;
  try {
    const raw = JSON.stringify(value);
    const limit = Math.max(safeParseInt(maxChars, 12000), 200);
    if (raw.length <= limit) {
      return JSON.parse(raw);
    }
    const clipped = clipString(raw, limit);
    return {
      truncated: true,
      size: raw.length,
      json: clipped,
    };
  } catch (_) {
    return fallback;
  }
}

function normalizeRun(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: clipString(raw.id || createId(), 128),
    suite: normalizeSuiteName(raw.suite || "jobs-state"),
    recordedAt: clipString(raw.recordedAt || new Date().toISOString(), 64),
    ts: Math.max(safeParseInt(raw.ts, Date.now()), 0),
    report: sanitizePayload(raw.report || {}, 64000),
    metadata: sanitizePayload(raw.metadata || {}, 24000),
  };
}

function normalizeRunArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((run) => normalizeRun(run))
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, BENCHMARK_HISTORY_MAX);
}

function suiteKey(suite) {
  return HISTORY_KEY_PREFIX + normalizeSuiteName(suite);
}

async function loadHistory(suite) {
  const key = suiteKey(suite);
  try {
    const value = await primaryStore.getJSON(key);
    return {
      backend: primaryStore.backendName(),
      key: key,
      runs: normalizeRunArray(value),
    };
  } catch (error) {
    console.error("Primary benchmark history backend failed, falling back to memory:", error);
    const value = await memoryStore.getJSON(key);
    return {
      backend: memoryStore.backendName(),
      key: key,
      runs: normalizeRunArray(value),
    };
  }
}

async function saveHistory(key, runs) {
  const normalizedRuns = normalizeRunArray(runs);
  try {
    await primaryStore.setJSON(key, normalizedRuns);
    return primaryStore.backendName();
  } catch (error) {
    console.error("Primary benchmark history write failed, falling back to memory:", error);
    await memoryStore.setJSON(key, normalizedRuns);
    return memoryStore.backendName();
  }
}

async function appendBenchmarkRun(suite, report, metadata) {
  const normalizedSuite = normalizeSuiteName(suite);
  const loaded = await loadHistory(normalizedSuite);
  const entry = normalizeRun({
    id: createId(),
    suite: normalizedSuite,
    recordedAt: new Date().toISOString(),
    ts: Date.now(),
    report: sanitizePayload(report || {}, 64000),
    metadata: sanitizePayload(metadata || {}, 24000),
  });
  const nextRuns = [entry].concat(loaded.runs).slice(0, BENCHMARK_HISTORY_MAX);
  const backend = await saveHistory(loaded.key, nextRuns);
  return {
    suite: normalizedSuite,
    backend: backend,
    total: nextRuns.length,
    entry: entry,
  };
}

async function listBenchmarkRuns(suite, limit) {
  const normalizedSuite = normalizeSuiteName(suite);
  const safeLimit = Math.max(Math.min(safeParseInt(limit, 30), 200), 1);
  const loaded = await loadHistory(normalizedSuite);
  return {
    suite: normalizedSuite,
    backend: loaded.backend,
    runs: loaded.runs.slice(0, safeLimit),
  };
}

function resetBenchmarkStoreForTests() {
  delete global.__dezoomifyBenchMemoryStore;
}

module.exports = {
  appendBenchmarkRun: appendBenchmarkRun,
  listBenchmarkRuns: listBenchmarkRuns,
  normalizeSuiteName: normalizeSuiteName,
  resetBenchmarkStoreForTests: resetBenchmarkStoreForTests,
};
