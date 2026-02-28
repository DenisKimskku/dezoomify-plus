"use strict";

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const ASYNC_OWNER_REGISTRY_KEY =
  process.env.ASYNC_OWNER_REGISTRY_KEY || "dz:async:owners:v1";
const ASYNC_OWNER_JOBS_KEY_PREFIX =
  process.env.ASYNC_OWNER_JOBS_KEY_PREFIX || "dz:async:owner-jobs:v1:";
const ASYNC_JOB_KEY_PREFIX =
  process.env.ASYNC_JOB_KEY_PREFIX || "dz:async:job:v1:";
const ASYNC_ARTIFACT_CHUNK_KEY_PREFIX =
  process.env.ASYNC_ARTIFACT_CHUNK_KEY_PREFIX || "dz:async:artifact-chunk:v1:";
const ASYNC_MAX_JOBS_PER_OWNER =
  Math.max(parseInt(process.env.ASYNC_MAX_JOBS_PER_OWNER, 10) || 200, 1);
const ASYNC_MAX_JOBS_PER_CRON_RUN =
  Math.max(parseInt(process.env.ASYNC_MAX_JOBS_PER_CRON_RUN, 10) || 20, 1);
const ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN =
  Math.max(parseInt(process.env.ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN, 10) || 120, 1);
const ASYNC_CLEANUP_EXPIRED_GRACE_RAW =
  parseInt(process.env.ASYNC_CLEANUP_EXPIRED_GRACE_MS, 10);
const ASYNC_CLEANUP_EXPIRED_GRACE_MS =
  Number.isFinite(ASYNC_CLEANUP_EXPIRED_GRACE_RAW)
    ? Math.max(ASYNC_CLEANUP_EXPIRED_GRACE_RAW, 0)
    : (60 * 60 * 1000);
const ASYNC_FINISHED_RETENTION_RAW =
  parseInt(process.env.ASYNC_FINISHED_RETENTION_MS, 10);
const ASYNC_FINISHED_RETENTION_MS =
  Number.isFinite(ASYNC_FINISHED_RETENTION_RAW)
    ? Math.max(ASYNC_FINISHED_RETENTION_RAW, 0)
    : (7 * 24 * 60 * 60 * 1000);
const ASYNC_BULK_MAX_IDS =
  Math.max(parseInt(process.env.ASYNC_BULK_MAX_IDS, 10) || 80, 1);
const ASYNC_LIST_MAX_LIMIT =
  Math.max(parseInt(process.env.ASYNC_LIST_MAX_LIMIT, 10) || 120, 1);
const ASYNC_JOB_TTL_MS =
  Math.max(parseInt(process.env.ASYNC_JOB_TTL_MS, 10) || (24 * 60 * 60 * 1000), 60000);
const ASYNC_ARTIFACT_TTL_MS =
  Math.max(parseInt(process.env.ASYNC_ARTIFACT_TTL_MS, 10) || ASYNC_JOB_TTL_MS, 60000);
const ASYNC_ARTIFACT_STORAGE_MODE = /^(inline|chunked|auto)$/i.test(
  String(process.env.ASYNC_ARTIFACT_STORAGE_MODE || "")
)
  ? String(process.env.ASYNC_ARTIFACT_STORAGE_MODE || "").toLowerCase()
  : "auto";
const ASYNC_MAX_INLINE_ARTIFACT_BYTES =
  Math.max(parseInt(process.env.ASYNC_MAX_INLINE_ARTIFACT_BYTES, 10) || (1024 * 1024), 1024);
const ASYNC_ARTIFACT_CHUNK_BYTES =
  Math.max(parseInt(process.env.ASYNC_ARTIFACT_CHUNK_BYTES, 10) || (192 * 1024), 1024);
const ASYNC_MAX_ARTIFACT_CHUNKS =
  Math.max(parseInt(process.env.ASYNC_MAX_ARTIFACT_CHUNKS, 10) || 128, 1);
const ASYNC_MAX_ARTIFACT_BYTES =
  Math.max(
    parseInt(process.env.ASYNC_MAX_ARTIFACT_BYTES, 10) || (8 * 1024 * 1024),
    ASYNC_MAX_INLINE_ARTIFACT_BYTES
  );
const ASYNC_PROBE_TIMEOUT_MS =
  Math.max(parseInt(process.env.ASYNC_PROBE_TIMEOUT_MS, 10) || 15000, 1000);
const ASYNC_PROBE_MAX_REDIRECTS =
  Math.max(parseInt(process.env.ASYNC_PROBE_MAX_REDIRECTS, 10) || 2, 0);
const ASYNC_PROBE_USER_AGENT =
  process.env.ASYNC_PROBE_USER_AGENT ||
  "dezoomify-async-service/1.0 (+https://github.com/lovasoa/dezoomify)";
const ASYNC_ALLOWED_STATUSES = ["queued", "running", "completed", "error", "expired", "canceled"];

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

  async deleteJSON(key) {
    this.values.delete(key);
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

  async deleteJSON(key) {
    await this.command("del", [key]);
  }
}

function getMemoryStore() {
  if (!global.__dezoomifyAsyncMemoryStore) {
    global.__dezoomifyAsyncMemoryStore = new MemoryJSONStore();
  }
  return global.__dezoomifyAsyncMemoryStore;
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

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function clipString(value, maxLength) {
  const str = String(value || "");
  if (!maxLength || str.length <= maxLength) return str;
  return str.slice(0, maxLength);
}

function parseTimestamp(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function hashString(value) {
  if (Buffer.isBuffer(value)) {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
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

function buildAnonOwnerId(req) {
  return "anon:" + hashString(getClientKey(req)).slice(0, 16);
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
  for (let attempt = 0; attempt <= ASYNC_PROBE_MAX_REDIRECTS; attempt += 1) {
    const validatedURL = validatePublicTargetURL(currentURL);
    await assertPublicResolution(validatedURL);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASYNC_PROBE_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(validatedURL.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": ASYNC_PROBE_USER_AGENT,
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

    if (attempt === ASYNC_PROBE_MAX_REDIRECTS) {
      return { ok: false, statusCode: response.status, message: "Too many redirects." };
    }
    currentURL = new URL(location, validatedURL).toString();
  }
  return { ok: false, statusCode: 0, message: "Probe failed." };
}

function safeMessage(value) {
  return clipString(value || "", 800);
}

function defaultJob(ownerId, ownerLabel, targetURL) {
  const now = Date.now();
  return {
    id: createID("async"),
    ownerId: clipString(ownerId || "", 140),
    ownerLabel: clipString(ownerLabel || ownerId || "", 100),
    targetURL: clipString(targetURL || "", 4096),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    expiresAt: now + ASYNC_JOB_TTL_MS,
    error: "",
    artifact: null,
  };
}

function inferArtifactStorage(raw) {
  const explicit = String(raw && raw.storage ? raw.storage : "").toLowerCase();
  if (explicit === "inline" || explicit === "chunked") return explicit;
  if (raw && raw.chunkCount) return "chunked";
  return "inline";
}

function sanitizeArtifact(raw) {
  if (!raw || typeof raw !== "object") return null;
  const size = Math.max(parseInt(raw.size, 10) || 0, 0);
  if (size <= 0 || size > ASYNC_MAX_ARTIFACT_BYTES) return null;
  const expiresAt = parseTimestamp(raw.expiresAt, Date.now() + ASYNC_ARTIFACT_TTL_MS);
  const base = {
    contentType: clipString(raw.contentType || "application/octet-stream", 120),
    filename: clipString(raw.filename || "artifact.bin", 200),
    size: size,
    sha256: clipString(raw.sha256 || "", 80),
    createdAt: parseTimestamp(raw.createdAt, Date.now()),
    expiresAt: expiresAt,
  };

  const storage = inferArtifactStorage(raw);
  if (storage === "chunked") {
    const chunkCount = Math.max(parseInt(raw.chunkCount, 10) || 0, 0);
    if (chunkCount <= 0 || chunkCount > ASYNC_MAX_ARTIFACT_CHUNKS) return null;
    const chunkBytes = Math.max(parseInt(raw.chunkBytes, 10) || ASYNC_ARTIFACT_CHUNK_BYTES, 1);
    const expectedChunks = Math.ceil(size / chunkBytes);
    if (expectedChunks > ASYNC_MAX_ARTIFACT_CHUNKS) return null;
    const chunkKeyPrefix = clipString(
      raw.chunkKeyPrefix || artifactChunkKeyPrefix(raw.jobId || ""),
      260
    );
    if (!chunkKeyPrefix) return null;
    return Object.assign(base, {
      storage: "chunked",
      chunkCount: chunkCount,
      chunkBytes: chunkBytes,
      chunkKeyPrefix: chunkKeyPrefix,
    });
  }

  const maxBase64Length = Math.ceil(ASYNC_MAX_ARTIFACT_BYTES * 4 / 3) + 16;
  const dataB64 = clipString(raw.dataB64 || "", maxBase64Length + 20);
  if (!dataB64 || dataB64.length > maxBase64Length) return null;
  return Object.assign(base, {
    storage: "inline",
    dataB64: dataB64,
  });
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== "object") return null;
  const createdAt = parseTimestamp(raw.createdAt, Date.now());
  const expiresAt = parseTimestamp(raw.expiresAt, createdAt + ASYNC_JOB_TTL_MS);
  const status =
    raw.status === "queued" ||
    raw.status === "running" ||
    raw.status === "completed" ||
    raw.status === "error" ||
    raw.status === "expired" ||
    raw.status === "canceled"
      ? raw.status
      : "queued";
  return {
    id: clipString(raw.id || createID("async"), 140),
    ownerId: clipString(raw.ownerId || "", 140),
    ownerLabel: clipString(raw.ownerLabel || raw.ownerId || "", 100),
    targetURL: clipString(raw.targetURL || "", 4096),
    status: status,
    createdAt: createdAt,
    updatedAt: parseTimestamp(raw.updatedAt, Date.now()),
    startedAt: parseTimestamp(raw.startedAt, null),
    finishedAt: parseTimestamp(raw.finishedAt, null),
    expiresAt: expiresAt,
    error: safeMessage(raw.error || ""),
    artifact: sanitizeArtifact(raw.artifact),
  };
}

function jobKey(jobId) {
  return ASYNC_JOB_KEY_PREFIX + String(jobId || "");
}

function ownerJobsKey(ownerId) {
  return ASYNC_OWNER_JOBS_KEY_PREFIX + String(ownerId || "");
}

function artifactChunkKeyPrefix(jobId) {
  return ASYNC_ARTIFACT_CHUNK_KEY_PREFIX + String(jobId || "") + ":";
}

async function loadJSONFromStore(key, fallbackValue) {
  try {
    const value = await primaryStore.getJSON(key);
    if (value === null || typeof value === "undefined") {
      return { value: fallbackValue, backend: primaryStore.backendName() };
    }
    return { value: value, backend: primaryStore.backendName() };
  } catch (error) {
    console.error("Primary async backend failed, falling back to memory:", error);
    const value = await memoryStore.getJSON(key);
    if (value === null || typeof value === "undefined") {
      return { value: fallbackValue, backend: memoryStore.backendName() };
    }
    return { value: value, backend: memoryStore.backendName() };
  }
}

async function saveJSONToStore(key, value) {
  try {
    await primaryStore.setJSON(key, value);
    return primaryStore.backendName();
  } catch (error) {
    console.error("Primary async backend write failed, falling back to memory:", error);
    await memoryStore.setJSON(key, value);
    return memoryStore.backendName();
  }
}

async function deleteJSONFromStore(key) {
  try {
    if (typeof primaryStore.deleteJSON === "function") {
      await primaryStore.deleteJSON(key);
    } else {
      await primaryStore.setJSON(key, null);
    }
    return primaryStore.backendName();
  } catch (error) {
    console.error("Primary async backend delete failed, falling back to memory:", error);
    if (typeof memoryStore.deleteJSON === "function") {
      await memoryStore.deleteJSON(key);
    } else {
      await memoryStore.setJSON(key, null);
    }
    return memoryStore.backendName();
  }
}

async function registerOwner(ownerId) {
  const listed = await listOwnerIds();
  if (listed.owners.indexOf(ownerId) !== -1) {
    return listed.backend;
  }
  listed.owners.push(ownerId);
  return saveJSONToStore(ASYNC_OWNER_REGISTRY_KEY, listed.owners.slice(-5000));
}

async function listOwnerIds() {
  const loaded = await loadJSONFromStore(ASYNC_OWNER_REGISTRY_KEY, []);
  const rawOwners = Array.isArray(loaded.value) ? loaded.value : [];
  const owners = rawOwners
    .map((owner) => clipString(owner || "", 140))
    .filter(Boolean)
    .slice(-5000);
  return {
    owners: owners,
    backend: loaded.backend,
  };
}

async function loadOwnerJobIDs(ownerId) {
  const loaded = await loadJSONFromStore(ownerJobsKey(ownerId), []);
  const ids = Array.isArray(loaded.value)
    ? loaded.value.map((id) => clipString(id || "", 140)).filter(Boolean)
    : [];
  return {
    ids: ids,
    backend: loaded.backend,
  };
}

async function saveOwnerJobIDs(ownerId, jobIDs) {
  const ids = Array.isArray(jobIDs)
    ? jobIDs.map((id) => clipString(id || "", 140)).filter(Boolean)
    : [];
  const unique = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (unique.indexOf(id) !== -1) continue;
    unique.push(id);
  }
  const kept = unique.slice(0, ASYNC_MAX_JOBS_PER_OWNER);
  const removed = unique.slice(ASYNC_MAX_JOBS_PER_OWNER);
  const backend = await saveJSONToStore(ownerJobsKey(ownerId), kept);
  for (let i = 0; i < removed.length; i += 1) {
    const loaded = await loadJob(removed[i]);
    if (loaded.job) {
      await deleteJobRecord(loaded.job);
    } else {
      await deleteJSONFromStore(jobKey(removed[i]));
    }
  }
  return {
    backend: backend,
    ids: kept,
    removed: removed,
  };
}

async function loadJob(jobId) {
  const loaded = await loadJSONFromStore(jobKey(jobId), null);
  const job = normalizeJob(loaded.value);
  return {
    job: job,
    backend: loaded.backend,
  };
}

async function saveJob(job) {
  const normalized = normalizeJob(job);
  if (!normalized) throw new Error("Invalid async job.");
  normalized.updatedAt = Date.now();
  const backend = await saveJSONToStore(jobKey(normalized.id), normalized);
  return {
    job: normalized,
    backend: backend,
  };
}

function isJobExpired(job, nowTs) {
  if (!job) return true;
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  return Number.isFinite(job.expiresAt) && job.expiresAt <= now;
}

function isArtifactExpired(job, nowTs) {
  if (!job || !job.artifact) return true;
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  const expiresAt = parseTimestamp(job.artifact.expiresAt, 0);
  return !expiresAt || expiresAt <= now;
}

async function markJobExpired(job) {
  if (!job) return null;
  if (job.status === "expired" && !job.artifact) return job;
  if (job.artifact) {
    await deleteArtifactStorage(job.artifact, job.id);
  }
  job.status = "expired";
  job.artifact = null;
  job.error = safeMessage(job.error || "Artifact expired.");
  const saved = await saveJob(job);
  return saved.job;
}

async function deleteJobRecord(job) {
  const normalized = normalizeJob(job);
  if (!normalized) return false;
  if (normalized.artifact) {
    await deleteArtifactStorage(normalized.artifact, normalized.id);
  }
  await deleteJSONFromStore(jobKey(normalized.id));
  return true;
}

function buildArtifactFromProbe(job, probeResult) {
  const result = probeResult && typeof probeResult === "object" ? probeResult : {};
  const payload = {
    jobId: job.id,
    owner: job.ownerLabel,
    targetURL: job.targetURL,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    status: {
      ok: !!result.ok,
      statusCode: Number(result.statusCode) || 0,
      message: safeMessage(result.message || ""),
    },
  };
  let bytes = Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8");
  if (bytes.length > ASYNC_MAX_ARTIFACT_BYTES) {
    payload.status.message = safeMessage(payload.status.message).slice(0, 240);
    payload.truncated = true;
    bytes = Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  if (bytes.length > ASYNC_MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact payload exceeded size limit.");
  }
  return {
    contentType: "application/json; charset=utf-8",
    filename: "dezoomify-job-" + job.id + ".json",
    bytes: bytes,
  };
}

async function deleteArtifactStorage(artifact, jobId) {
  const safe = sanitizeArtifact(artifact);
  if (!safe || safe.storage !== "chunked") return;
  const keyPrefix = safe.chunkKeyPrefix || artifactChunkKeyPrefix(jobId);
  for (let i = 0; i < safe.chunkCount; i += 1) {
    await deleteJSONFromStore(keyPrefix + i);
  }
}

async function persistArtifactData(jobId, artifactInfo) {
  if (!artifactInfo || !Buffer.isBuffer(artifactInfo.bytes)) {
    throw new Error("Missing artifact payload.");
  }
  const bytes = artifactInfo.bytes;
  if (!bytes.length) {
    throw new Error("Artifact payload is empty.");
  }
  if (bytes.length > ASYNC_MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact payload exceeded size limit.");
  }

  const now = Date.now();
  const base = {
    contentType: clipString(artifactInfo.contentType || "application/octet-stream", 120),
    filename: clipString(artifactInfo.filename || "artifact.bin", 200),
    size: bytes.length,
    sha256: hashString(bytes),
    createdAt: now,
    expiresAt: now + ASYNC_ARTIFACT_TTL_MS,
  };

  const inlineAllowed = ASYNC_ARTIFACT_STORAGE_MODE !== "chunked";
  const forceInline = ASYNC_ARTIFACT_STORAGE_MODE === "inline";
  const shouldInline = inlineAllowed && (forceInline || bytes.length <= ASYNC_MAX_INLINE_ARTIFACT_BYTES);
  if (shouldInline) {
    if (bytes.length > ASYNC_MAX_INLINE_ARTIFACT_BYTES) {
      throw new Error("Artifact payload exceeded inline storage limit.");
    }
    return Object.assign(base, {
      storage: "inline",
      dataB64: bytes.toString("base64"),
    });
  }

  const chunkCount = Math.ceil(bytes.length / ASYNC_ARTIFACT_CHUNK_BYTES);
  if (chunkCount > ASYNC_MAX_ARTIFACT_CHUNKS) {
    throw new Error("Artifact payload exceeded chunk storage limit.");
  }
  const keyPrefix = artifactChunkKeyPrefix(jobId);
  for (let i = 0; i < chunkCount; i += 1) {
    const start = i * ASYNC_ARTIFACT_CHUNK_BYTES;
    const end = Math.min(start + ASYNC_ARTIFACT_CHUNK_BYTES, bytes.length);
    const chunkB64 = bytes.subarray(start, end).toString("base64");
    await saveJSONToStore(keyPrefix + i, chunkB64);
  }

  return Object.assign(base, {
    storage: "chunked",
    chunkCount: chunkCount,
    chunkBytes: ASYNC_ARTIFACT_CHUNK_BYTES,
    chunkKeyPrefix: keyPrefix,
  });
}

async function buildArtifactBufferFromJob(job) {
  if (!job || !job.artifact) return null;
  const artifact = sanitizeArtifact(job.artifact);
  if (!artifact) return null;

  if (artifact.storage === "chunked") {
    const chunks = [];
    const keyPrefix = artifact.chunkKeyPrefix || artifactChunkKeyPrefix(job.id);
    for (let i = 0; i < artifact.chunkCount; i += 1) {
      const loaded = await loadJSONFromStore(keyPrefix + i, null);
      if (typeof loaded.value !== "string" || !loaded.value) {
        return null;
      }
      try {
        chunks.push(Buffer.from(loaded.value, "base64"));
      } catch (_) {
        return null;
      }
    }
    try {
      const buffer = Buffer.concat(chunks);
      if (!buffer.length || buffer.length !== artifact.size || buffer.length > ASYNC_MAX_ARTIFACT_BYTES) {
        return null;
      }
      return buffer;
    } catch (_) {
      return null;
    }
  }

  try {
    const buffer = Buffer.from(artifact.dataB64 || "", "base64");
    if (!buffer.length || buffer.length !== artifact.size || buffer.length > ASYNC_MAX_ARTIFACT_BYTES) {
      return null;
    }
    return buffer;
  } catch (_) {
    return null;
  }
}

function validateTargetURL(rawURL) {
  const parsed = validatePublicTargetURL(rawURL);
  return parsed.toString();
}

async function submitJob(ownerId, ownerLabel, targetURL) {
  const normalizedOwnerId = clipString(ownerId || "", 140).trim();
  if (!normalizedOwnerId) throw new Error("Missing owner id.");
  const normalizedOwnerLabel = clipString(ownerLabel || normalizedOwnerId, 100).trim();
  const normalizedURL = validateTargetURL(targetURL);

  const job = defaultJob(normalizedOwnerId, normalizedOwnerLabel, normalizedURL);
  const saved = await saveJob(job);
  const list = await loadOwnerJobIDs(normalizedOwnerId);
  const nextIDs = [saved.job.id].concat(list.ids);
  const ownerSaved = await saveOwnerJobIDs(normalizedOwnerId, nextIDs);
  const ownerBackend = await registerOwner(normalizedOwnerId);
  return {
    job: saved.job,
    backend:
      saved.backend === ownerSaved.backend && ownerSaved.backend === ownerBackend
        ? saved.backend
        : (saved.backend + "+" + ownerSaved.backend + "+" + ownerBackend),
  };
}

function buildPublicJob(job) {
  const safe = normalizeJob(job);
  if (!safe) return null;
  const now = Date.now();
  const artifactAvailable = !!safe.artifact && !isArtifactExpired(safe, now);
  return {
    id: safe.id,
    owner: safe.ownerLabel,
    targetURL: safe.targetURL,
    status: safe.status,
    createdAt: safe.createdAt,
    updatedAt: safe.updatedAt,
    startedAt: safe.startedAt,
    finishedAt: safe.finishedAt,
    expiresAt: safe.expiresAt,
    error: safe.error || "",
    artifactAvailable: artifactAvailable,
    artifact: artifactAvailable
        ? {
          contentType: safe.artifact.contentType,
          filename: safe.artifact.filename,
          size: safe.artifact.size,
          sha256: safe.artifact.sha256,
          expiresAt: safe.artifact.expiresAt,
          storage: safe.artifact.storage || "inline",
        }
      : null,
  };
}

function normalizeStatusFilters(rawStatuses) {
  const source = Array.isArray(rawStatuses)
    ? rawStatuses
    : String(rawStatuses || "").split(",");
  const unique = [];
  for (let i = 0; i < source.length; i += 1) {
    const value = String(source[i] || "").trim().toLowerCase();
    if (!value) continue;
    if (ASYNC_ALLOWED_STATUSES.indexOf(value) === -1) continue;
    if (unique.indexOf(value) !== -1) continue;
    unique.push(value);
  }
  return unique;
}

function normalizeJobIDFilters(rawIds) {
  const source = Array.isArray(rawIds)
    ? rawIds
    : String(rawIds || "").split(",");
  const unique = [];
  for (let i = 0; i < source.length; i += 1) {
    const value = clipString(source[i] || "", 140).trim();
    if (!value) continue;
    if (unique.indexOf(value) !== -1) continue;
    unique.push(value);
    if (unique.length >= ASYNC_BULK_MAX_IDS) break;
  }
  return unique;
}

function matchesSearchQuery(job, rawQuery) {
  const needle = String(rawQuery || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack =
    String(job.id || "") + "\n" +
    String(job.targetURL || "") + "\n" +
    String(job.status || "") + "\n" +
    String(job.error || "");
  return haystack.toLowerCase().indexOf(needle) !== -1;
}

async function getJobForOwner(ownerId, jobId) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  const loaded = await loadJob(jobId);
  if (!loaded.job) return { job: null, backend: loaded.backend, reason: "not_found" };
  if (loaded.job.ownerId !== normalizedOwnerId) {
    return { job: null, backend: loaded.backend, reason: "not_found" };
  }
  const now = Date.now();
  let job = loaded.job;
  if (isJobExpired(job, now)) {
    job = await markJobExpired(job);
    return { job: job, backend: loaded.backend, reason: "expired" };
  }
  if (job.artifact && isArtifactExpired(job, now)) {
    job = await markJobExpired(job);
    return { job: job, backend: loaded.backend, reason: "expired" };
  }
  return { job: job, backend: loaded.backend, reason: "ok" };
}

async function listJobsForOwner(ownerId, options) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  if (!normalizedOwnerId) {
    return {
      jobs: [],
      total: 0,
      nextCursor: null,
      cursor: 0,
      limit: 0,
      backend: "none",
      statuses: [],
      query: "",
    };
  }

  const opts = options && typeof options === "object" ? options : {};
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 30, 1), ASYNC_LIST_MAX_LIMIT);
  const cursor = Math.max(parseInt(opts.cursor, 10) || 0, 0);
  const query = clipString(opts.query || "", 200).trim();
  const statuses = normalizeStatusFilters(opts.statuses || opts.status);

  const ownerJobs = await loadOwnerJobIDs(normalizedOwnerId);
  const filtered = [];

  for (let i = 0; i < ownerJobs.ids.length; i += 1) {
    const fetched = await getJobForOwner(normalizedOwnerId, ownerJobs.ids[i]);
    if (!fetched.job) continue;
    if (statuses.length && statuses.indexOf(fetched.job.status) === -1) continue;
    if (!matchesSearchQuery(fetched.job, query)) continue;
    filtered.push(fetched.job);
  }

  const page = filtered.slice(cursor, cursor + limit);
  const nextCursor = (cursor + limit) < filtered.length
    ? String(cursor + limit)
    : null;

  return {
    jobs: page,
    total: filtered.length,
    nextCursor: nextCursor,
    cursor: cursor,
    limit: limit,
    backend: ownerJobs.backend,
    statuses: statuses,
    query: query,
  };
}

async function processSingleJob(job, probeRunner) {
  const runner = typeof probeRunner === "function" ? probeRunner : fetchProbe;
  const startedAt = Date.now();
  job.status = "running";
  job.startedAt = startedAt;
  job.error = "";
  await saveJob(job);

  let result;
  try {
    result = await runner(job.targetURL);
  } catch (error) {
    result = {
      ok: false,
      statusCode: 0,
      message: error && error.message ? error.message : String(error),
    };
  }

  const finishedAt = Date.now();
  job.finishedAt = finishedAt;
  job.error = result && result.ok ? "" : safeMessage(result && result.message ? result.message : "Job failed.");
  try {
    const artifactInfo = buildArtifactFromProbe(job, result);
    if (job.artifact) {
      await deleteArtifactStorage(job.artifact, job.id);
    }
    job.artifact = await persistArtifactData(job.id, artifactInfo);
  } catch (error) {
    if (job.artifact) {
      await deleteArtifactStorage(job.artifact, job.id);
    }
    job.artifact = null;
    job.error = safeMessage(error && error.message ? error.message : String(error));
  }
  job.status = result && result.ok ? "completed" : "error";
  if (!job.artifact) {
    job.status = "error";
  }

  const saved = await saveJob(job);
  return saved.job;
}

async function runJobNowForOwner(ownerId, jobId, options) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  if (!normalizedOwnerId) {
    return {
      job: null,
      reason: "missing_owner",
      statusCode: 400,
    };
  }
  const fetched = await getJobForOwner(normalizedOwnerId, jobId);
  if (!fetched.job) {
    return {
      job: null,
      reason: "not_found",
      statusCode: 404,
    };
  }
  if (fetched.job.status !== "queued") {
    return {
      job: fetched.job,
      reason: "not_queued",
      statusCode: 409,
    };
  }

  const processed = await processSingleJob(fetched.job, options && options.probeRunner);
  return {
    job: processed,
    reason: "processed",
    statusCode: 200,
  };
}

async function cancelJobForOwner(ownerId, jobId) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  if (!normalizedOwnerId) {
    return {
      job: null,
      reason: "missing_owner",
      statusCode: 400,
      message: "Missing owner id.",
    };
  }
  const fetched = await getJobForOwner(normalizedOwnerId, jobId);
  if (!fetched.job) {
    return {
      job: null,
      reason: "not_found",
      statusCode: 404,
      message: "Job not found.",
    };
  }
  const job = fetched.job;
  if (job.status !== "queued") {
    return {
      job: job,
      reason: "not_cancelable",
      statusCode: 409,
      message: "Only queued jobs can be canceled.",
    };
  }

  job.status = "canceled";
  job.updatedAt = Date.now();
  job.finishedAt = job.updatedAt;
  job.error = "Canceled by user.";
  const saved = await saveJob(job);
  return {
    job: saved.job,
    reason: "canceled",
    statusCode: 200,
    message: "",
    backend: saved.backend,
  };
}

async function cleanupExpiredJobsForOwner(ownerId, maxJobs, nowTs) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  if (!normalizedOwnerId) {
    return {
      ownersProcessed: 0,
      jobsScanned: 0,
      jobsMarkedExpired: 0,
      jobsPurged: 0,
      jobsFinishedPurged: 0,
      missingRemoved: 0,
    };
  }

  const limit = Math.max(parseInt(maxJobs, 10) || 0, 0);
  if (limit <= 0) {
    return {
      ownersProcessed: 0,
      jobsScanned: 0,
      jobsMarkedExpired: 0,
      jobsPurged: 0,
      jobsFinishedPurged: 0,
      missingRemoved: 0,
    };
  }

  const now = parseTimestamp(nowTs, Date.now());
  const ownerJobs = await loadOwnerJobIDs(normalizedOwnerId);
  const ids = ownerJobs.ids || [];
  if (!ids.length) {
    return {
      ownersProcessed: 0,
      jobsScanned: 0,
      jobsMarkedExpired: 0,
      jobsPurged: 0,
      jobsFinishedPurged: 0,
      missingRemoved: 0,
    };
  }

  let remaining = limit;
  let jobsScanned = 0;
  let jobsMarkedExpired = 0;
  let jobsPurged = 0;
  let jobsFinishedPurged = 0;
  let missingRemoved = 0;
  let changed = false;
  const nextIDs = [];

  for (let i = 0; i < ids.length; i += 1) {
    const jobId = ids[i];
    if (remaining <= 0) {
      nextIDs.push(jobId);
      continue;
    }

    remaining -= 1;
    jobsScanned += 1;

    const loaded = await loadJob(jobId);
    if (!loaded.job || loaded.job.ownerId !== normalizedOwnerId) {
      missingRemoved += 1;
      changed = true;
      continue;
    }

    const job = loaded.job;
    const shouldExpire =
      isJobExpired(job, now) ||
      (job.artifact && isArtifactExpired(job, now));
    if (!shouldExpire) {
      if (
        ASYNC_FINISHED_RETENTION_MS > 0 &&
        (job.status === "completed" || job.status === "error" || job.status === "canceled")
      ) {
        const referenceTs = parseTimestamp(job.finishedAt, parseTimestamp(job.updatedAt, now));
        if (referenceTs > 0 && (now - referenceTs) >= ASYNC_FINISHED_RETENTION_MS) {
          await deleteJobRecord(job);
          jobsFinishedPurged += 1;
          changed = true;
          continue;
        }
      }
      nextIDs.push(jobId);
      continue;
    }

    let expiredJob = job;
    if (job.status !== "expired" || !!job.artifact) {
      expiredJob = await markJobExpired(job);
      jobsMarkedExpired += 1;
      changed = true;
    }

    const expiresAt = parseTimestamp(expiredJob && expiredJob.expiresAt, now);
    const ageAfterExpiryMs = Math.max(now - expiresAt, 0);
    if (ageAfterExpiryMs >= ASYNC_CLEANUP_EXPIRED_GRACE_MS) {
      await deleteJobRecord(expiredJob || job);
      jobsPurged += 1;
      changed = true;
      continue;
    }

    nextIDs.push(jobId);
  }

  if (changed || nextIDs.length !== ids.length) {
    await saveOwnerJobIDs(normalizedOwnerId, nextIDs);
  }

  return {
    ownersProcessed: 1,
    jobsScanned: jobsScanned,
    jobsMarkedExpired: jobsMarkedExpired,
    jobsPurged: jobsPurged,
    jobsFinishedPurged: jobsFinishedPurged,
    missingRemoved: missingRemoved,
  };
}

async function runPendingJobsForOwner(ownerId, maxJobs, options) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  if (!normalizedOwnerId) {
    return {
      ownersProcessed: 0,
      jobsRun: 0,
      successCount: 0,
      errorCount: 0,
    };
  }
  const limit = Math.max(parseInt(maxJobs, 10) || 0, 0);
  if (limit <= 0) {
    return {
      ownersProcessed: 0,
      jobsRun: 0,
      successCount: 0,
      errorCount: 0,
    };
  }

  const now = Date.now();
  const ownerJobs = await loadOwnerJobIDs(normalizedOwnerId);
  let jobsRun = 0;
  let successCount = 0;
  let errorCount = 0;
  let ownersProcessed = 0;

  const ids = ownerJobs.ids.slice().reverse();
  if (ids.length > 0) ownersProcessed = 1;
  for (let i = 0; i < ids.length; i += 1) {
    if (jobsRun >= limit) break;
    const loaded = await loadJob(ids[i]);
    const job = loaded.job;
    if (!job || job.ownerId !== normalizedOwnerId) continue;
    if (isJobExpired(job, now)) {
      await markJobExpired(job);
      continue;
    }
    if (job.status !== "queued") continue;
    const processed = await processSingleJob(job, options && options.probeRunner);
    jobsRun += 1;
    if (processed.status === "completed") successCount += 1;
    else errorCount += 1;
  }

  return {
    ownersProcessed: ownersProcessed,
    jobsRun: jobsRun,
    successCount: successCount,
    errorCount: errorCount,
  };
}

async function runPendingJobs(maxJobs, nowTs, options) {
  const limit = Math.max(parseInt(maxJobs, 10) || 0, 0);
  if (limit <= 0) {
    return {
      ownersSeen: 0,
      ownersProcessed: 0,
      jobsRun: 0,
      successCount: 0,
      errorCount: 0,
      backend: "none",
    };
  }

  const ownerList = await listOwnerIds();
  let remaining = limit;
  let ownersProcessed = 0;
  let jobsRun = 0;
  let successCount = 0;
  let errorCount = 0;
  const owners = ownerList.owners || [];

  for (let i = 0; i < owners.length; i += 1) {
    if (remaining <= 0) break;
    const ownerId = owners[i];
    const result = await runPendingJobsForOwner(ownerId, remaining, options);
    if (result.ownersProcessed > 0) ownersProcessed += 1;
    remaining -= result.jobsRun;
    jobsRun += result.jobsRun;
    successCount += result.successCount;
    errorCount += result.errorCount;
  }

  return {
    ownersSeen: owners.length,
    ownersProcessed: ownersProcessed,
    jobsRun: jobsRun,
    successCount: successCount,
    errorCount: errorCount,
    backend: ownerList.backend,
    at: parseTimestamp(nowTs, Date.now()),
  };
}

async function cleanupExpiredJobs(maxJobs, nowTs) {
  const limit = Math.max(parseInt(maxJobs, 10) || 0, 0);
  if (limit <= 0) {
    return {
      ownersSeen: 0,
      ownersProcessed: 0,
      jobsScanned: 0,
      jobsMarkedExpired: 0,
      jobsPurged: 0,
      jobsFinishedPurged: 0,
      missingRemoved: 0,
      backend: "none",
      at: parseTimestamp(nowTs, Date.now()),
    };
  }

  const ownerList = await listOwnerIds();
  const owners = ownerList.owners || [];
  let remaining = limit;
  let ownersProcessed = 0;
  let jobsScanned = 0;
  let jobsMarkedExpired = 0;
  let jobsPurged = 0;
  let jobsFinishedPurged = 0;
  let missingRemoved = 0;

  for (let i = 0; i < owners.length; i += 1) {
    if (remaining <= 0) break;
    const ownerId = owners[i];
    const result = await cleanupExpiredJobsForOwner(ownerId, remaining, nowTs);
    if (result.ownersProcessed > 0) ownersProcessed += 1;
    remaining -= result.jobsScanned;
    jobsScanned += result.jobsScanned;
    jobsMarkedExpired += result.jobsMarkedExpired;
    jobsPurged += result.jobsPurged;
    jobsFinishedPurged += result.jobsFinishedPurged;
    missingRemoved += result.missingRemoved;
  }

  return {
    ownersSeen: owners.length,
    ownersProcessed: ownersProcessed,
    jobsScanned: jobsScanned,
    jobsMarkedExpired: jobsMarkedExpired,
    jobsPurged: jobsPurged,
    jobsFinishedPurged: jobsFinishedPurged,
    missingRemoved: missingRemoved,
    backend: ownerList.backend,
    at: parseTimestamp(nowTs, Date.now()),
  };
}

async function retryJobForOwner(ownerId, jobId, options) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  if (!normalizedOwnerId) {
    return {
      job: null,
      sourceJob: null,
      reason: "missing_owner",
      statusCode: 400,
      message: "Missing owner id.",
    };
  }

  const fetched = await getJobForOwner(normalizedOwnerId, jobId);
  if (!fetched.job) {
    return {
      job: null,
      sourceJob: null,
      reason: "not_found",
      statusCode: 404,
      message: "Job not found.",
    };
  }

  const sourceJob = fetched.job;
  if (sourceJob.status === "queued" || sourceJob.status === "running") {
    return {
      job: null,
      sourceJob: sourceJob,
      reason: "not_retryable",
      statusCode: 409,
      message: "Job is already queued or running.",
    };
  }

  const created = await submitJob(normalizedOwnerId, sourceJob.ownerLabel || normalizedOwnerId, sourceJob.targetURL);
  let nextJob = created.job;
  let reason = "retried";

  const processNow = !!(options && options.processNow);
  if (processNow) {
    const processed = await runJobNowForOwner(normalizedOwnerId, nextJob.id, options);
    if (processed.job) {
      nextJob = processed.job;
      if (processed.reason === "processed") {
        reason = "retried_processed";
      }
    }
  }

  return {
    job: nextJob,
    sourceJob: sourceJob,
    reason: reason,
    statusCode: 202,
    backend: created.backend,
  };
}

async function retryJobsForOwner(ownerId, jobIds, options) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  const ids = normalizeJobIDFilters(jobIds);
  if (!normalizedOwnerId) {
    return {
      requested: ids.length,
      successCount: 0,
      failedCount: ids.length,
      results: ids.map((id) => ({
        sourceJobId: id,
        ok: false,
        reason: "missing_owner",
        statusCode: 400,
        message: "Missing owner id.",
      })),
    };
  }
  if (!ids.length) {
    return {
      requested: 0,
      successCount: 0,
      failedCount: 0,
      results: [],
    };
  }

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const sourceJobId = ids[i];
    try {
      const retried = await retryJobForOwner(normalizedOwnerId, sourceJobId, options);
      if (retried && retried.job) {
        successCount += 1;
        results.push({
          sourceJobId: sourceJobId,
          ok: true,
          reason: retried.reason || "retried",
          statusCode: retried.statusCode || 202,
          message: "",
          job: retried.job,
        });
      } else {
        failedCount += 1;
        results.push({
          sourceJobId: sourceJobId,
          ok: false,
          reason: retried && retried.reason ? retried.reason : "retry_failed",
          statusCode: retried && retried.statusCode ? retried.statusCode : 500,
          message: retried && retried.message ? retried.message : "Retry failed.",
          job: null,
        });
      }
    } catch (error) {
      failedCount += 1;
      results.push({
        sourceJobId: sourceJobId,
        ok: false,
        reason: "retry_failed",
        statusCode: 500,
        message: error && error.message ? error.message : String(error),
        job: null,
      });
    }
  }

  return {
    requested: ids.length,
    successCount: successCount,
    failedCount: failedCount,
    results: results,
  };
}

async function removeJobsForOwner(ownerId, jobIds) {
  const normalizedOwnerId = clipString(ownerId || "", 140);
  const ids = normalizeJobIDFilters(jobIds);
  if (!normalizedOwnerId) {
    return {
      requested: ids.length,
      removed: 0,
      notFound: ids.length,
      skipped: 0,
      errors: 0,
      removedIds: [],
      remaining: 0,
      ownersProcessed: 0,
      backend: "none",
    };
  }
  if (!ids.length) {
    return {
      requested: 0,
      removed: 0,
      notFound: 0,
      skipped: 0,
      errors: 0,
      removedIds: [],
      remaining: 0,
      ownersProcessed: 0,
      backend: "none",
    };
  }

  const requestedMap = Object.create(null);
  for (let i = 0; i < ids.length; i += 1) requestedMap[ids[i]] = true;

  const ownerJobs = await loadOwnerJobIDs(normalizedOwnerId);
  const ownerIDs = ownerJobs.ids || [];
  const ownerMap = Object.create(null);
  for (let i = 0; i < ownerIDs.length; i += 1) ownerMap[ownerIDs[i]] = true;

  let removed = 0;
  let notFound = 0;
  let skipped = 0;
  let errors = 0;
  const removedIds = [];
  const nextIDs = [];
  let changed = false;

  for (let i = 0; i < ownerIDs.length; i += 1) {
    const jobId = ownerIDs[i];
    if (!requestedMap[jobId]) {
      nextIDs.push(jobId);
      continue;
    }

    const loaded = await loadJob(jobId);
    if (!loaded.job) {
      notFound += 1;
      changed = true;
      continue;
    }
    if (loaded.job.ownerId !== normalizedOwnerId) {
      skipped += 1;
      nextIDs.push(jobId);
      continue;
    }

    try {
      await deleteJobRecord(loaded.job);
      removed += 1;
      removedIds.push(jobId);
      changed = true;
    } catch (_) {
      errors += 1;
      nextIDs.push(jobId);
    }
  }

  for (let i = 0; i < ids.length; i += 1) {
    if (!ownerMap[ids[i]]) {
      notFound += 1;
    }
  }

  if (changed || nextIDs.length !== ownerIDs.length) {
    await saveOwnerJobIDs(normalizedOwnerId, nextIDs);
  }

  return {
    requested: ids.length,
    removed: removed,
    notFound: notFound,
    skipped: skipped,
    errors: errors,
    removedIds: removedIds,
    remaining: nextIDs.length,
    ownersProcessed: ownerIDs.length ? 1 : 0,
    backend: ownerJobs.backend,
  };
}

async function getArtifactForOwner(ownerId, jobId) {
  const fetched = await getJobForOwner(ownerId, jobId);
  if (!fetched.job) {
    return {
      ok: false,
      code: "not_found",
      statusCode: 404,
      message: "Job not found.",
    };
  }
  const job = fetched.job;
  if (job.status === "queued" || job.status === "running") {
    return {
      ok: false,
      code: "not_ready",
      statusCode: 409,
      message: "Job is not finished yet.",
      job: job,
    };
  }
  if (!job.artifact) {
    return {
      ok: false,
      code: job.status === "expired" ? "expired" : "no_artifact",
      statusCode: job.status === "expired" ? 410 : 404,
      message: job.status === "expired" ? "Artifact expired." : "Artifact unavailable.",
      job: job,
    };
  }
  const buffer = await buildArtifactBufferFromJob(job);
  if (!buffer) {
    return {
      ok: false,
      code: "corrupt",
      statusCode: 500,
      message: "Artifact payload is invalid.",
      job: job,
    };
  }
  return {
    ok: true,
    statusCode: 200,
    job: job,
    artifact: job.artifact,
    buffer: buffer,
  };
}

function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const value = String(rangeHeader).trim();
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { valid: false };
  let start = match[1] === "" ? null : parseInt(match[1], 10);
  let end = match[2] === "" ? null : parseInt(match[2], 10);
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) {
    return { valid: false };
  }
  if (start === null && end === null) return { valid: false };

  if (start === null) {
    const suffixLength = Math.max(end, 0);
    if (suffixLength <= 0) return { valid: false };
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    if (start >= totalSize) return { valid: false };
    if (end === null || end >= totalSize) end = totalSize - 1;
    if (end < start) return { valid: false };
  }
  return {
    valid: true,
    start: start,
    end: end,
  };
}

function resetAsyncStoreForTests() {
  delete global.__dezoomifyAsyncMemoryStore;
}

module.exports = {
  ASYNC_BULK_MAX_IDS: ASYNC_BULK_MAX_IDS,
  ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN: ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN,
  ASYNC_CLEANUP_EXPIRED_GRACE_MS: ASYNC_CLEANUP_EXPIRED_GRACE_MS,
  ASYNC_FINISHED_RETENTION_MS: ASYNC_FINISHED_RETENTION_MS,
  ASYNC_MAX_JOBS_PER_CRON_RUN: ASYNC_MAX_JOBS_PER_CRON_RUN,
  ASYNC_MAX_JOBS_PER_OWNER: ASYNC_MAX_JOBS_PER_OWNER,
  ASYNC_LIST_MAX_LIMIT: ASYNC_LIST_MAX_LIMIT,
  ASYNC_JOB_TTL_MS: ASYNC_JOB_TTL_MS,
  ASYNC_ARTIFACT_TTL_MS: ASYNC_ARTIFACT_TTL_MS,
  ASYNC_MAX_ARTIFACT_BYTES: ASYNC_MAX_ARTIFACT_BYTES,
  ASYNC_MAX_INLINE_ARTIFACT_BYTES: ASYNC_MAX_INLINE_ARTIFACT_BYTES,
  ASYNC_ARTIFACT_CHUNK_BYTES: ASYNC_ARTIFACT_CHUNK_BYTES,
  ASYNC_MAX_ARTIFACT_CHUNKS: ASYNC_MAX_ARTIFACT_CHUNKS,
  ASYNC_ARTIFACT_STORAGE_MODE: ASYNC_ARTIFACT_STORAGE_MODE,
  buildAnonOwnerId: buildAnonOwnerId,
  buildPublicJob: buildPublicJob,
  cancelJobForOwner: cancelJobForOwner,
  cleanupExpiredJobs: cleanupExpiredJobs,
  cleanupExpiredJobsForOwner: cleanupExpiredJobsForOwner,
  getArtifactForOwner: getArtifactForOwner,
  getJobForOwner: getJobForOwner,
  listJobsForOwner: listJobsForOwner,
  listOwnerIds: listOwnerIds,
  parseByteRange: parseByteRange,
  removeJobsForOwner: removeJobsForOwner,
  retryJobForOwner: retryJobForOwner,
  retryJobsForOwner: retryJobsForOwner,
  runJobNowForOwner: runJobNowForOwner,
  runPendingJobs: runPendingJobs,
  runPendingJobsForOwner: runPendingJobsForOwner,
  submitJob: submitJob,
  validateTargetURL: validateTargetURL,
  resetAsyncStoreForTests: resetAsyncStoreForTests,
};
