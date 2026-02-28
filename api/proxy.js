"use strict";

const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");
const { createRequestObserver } = require("../lib/observability");
const authService = require("../lib/auth-service");

const MAX_REDIRECTS = 3;
const MAX_COOKIE_LENGTH = 8192;
const RATE_LIMIT_WINDOW_MS = Math.max(parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000, 1000);
const RATE_LIMIT_MAX_REQUESTS = Math.max(parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 180, 1);
const DEFAULT_API_DAILY_QUOTA = Math.max(parseInt(process.env.API_DEFAULT_DAILY_QUOTA, 10) || 5000, 1);
const DEFAULT_API_MINUTE_QUOTA = Math.max(parseInt(process.env.API_DEFAULT_MINUTE_QUOTA, 10) || 180, 1);
const DEFAULT_ANON_DAILY_QUOTA = Math.max(parseInt(process.env.API_ANON_DAILY_QUOTA, 10) || 700, 1);
const DEFAULT_ANON_MINUTE_QUOTA = Math.max(parseInt(process.env.API_ANON_MINUTE_QUOTA, 10) || 45, 1);
const API_AUTH_REQUIRED = /^(1|true|yes)$/i.test(process.env.API_AUTH_REQUIRED || "");
const API_DISABLE_ANON = /^(1|true|yes)$/i.test(process.env.API_DISABLE_ANON || "");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const RATE_LIMIT_STORE = new Map();
let rateLimitSweepCounter = 0;

const BLOCKED_RESPONSE_HEADERS = {
  "set-cookie": true,
  "set-cookie2": true,
  "location": true,
  "content-length": true,
  "transfer-encoding": true,
  "connection": true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  "te": true,
  "trailers": true,
  "upgrade": true,
  "access-control-allow-origin": true,
  "access-control-expose-headers": true,
  "vary": true,
};

const API_KEY_CONFIG = parseApiKeyConfig();

class MemoryQuotaStore {
  constructor() {
    this.store = new Map();
    this.sweepCounter = 0;
  }

  backendName() {
    return "memory";
  }

  sweep(now) {
    this.sweepCounter++;
    if (this.sweepCounter % 250 !== 0) return;
    this.store.forEach((entry, key) => {
      if (!entry || entry.expiresAt <= now) this.store.delete(key);
    });
  }

  async incrWithTTL(key, ttlSeconds) {
    const now = Date.now();
    this.sweep(now);
    let entry = this.store.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = { value: 0, expiresAt: now + ttlSeconds * 1000 };
    }
    entry.value += 1;
    this.store.set(key, entry);
    return entry.value;
  }
}

class KVRestQuotaStore {
  constructor(baseURL, token) {
    this.baseURL = String(baseURL || "").replace(/\/+$/, "");
    this.token = token;
  }

  backendName() {
    return "vercel-kv-rest";
  }

  async command(command, args) {
    const url =
      this.baseURL + "/" + [command].concat(args.map((arg) => encodeURIComponent(String(arg)))).join("/");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + this.token,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.error) {
      const msg = body && body.error ? body.error : ("KV command failed: " + response.status);
      throw new Error(msg);
    }
    return body.result;
  }

  async incrWithTTL(key, ttlSeconds) {
    const count = Number(await this.command("incr", [key]));
    if (count === 1) {
      await this.command("expire", [key, String(ttlSeconds)]);
    }
    return count;
  }
}

const memoryQuotaStore = new MemoryQuotaStore();
const primaryQuotaStore = createPrimaryQuotaStore();

function createPrimaryQuotaStore() {
  const restURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (restURL && restToken) {
    return new KVRestQuotaStore(restURL, restToken);
  }
  return memoryQuotaStore;
}

function addCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Set-Cookie, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, " +
      "X-Quota-Identity, X-Quota-Backend, X-Quota-Minute-Limit, X-Quota-Minute-Used, X-Quota-Minute-Reset, " +
      "X-Quota-Daily-Limit, X-Quota-Daily-Used, X-Quota-Daily-Reset"
  );
  res.setHeader("Vary", "Origin");
}

function applyRateLimitHeaders(res, rateLimitInfo) {
  if (!rateLimitInfo) return;
  res.setHeader("X-RateLimit-Limit", String(rateLimitInfo.limit));
  res.setHeader("X-RateLimit-Remaining", String(rateLimitInfo.remaining));
  res.setHeader("X-RateLimit-Reset", String(rateLimitInfo.resetEpochSeconds));
}

function applyQuotaHeaders(res, quotaInfo) {
  if (!quotaInfo) return;
  res.setHeader("X-Quota-Identity", String(quotaInfo.identity));
  res.setHeader("X-Quota-Backend", String(quotaInfo.backend));
  res.setHeader("X-Quota-Minute-Limit", String(quotaInfo.minuteLimit));
  res.setHeader("X-Quota-Minute-Used", String(quotaInfo.minuteUsed));
  res.setHeader("X-Quota-Minute-Reset", String(quotaInfo.minuteResetEpochSeconds));
  res.setHeader("X-Quota-Daily-Limit", String(quotaInfo.dailyLimit));
  res.setHeader("X-Quota-Daily-Used", String(quotaInfo.dailyUsed));
  res.setHeader("X-Quota-Daily-Reset", String(quotaInfo.dailyResetEpochSeconds));
}

function sendError(res, statusCode, message, rateLimitInfo, retryAfterSeconds, quotaInfo) {
  addCorsHeaders(res);
  applyRateLimitHeaders(res, rateLimitInfo || null);
  applyQuotaHeaders(res, quotaInfo || null);
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message + "\n");
}

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sanitizeCookies(cookieHeader) {
  if (!cookieHeader) return "";
  const sanitized = String(cookieHeader).replace(/[\r\n]/g, "");
  if (sanitized.length > MAX_COOKIE_LENGTH) {
    throw new Error("Cookie header is too long.");
  }
  return sanitized;
}

function hashString(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function getClientKey(req) {
  const forwarded = toSingle(req.headers["x-forwarded-for"]);
  if (forwarded) return String(forwarded).split(",")[0].trim();
  const realIp = toSingle(req.headers["x-real-ip"]);
  if (realIp) return String(realIp).trim();
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return "unknown";
}

function maybeSweepRateLimitStore(now) {
  rateLimitSweepCounter++;
  if (rateLimitSweepCounter % 250 !== 0) return;
  RATE_LIMIT_STORE.forEach((entry, key) => {
    if (entry.resetAt <= now) RATE_LIMIT_STORE.delete(key);
  });
}

function consumeIPRateLimit(clientKey) {
  const now = Date.now();
  maybeSweepRateLimitStore(now);

  let entry = RATE_LIMIT_STORE.get(clientKey);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  entry.count += 1;
  RATE_LIMIT_STORE.set(clientKey, entry);

  const blocked = entry.count > RATE_LIMIT_MAX_REQUESTS;
  const remaining = blocked ? 0 : Math.max(RATE_LIMIT_MAX_REQUESTS - entry.count, 0);
  return {
    blocked: blocked,
    limit: RATE_LIMIT_MAX_REQUESTS,
    remaining: remaining,
    resetEpochSeconds: Math.ceil(entry.resetAt / 1000),
    retryAfterSeconds: Math.max(Math.ceil((entry.resetAt - now) / 1000), 1),
  };
}

function parseApiKeyConfig() {
  const config = new Map();
  const rawJSON = process.env.API_KEY_CONFIG_JSON || process.env.API_KEYS_JSON || "";
  if (rawJSON) {
    try {
      const parsed = JSON.parse(rawJSON);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach((apiKey) => {
          const plan = normalizePlan(parsed[apiKey], apiKey);
          config.set(apiKey, plan);
        });
      }
    } catch (error) {
      console.error("Unable to parse API key config JSON:", error);
    }
  }

  const rawCSV = process.env.API_KEYS || "";
  rawCSV
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((apiKey) => {
      if (!config.has(apiKey)) {
        config.set(apiKey, normalizePlan({}, apiKey));
      }
    });

  return config;
}

function normalizePlan(plan, apiKey) {
  const source = plan && typeof plan === "object" ? plan : {};
  const label = source.label || source.name || ("key-" + hashString(apiKey));
  const id = source.id || ("key-" + hashString(apiKey));
  const minuteQuota = Math.max(parseInt(source.minuteQuota, 10) || DEFAULT_API_MINUTE_QUOTA, 1);
  const dailyQuota = Math.max(parseInt(source.dailyQuota, 10) || DEFAULT_API_DAILY_QUOTA, 1);
  return {
    id: String(id),
    label: String(label),
    minuteQuota: minuteQuota,
    dailyQuota: dailyQuota,
  };
}

function extractApiKey(req) {
  const queryKey = toSingle(req.query.api_key || req.query.apiKey || "");
  if (queryKey) return String(queryKey).trim();
  const headerKey = toSingle(req.headers["x-api-key"] || "");
  if (headerKey) return String(headerKey).trim();
  const auth = toSingle(req.headers.authorization || "");
  const bearerMatch = String(auth).match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1].trim();
  return "";
}

function sanitizeApiKey(rawKey) {
  if (!rawKey) return "";
  const key = String(rawKey).trim();
  if (key.length > 256) {
    throw new Error("API key is too long.");
  }
  return key;
}

async function resolveQuotaIdentity(req, clientKey) {
  let providedAPIKey = "";
  try {
    providedAPIKey = sanitizeApiKey(extractApiKey(req));
  } catch (error) {
    return { error: error.message || String(error), statusCode: 400 };
  }

  if (providedAPIKey && authService.isStorageReadyForAuth()) {
    const authResult = await authService.resolveRequestAuth(req);
    if (authResult && authResult.ok && authResult.user) {
      return {
        identity: authResult.user.email || ("user:" + authResult.user.id),
        storageKey: "user:" + authResult.user.id,
        minuteQuota: DEFAULT_API_MINUTE_QUOTA,
        dailyQuota: DEFAULT_API_DAILY_QUOTA,
      };
    }
  }

  if (providedAPIKey) {
    const plan = API_KEY_CONFIG.get(providedAPIKey);
    if (plan) {
      return {
        identity: plan.label,
        storageKey: "apikey:" + plan.id,
        minuteQuota: plan.minuteQuota,
        dailyQuota: plan.dailyQuota,
      };
    }
    return { error: "Invalid API key.", statusCode: 401 };
  }

  const hasSessionCookie = !!authService.extractSessionIDFromReq(req);
  if (hasSessionCookie && authService.isStorageReadyForAuth()) {
    const authResult = await authService.resolveRequestAuth(req);
    if (authResult && authResult.ok && authResult.user) {
      return {
        identity: authResult.user.email || ("user:" + authResult.user.id),
        storageKey: "user:" + authResult.user.id,
        minuteQuota: DEFAULT_API_MINUTE_QUOTA,
        dailyQuota: DEFAULT_API_DAILY_QUOTA,
      };
    }
  }

  if (API_AUTH_REQUIRED || API_DISABLE_ANON) {
    return { error: "Missing API key.", statusCode: 401 };
  }

  return {
    identity: "anonymous",
    storageKey: "anon:" + hashString(clientKey),
    minuteQuota: DEFAULT_ANON_MINUTE_QUOTA,
    dailyQuota: DEFAULT_ANON_DAILY_QUOTA,
  };
}

function secondsUntilNextMinute(now) {
  return Math.max(Math.ceil((Math.floor(now / 60000) * 60000 + 60000 - now) / 1000), 1);
}

function secondsUntilNextUTCDay(now) {
  const date = new Date(now);
  const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(Math.ceil((nextDay - now) / 1000), 1);
}

function utcDayStamp(now) {
  const date = new Date(now);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return "" + yyyy + mm + dd;
}

async function incrementQuotaCounter(counterKey, ttlSeconds) {
  try {
    const value = await primaryQuotaStore.incrWithTTL(counterKey, ttlSeconds);
    return { value: Number(value), backend: primaryQuotaStore.backendName() };
  } catch (error) {
    console.error("Primary quota backend failed, falling back to memory:", error);
    const value = await memoryQuotaStore.incrWithTTL(counterKey, ttlSeconds);
    return { value: Number(value), backend: memoryQuotaStore.backendName() };
  }
}

async function consumeQuota(identityInfo) {
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const dayBucket = utcDayStamp(now);
  const minuteTTL = secondsUntilNextMinute(now) + 3;
  const dayTTL = secondsUntilNextUTCDay(now) + 60;

  const minuteCounterKey = "quota:" + identityInfo.storageKey + ":m:" + minuteBucket;
  const dailyCounterKey = "quota:" + identityInfo.storageKey + ":d:" + dayBucket;

  const minuteCounter = await incrementQuotaCounter(minuteCounterKey, minuteTTL);
  const dailyCounter = await incrementQuotaCounter(dailyCounterKey, dayTTL);

  const minuteUsed = minuteCounter.value;
  const dailyUsed = dailyCounter.value;
  const minuteLimit = identityInfo.minuteQuota;
  const dailyLimit = identityInfo.dailyQuota;
  const minuteResetEpochSeconds = Math.ceil((now + minuteTTL * 1000) / 1000);
  const dailyResetEpochSeconds = Math.ceil((now + dayTTL * 1000) / 1000);

  const minuteExceeded = minuteUsed > minuteLimit;
  const dailyExceeded = dailyUsed > dailyLimit;
  const blocked = minuteExceeded || dailyExceeded;
  const retryAfterSeconds = minuteExceeded
    ? Math.max(minuteResetEpochSeconds - Math.ceil(now / 1000), 1)
    : Math.max(dailyResetEpochSeconds - Math.ceil(now / 1000), 1);
  const backend = minuteCounter.backend === dailyCounter.backend
    ? minuteCounter.backend
    : (minuteCounter.backend + "+" + dailyCounter.backend);

  return {
    blocked: blocked,
    reason: minuteExceeded ? "minute" : (dailyExceeded ? "daily" : ""),
    retryAfterSeconds: retryAfterSeconds,
    identity: identityInfo.identity,
    backend: backend,
    minuteLimit: minuteLimit,
    minuteUsed: minuteUsed,
    minuteResetEpochSeconds: minuteResetEpochSeconds,
    dailyLimit: dailyLimit,
    dailyUsed: dailyUsed,
    dailyResetEpochSeconds: dailyResetEpochSeconds,
  };
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
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
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "localhost." ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  );
}

function validateTargetURL(rawURL) {
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
    throw new Error("Credentials in target URLs are not allowed.");
  }
  if (targetURL.port) {
    const port = Number(targetURL.port);
    if (!port || port < 1 || port > 65535) {
      throw new Error("Invalid target port.");
    }
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
  const nonPublic = records.some((record) => !isPublicIP(record.address));
  if (nonPublic) {
    throw new Error("Target host resolves to a private or reserved IP.");
  }
}

function readCookiePairFromSetCookie(rawSetCookieHeader) {
  if (!rawSetCookieHeader) return "";
  const firstHeader = Array.isArray(rawSetCookieHeader)
    ? rawSetCookieHeader[0]
    : rawSetCookieHeader;
  const match = String(firstHeader).match(/^[^;]*/);
  return match ? match[0] + ";" : "";
}

async function fetchWithRedirects(rawTargetURL, cookieHeader) {
  let currentURL = rawTargetURL;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const validatedURL = validateTargetURL(currentURL);
    await assertPublicResolution(validatedURL);

    const response = await fetch(validatedURL.toString(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "identity",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": validatedURL.toString(),
        "Origin": validatedURL.origin,
        ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
      },
      redirect: "manual",
    });

    const location = response.headers.get("location");
    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      !!location;
    if (!isRedirect) return response;

    if (i === MAX_REDIRECTS) {
      throw new Error("Too many redirects.");
    }
    currentURL = new URL(location, validatedURL).toString();
  }
  throw new Error("Too many redirects.");
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("proxy", req);

  if (req.method !== "GET") {
    sendError(res, 405, "Only GET requests are supported.", null, null, null);
    finish(405, { reason: "method_not_allowed" });
    return;
  }

  const clientKey = getClientKey(req);
  const ipRateLimitInfo = consumeIPRateLimit(clientKey);
  if (ipRateLimitInfo.blocked) {
    sendError(
      res,
      429,
      "Request rate limit exceeded. Please retry shortly.",
      ipRateLimitInfo,
      ipRateLimitInfo.retryAfterSeconds,
      null
    );
    finish(429, { reason: "ip_rate_limited" });
    return;
  }

  const identity = await resolveQuotaIdentity(req, clientKey);
  if (identity.error) {
    sendError(res, identity.statusCode, identity.error, ipRateLimitInfo, null, null);
    finish(identity.statusCode || 400, { reason: "identity_resolution_failed" });
    return;
  }

  const quotaInfo = await consumeQuota(identity);
  if (quotaInfo.blocked) {
    const message = quotaInfo.reason === "minute"
      ? "API minute quota exceeded. Please retry shortly."
      : "API daily quota exceeded. Please retry after reset.";
    sendError(
      res,
      429,
      message,
      ipRateLimitInfo,
      quotaInfo.retryAfterSeconds,
      quotaInfo
    );
    finish(429, { reason: "quota_exceeded", quotaType: quotaInfo.reason || "unknown", ownerId: identity.storageKey });
    return;
  }

  let rawTargetURL = toSingle(req.query.url);
  if (!rawTargetURL) {
    sendError(res, 400, "Missing required query parameter: url", ipRateLimitInfo, null, quotaInfo);
    finish(400, { reason: "missing_url", ownerId: identity.storageKey });
    return;
  }

  let cookieHeader = "";
  try {
    cookieHeader = sanitizeCookies(toSingle(req.query.cookies) || "");
  } catch (error) {
    sendError(res, 400, error.message || String(error), ipRateLimitInfo, null, quotaInfo);
    finish(400, { reason: "invalid_cookie_header", ownerId: identity.storageKey });
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithRedirects(rawTargetURL, cookieHeader);
  } catch (error) {
    sendError(res, 502, error.message || String(error), ipRateLimitInfo, null, quotaInfo);
    finish(502, { reason: "upstream_fetch_failed", ownerId: identity.storageKey });
    return;
  }

  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  if (upstreamResponse.status >= 200 && upstreamResponse.status < 300 && body.length === 0) {
    sendError(
      res,
      502,
      "Upstream returned an empty response.",
      ipRateLimitInfo,
      null,
      quotaInfo
    );
    let targetHostForEmpty = "";
    try {
      targetHostForEmpty = new URL(rawTargetURL).hostname || "";
    } catch (_) { }
    finish(502, {
      reason: "upstream_empty_response",
      targetHost: targetHostForEmpty || undefined,
      quotaIdentity: quotaInfo.identity,
      quotaBackend: quotaInfo.backend,
      ipRemaining: ipRateLimitInfo.remaining,
      ownerId: identity.storageKey,
    });
    return;
  }

  addCorsHeaders(res);
  applyRateLimitHeaders(res, ipRateLimitInfo);
  applyQuotaHeaders(res, quotaInfo);
  res.statusCode = upstreamResponse.status;

  upstreamResponse.headers.forEach((value, key) => {
    if (BLOCKED_RESPONSE_HEADERS[key.toLowerCase()]) return;
    if (typeof value === "undefined" || value === null) return;
    res.setHeader(key, value);
  });

  const setCookieHeader =
    typeof upstreamResponse.headers.getSetCookie === "function"
      ? upstreamResponse.headers.getSetCookie()
      : upstreamResponse.headers.get("set-cookie");
  const cookiePair = readCookiePairFromSetCookie(setCookieHeader);
  if (cookiePair) {
    res.setHeader("X-Set-Cookie", cookiePair);
  }

  res.end(body);
  let targetHost = "";
  try {
    targetHost = new URL(rawTargetURL).hostname || "";
  } catch (_) { }
  finish(upstreamResponse.status, {
    targetHost: targetHost || undefined,
    quotaIdentity: quotaInfo.identity,
    quotaBackend: quotaInfo.backend,
    ipRemaining: ipRateLimitInfo.remaining,
    ownerId: identity.storageKey,
  });
};
