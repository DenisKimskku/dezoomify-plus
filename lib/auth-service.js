"use strict";

const crypto = require("crypto");
const { getPrimaryStore, isPersistentConfigured } = require("./storage-service");

const AUTH_ENFORCE_ADVANCED = /^(1|true|yes)$/i.test(process.env.AUTH_ENFORCE_ADVANCED || "");
const AUTH_OPEN_SIGNUP = !/^(0|false|no)$/i.test(process.env.AUTH_OPEN_SIGNUP || "true");
const SESSION_COOKIE_NAME = String(process.env.AUTH_SESSION_COOKIE || "dz_session");
const SESSION_TTL_MS = Math.max(parseInt(process.env.AUTH_SESSION_TTL_MS, 10) || (7 * 24 * 60 * 60 * 1000), 60000);
const PASSWORD_MIN_LENGTH = Math.max(parseInt(process.env.AUTH_PASSWORD_MIN_LENGTH, 10) || 8, 8);
const HOBBY_CRON_ONLY = /^(1|true|yes)$/i.test(
  process.env.HOBBY_CRON_ONLY || process.env.VERCEL_HOBBY_CRON_ONLY || ""
);

const USER_KEY_PREFIX = process.env.AUTH_USER_PREFIX || "dz:auth:user:v1:";
const EMAIL_INDEX_PREFIX = process.env.AUTH_EMAIL_INDEX_PREFIX || "dz:auth:email:v1:";
const SESSION_KEY_PREFIX = process.env.AUTH_SESSION_PREFIX || "dz:auth:session:v1:";
const APIKEY_INDEX_PREFIX = process.env.AUTH_APIKEY_INDEX_PREFIX || "dz:auth:apikey:v1:";

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function nowTs() {
  return Date.now();
}

function parseCSV(value) {
  return String(value || "")
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashForIndex(value) {
  return sha256Hex(value).slice(0, 32);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

function userKey(userId) {
  return USER_KEY_PREFIX + String(userId || "");
}

function emailIndexKey(normalizedEmail) {
  return EMAIL_INDEX_PREFIX + String(normalizedEmail || "");
}

function sessionKey(sessionId) {
  return SESSION_KEY_PREFIX + String(sessionId || "");
}

function apiKeyIndexKey(apiKeyHash) {
  return APIKEY_INDEX_PREFIX + String(apiKeyHash || "");
}

function getStore() {
  return getPrimaryStore();
}

function isStorageReadyForAuth() {
  const store = getStore();
  return !!(store && typeof store.isPersistent === "function" && store.isPersistent());
}

function getPublicRuntimeConfig() {
  return {
    authEnforced: AUTH_ENFORCE_ADVANCED,
    openSignup: AUTH_OPEN_SIGNUP,
    hobbyCronOnly: HOBBY_CRON_ONLY,
    storagePersistent: isPersistentConfigured(),
  };
}

function parseCookieHeader(rawCookie) {
  const source = String(rawCookie || "");
  if (!source) return {};
  const out = {};
  source.split(";").forEach((piece) => {
    const part = String(piece || "").trim();
    if (!part) return;
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) return;
    const name = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (!name) return;
    try {
      out[name] = decodeURIComponent(value);
    } catch (_) {
      out[name] = value;
    }
  });
  return out;
}

function extractSessionIDFromReq(req) {
  const header = toSingle((req && req.headers && req.headers.cookie) || "");
  const cookies = parseCookieHeader(header);
  return String(cookies[SESSION_COOKIE_NAME] || "").trim();
}

function shouldUseSecureCookies(req) {
  const explicit = String(process.env.AUTH_COOKIE_SECURE || "").trim().toLowerCase();
  if (explicit === "1" || explicit === "true" || explicit === "yes") return true;
  if (explicit === "0" || explicit === "false" || explicit === "no") return false;

  const forwardedProto = String(toSingle((req && req.headers && req.headers["x-forwarded-proto"]) || "")).toLowerCase();
  if (forwardedProto === "https") return true;
  const host = String(toSingle((req && req.headers && req.headers.host) || "")).toLowerCase();
  if (host.indexOf("localhost") >= 0 || host.indexOf("127.0.0.1") >= 0) return false;
  return !!process.env.VERCEL;
}

function createSessionCookieHeader(sessionId, req) {
  const secure = shouldUseSecureCookies(req);
  const parts = [
    SESSION_COOKIE_NAME + "=" + encodeURIComponent(String(sessionId || "")),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.floor(SESSION_TTL_MS / 1000),
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function createClearedSessionCookieHeader(req) {
  const secure = shouldUseSecureCookies(req);
  const parts = [
    SESSION_COOKIE_NAME + "=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function createID(prefix) {
  return String(prefix || "id") + "-" + Date.now().toString(36) + "-" + crypto.randomBytes(8).toString("hex");
}

function normalizeUserRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: String(raw.id || "").trim(),
    email: normalizeEmail(raw.email),
    passwordHash: String(raw.passwordHash || ""),
    role: raw.role === "admin" ? "admin" : "user",
    createdAt: parseInt(raw.createdAt, 10) || nowTs(),
    lastLoginAt: parseInt(raw.lastLoginAt, 10) || null,
    apiKeyHash: String(raw.apiKeyHash || "").trim(),
    apiKeyPrefix: String(raw.apiKeyPrefix || "").trim(),
    apiKeyCreatedAt: parseInt(raw.apiKeyCreatedAt, 10) || null,
    apiKeyRotatedAt: parseInt(raw.apiKeyRotatedAt, 10) || null,
    status: raw.status === "disabled" ? "disabled" : "active",
  };
}

function toPublicUser(user) {
  const normalized = normalizeUserRecord(user);
  if (!normalized) return null;
  return {
    id: normalized.id,
    email: normalized.email,
    role: normalized.role,
    createdAt: normalized.createdAt,
    lastLoginAt: normalized.lastLoginAt,
    status: normalized.status,
  };
}

function validatePassword(password) {
  const raw = String(password || "");
  if (raw.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: "Password must be at least " + PASSWORD_MIN_LENGTH + " characters.",
    };
  }
  if (!/[a-zA-Z]/.test(raw) || !/[0-9]/.test(raw)) {
    return {
      ok: false,
      message: "Password must include letters and numbers.",
    };
  }
  return { ok: true };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password || ""), salt, 64, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return "scrypt$" + salt.toString("hex") + "$" + derived.toString("hex");
}

function verifyPassword(password, passwordHash) {
  const source = String(passwordHash || "");
  const parts = source.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const digestHex = parts[2];
  if (!saltHex || !digestHex) return false;

  let derived;
  try {
    derived = crypto.scryptSync(String(password || ""), Buffer.from(saltHex, "hex"), 64, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("hex");
  } catch (_) {
    return false;
  }
  return safeEqual(derived, digestHex);
}

function extractRequestIP(req) {
  const forwarded = toSingle(req && req.headers ? req.headers["x-forwarded-for"] : "");
  if (forwarded) return String(forwarded).split(",")[0].trim();
  const realIP = toSingle(req && req.headers ? req.headers["x-real-ip"] : "");
  if (realIP) return String(realIP).trim();
  if (req && req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return "unknown";
}

function extractRequestUA(req) {
  return String(toSingle(req && req.headers ? req.headers["user-agent"] : "") || "").slice(0, 500);
}

function computeRoleByEmail(email) {
  const list = parseCSV(process.env.ADMIN_EMAILS || "").map(normalizeEmail);
  return list.indexOf(normalizeEmail(email)) !== -1 ? "admin" : "user";
}

function previewApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return "";
  if (key.length <= 12) return key;
  return key.slice(0, 6) + "..." + key.slice(-4);
}

function extractUserAPIKey(req) {
  const query = req && req.query ? req.query : {};
  const queryKey = toSingle(query.api_key || query.apiKey || "");
  if (queryKey) return String(queryKey).trim();

  const headerKey = toSingle(req && req.headers ? req.headers["x-api-key"] : "");
  if (headerKey) return String(headerKey).trim();

  const auth = toSingle(req && req.headers ? req.headers.authorization : "");
  const match = String(auth || "").match(/^Bearer\s+(.+)$/i);
  if (match) return String(match[1] || "").trim();
  return "";
}

async function getUserByID(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  const raw = await getStore().getJSON(userKey(id));
  return normalizeUserRecord(raw);
}

async function getUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const userId = await getStore().getJSON(emailIndexKey(normalizedEmail));
  if (!userId) return null;
  return getUserByID(userId);
}

async function saveUser(user) {
  const normalized = normalizeUserRecord(user);
  if (!normalized || !normalized.id || !normalized.email) {
    throw new Error("Invalid user record.");
  }
  await getStore().setJSON(userKey(normalized.id), normalized);
  await getStore().setJSON(emailIndexKey(normalized.email), normalized.id);
  return normalized;
}

async function createSessionForUser(user, req) {
  const normalized = normalizeUserRecord(user);
  if (!normalized || !normalized.id) throw new Error("Invalid user.");

  const sessionID = createID("sess");
  const now = nowTs();
  const session = {
    id: sessionID,
    userId: normalized.id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    uaHash: hashForIndex(extractRequestUA(req)),
    ipHash: hashForIndex(extractRequestIP(req)),
  };
  await getStore().setJSON(sessionKey(sessionID), session);
  return session;
}

async function getSessionByID(sessionID) {
  const id = String(sessionID || "").trim();
  if (!id) return null;
  const session = await getStore().getJSON(sessionKey(id));
  if (!session || typeof session !== "object") return null;
  if (!session.expiresAt || session.expiresAt <= nowTs()) {
    await getStore().deleteJSON(sessionKey(id));
    return null;
  }
  return session;
}

async function destroySession(sessionID) {
  const id = String(sessionID || "").trim();
  if (!id) return false;
  await getStore().deleteJSON(sessionKey(id));
  return true;
}

function generateAPIKey() {
  const prefix = crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(24).toString("hex");
  return "dzp_" + prefix + "_" + secret;
}

function hashApiKey(apiKey) {
  return sha256Hex(String(apiKey || ""));
}

async function rotateUserAPIKey(user) {
  const normalized = normalizeUserRecord(user);
  if (!normalized || !normalized.id) {
    throw new Error("Invalid user.");
  }

  const nextKey = generateAPIKey();
  const nextHash = hashApiKey(nextKey);
  const nextPrefix = nextKey.split("_")[1] || "";
  const rotatedAt = nowTs();

  if (normalized.apiKeyHash) {
    await getStore().deleteJSON(apiKeyIndexKey(normalized.apiKeyHash));
  }

  normalized.apiKeyHash = nextHash;
  normalized.apiKeyPrefix = nextPrefix;
  normalized.apiKeyCreatedAt = normalized.apiKeyCreatedAt || rotatedAt;
  normalized.apiKeyRotatedAt = rotatedAt;

  await saveUser(normalized);
  await getStore().setJSON(apiKeyIndexKey(nextHash), normalized.id);

  return {
    user: normalized,
    apiKey: nextKey,
    keyPreview: previewApiKey(nextKey),
  };
}

async function registerUser(email, password, req) {
  if (!AUTH_OPEN_SIGNUP) {
    return {
      ok: false,
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Signup is disabled.",
    };
  }

  if (!isStorageReadyForAuth()) {
    return {
      ok: false,
      statusCode: 503,
      code: "STORAGE_UNAVAILABLE",
      message: "Persistent storage is required for account signup.",
    };
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    return {
      ok: false,
      statusCode: 400,
      code: "INVALID_EMAIL",
      message: "A valid email address is required.",
    };
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.ok) {
    return {
      ok: false,
      statusCode: 400,
      code: "WEAK_PASSWORD",
      message: passwordValidation.message,
    };
  }

  const existing = await getUserByEmail(normalizedEmail);
  if (existing) {
    return {
      ok: false,
      statusCode: 409,
      code: "EMAIL_EXISTS",
      message: "An account already exists for this email.",
    };
  }

  const user = {
    id: createID("usr"),
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    role: computeRoleByEmail(normalizedEmail),
    createdAt: nowTs(),
    lastLoginAt: nowTs(),
    apiKeyHash: "",
    apiKeyPrefix: "",
    apiKeyCreatedAt: null,
    apiKeyRotatedAt: null,
    status: "active",
  };

  const saved = await saveUser(user);
  const session = await createSessionForUser(saved, req);

  return {
    ok: true,
    user: toPublicUser(saved),
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
      ttlMs: Math.max(session.expiresAt - nowTs(), 0),
    },
  };
}

async function loginUser(email, password, req) {
  if (!isStorageReadyForAuth()) {
    return {
      ok: false,
      statusCode: 503,
      code: "STORAGE_UNAVAILABLE",
      message: "Persistent storage is required for account login.",
    };
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      ok: false,
      statusCode: 400,
      code: "INVALID_EMAIL",
      message: "Email is required.",
    };
  }

  const user = await getUserByEmail(normalizedEmail);
  if (!user || user.status !== "active") {
    return {
      ok: false,
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password.",
    };
  }

  const validPassword = verifyPassword(password, user.passwordHash);
  if (!validPassword) {
    return {
      ok: false,
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
      message: "Invalid email or password.",
    };
  }

  user.lastLoginAt = nowTs();
  await saveUser(user);

  const session = await createSessionForUser(user, req);
  return {
    ok: true,
    user: toPublicUser(user),
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
      ttlMs: Math.max(session.expiresAt - nowTs(), 0),
    },
  };
}

async function getAuthFromSession(req) {
  const sessionID = extractSessionIDFromReq(req);
  if (!sessionID) return { ok: false, reason: "missing_session" };

  const session = await getSessionByID(sessionID);
  if (!session) return { ok: false, reason: "invalid_session" };
  const user = await getUserByID(session.userId);
  if (!user || user.status !== "active") {
    await destroySession(sessionID);
    return { ok: false, reason: "invalid_user" };
  }

  return {
    ok: true,
    authType: "session",
    user: user,
    session: session,
  };
}

async function getAuthFromAPIKey(req) {
  const apiKey = extractUserAPIKey(req);
  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  if (apiKey.length > 512) {
    return {
      ok: false,
      reason: "invalid_api_key",
      statusCode: 400,
      code: "INVALID_API_KEY",
      message: "API key is too long.",
    };
  }

  const apiKeyHash = hashApiKey(apiKey);
  const userId = await getStore().getJSON(apiKeyIndexKey(apiKeyHash));
  if (!userId) {
    return {
      ok: false,
      reason: "invalid_api_key",
      statusCode: 401,
      code: "INVALID_API_KEY",
      message: "Invalid API key.",
    };
  }

  const user = await getUserByID(userId);
  if (!user || user.status !== "active" || !safeEqual(user.apiKeyHash, apiKeyHash)) {
    return {
      ok: false,
      reason: "invalid_api_key",
      statusCode: 401,
      code: "INVALID_API_KEY",
      message: "Invalid API key.",
    };
  }

  return {
    ok: true,
    authType: "api_key",
    user: user,
    apiKeyHash: apiKeyHash,
  };
}

async function resolveRequestAuth(req) {
  if (!isStorageReadyForAuth()) {
    return {
      ok: false,
      reason: "storage_unavailable",
      statusCode: 503,
      code: "STORAGE_UNAVAILABLE",
      message: "Persistent storage is unavailable.",
    };
  }

  const apiAuth = await getAuthFromAPIKey(req);
  if (apiAuth.ok) {
    return {
      ok: true,
      authType: apiAuth.authType,
      user: apiAuth.user,
    };
  }
  if (apiAuth.code === "INVALID_API_KEY") {
    return apiAuth;
  }

  const sessionAuth = await getAuthFromSession(req);
  if (sessionAuth.ok) {
    return {
      ok: true,
      authType: sessionAuth.authType,
      user: sessionAuth.user,
      session: sessionAuth.session,
    };
  }

  return {
    ok: false,
    reason: "unauthenticated",
    statusCode: 401,
    code: "UNAUTHORIZED",
    message: "Sign in is required.",
  };
}

function toOwnerContext(authResult) {
  if (!authResult || !authResult.ok || !authResult.user) return null;
  const user = authResult.user;
  return {
    ownerId: "user:" + user.id,
    ownerLabel: user.email,
    authType: authResult.authType,
    user: toPublicUser(user),
  };
}

async function getSessionState(req) {
  if (!isStorageReadyForAuth()) {
    return {
      ok: true,
      authenticated: false,
      user: null,
      config: getPublicRuntimeConfig(),
      storageUnavailable: true,
    };
  }

  const sessionAuth = await getAuthFromSession(req);
  if (!sessionAuth.ok) {
    return {
      ok: true,
      authenticated: false,
      user: null,
      config: getPublicRuntimeConfig(),
    };
  }

  return {
    ok: true,
    authenticated: true,
    user: toPublicUser(sessionAuth.user),
    session: {
      expiresAt: sessionAuth.session.expiresAt,
      ttlMs: Math.max(sessionAuth.session.expiresAt - nowTs(), 0),
    },
    config: getPublicRuntimeConfig(),
  };
}

async function rotateAPIKeyForSession(req) {
  const sessionAuth = await getAuthFromSession(req);
  if (!sessionAuth.ok) {
    return {
      ok: false,
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Sign in is required.",
    };
  }

  const rotated = await rotateUserAPIKey(sessionAuth.user);
  return {
    ok: true,
    apiKey: rotated.apiKey,
    keyPreview: rotated.keyPreview,
    createdAt: rotated.user.apiKeyCreatedAt,
    rotatedAt: rotated.user.apiKeyRotatedAt,
  };
}

async function getAPIKeyInfoForSession(req) {
  const sessionAuth = await getAuthFromSession(req);
  if (!sessionAuth.ok) {
    return {
      ok: false,
      statusCode: 401,
      code: "UNAUTHORIZED",
      message: "Sign in is required.",
    };
  }

  return {
    ok: true,
    keyPreview: sessionAuth.user.apiKeyPrefix ? ("dzp_" + sessionAuth.user.apiKeyPrefix + "_...") : "",
    createdAt: sessionAuth.user.apiKeyCreatedAt || null,
    rotatedAt: sessionAuth.user.apiKeyRotatedAt || null,
  };
}

function buildErrorPayload(code, message, extras) {
  return Object.assign(
    {
      ok: false,
      code: String(code || "REQUEST_FAILED"),
      message: String(message || "Request failed."),
    },
    extras || {}
  );
}

module.exports = {
  AUTH_ENFORCE_ADVANCED: AUTH_ENFORCE_ADVANCED,
  AUTH_OPEN_SIGNUP: AUTH_OPEN_SIGNUP,
  HOBBY_CRON_ONLY: HOBBY_CRON_ONLY,
  SESSION_COOKIE_NAME: SESSION_COOKIE_NAME,
  SESSION_TTL_MS: SESSION_TTL_MS,
  getPublicRuntimeConfig: getPublicRuntimeConfig,
  isStorageReadyForAuth: isStorageReadyForAuth,
  buildErrorPayload: buildErrorPayload,
  createSessionCookieHeader: createSessionCookieHeader,
  createClearedSessionCookieHeader: createClearedSessionCookieHeader,
  resolveRequestAuth: resolveRequestAuth,
  toOwnerContext: toOwnerContext,
  registerUser: registerUser,
  loginUser: loginUser,
  getSessionState: getSessionState,
  getAPIKeyInfoForSession: getAPIKeyInfoForSession,
  rotateAPIKeyForSession: rotateAPIKeyForSession,
  destroySession: destroySession,
  extractSessionIDFromReq: extractSessionIDFromReq,
  toPublicUser: toPublicUser,
};
