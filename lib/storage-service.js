"use strict";

const net = require("net");
const tls = require("tls");

const STORAGE_TIMEOUT_MS = Math.max(parseInt(process.env.STORAGE_TIMEOUT_MS, 10) || 8000, 1000);

class MemoryKVStore {
  constructor() {
    this.values = new Map();
  }

  backendName() {
    return "memory";
  }

  isPersistent() {
    return false;
  }

  async getJSON(key) {
    if (!this.values.has(key)) return null;
    return this.values.get(key);
  }

  async setJSON(key, value) {
    this.values.set(key, value);
    return true;
  }

  async deleteJSON(key) {
    this.values.delete(key);
    return true;
  }

  async incrWithTTL(key, ttlSeconds) {
    const now = Date.now();
    const ttl = Math.max(parseInt(ttlSeconds, 10) || 1, 1);
    const current = this.values.get(key);
    if (!current || !current.expiresAt || current.expiresAt <= now) {
      this.values.set(key, {
        __counter: 1,
        expiresAt: now + ttl * 1000,
      });
      return 1;
    }
    const nextValue = (parseInt(current.__counter, 10) || 0) + 1;
    current.__counter = nextValue;
    this.values.set(key, current);
    return nextValue;
  }

  async ping() {
    return "PONG";
  }
}

class KVRestStore {
  constructor(baseURL, token) {
    this.baseURL = String(baseURL || "").replace(/\/+$/, "");
    this.token = String(token || "");
  }

  backendName() {
    return "vercel-kv-rest";
  }

  isPersistent() {
    return true;
  }

  async command(command, args) {
    const encodedArgs = (args || []).map((arg) => encodeURIComponent(String(arg)));
    const path = [command].concat(encodedArgs).join("/");
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
    return true;
  }

  async deleteJSON(key) {
    await this.command("del", [key]);
    return true;
  }

  async incrWithTTL(key, ttlSeconds) {
    const ttl = Math.max(parseInt(ttlSeconds, 10) || 1, 1);
    const count = Number(await this.command("incr", [key]));
    if (count === 1) {
      await this.command("expire", [key, String(ttl)]);
    }
    return count;
  }

  async ping() {
    return this.command("ping", []);
  }
}

function parseRedisURL(rawURL) {
  const redisURL = new URL(String(rawURL || ""));
  if (redisURL.protocol !== "redis:" && redisURL.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss:// protocol.");
  }
  const username = decodeURIComponent(redisURL.username || "");
  const password = decodeURIComponent(redisURL.password || "");
  const port = parseInt(redisURL.port, 10) || 6379;
  const dbPath = String(redisURL.pathname || "").replace(/^\//, "").trim();
  const database = dbPath ? (parseInt(dbPath, 10) || 0) : 0;

  return {
    host: redisURL.hostname,
    port: port,
    tls: redisURL.protocol === "rediss:",
    username: username,
    password: password,
    database: Math.max(database, 0),
  };
}

function encodeRESP(args) {
  const parts = Array.isArray(args) ? args : [];
  let out = "*" + parts.length + "\r\n";
  for (let i = 0; i < parts.length; i += 1) {
    const part = String(parts[i]);
    const bytes = Buffer.byteLength(part);
    out += "$" + bytes + "\r\n" + part + "\r\n";
  }
  return out;
}

function decodeRESPValue(buffer, offset) {
  if (!Buffer.isBuffer(buffer) || offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]);

  function readLine(startIndex) {
    const end = buffer.indexOf("\r\n", startIndex);
    if (end === -1) return null;
    return {
      line: buffer.toString("utf8", startIndex, end),
      next: end + 2,
    };
  }

  if (prefix === "+") {
    const line = readLine(offset + 1);
    if (!line) return null;
    return { value: line.line, next: line.next };
  }

  if (prefix === "-") {
    const line = readLine(offset + 1);
    if (!line) return null;
    const err = new Error(line.line || "Redis error");
    err.code = "REDIS_ERROR";
    return { value: err, next: line.next };
  }

  if (prefix === ":") {
    const line = readLine(offset + 1);
    if (!line) return null;
    return { value: parseInt(line.line, 10) || 0, next: line.next };
  }

  if (prefix === "$") {
    const line = readLine(offset + 1);
    if (!line) return null;
    const len = parseInt(line.line, 10);
    if (len === -1) {
      return { value: null, next: line.next };
    }
    if (!Number.isFinite(len) || len < 0) {
      const err = new Error("Invalid Redis bulk length.");
      err.code = "REDIS_PROTOCOL";
      return { value: err, next: line.next };
    }
    const end = line.next + len;
    if (buffer.length < end + 2) return null;
    const value = buffer.toString("utf8", line.next, end);
    return { value: value, next: end + 2 };
  }

  if (prefix === "*") {
    const line = readLine(offset + 1);
    if (!line) return null;
    const count = parseInt(line.line, 10);
    if (count === -1) {
      return { value: null, next: line.next };
    }
    if (!Number.isFinite(count) || count < 0) {
      const err = new Error("Invalid Redis array length.");
      err.code = "REDIS_PROTOCOL";
      return { value: err, next: line.next };
    }
    let cursor = line.next;
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const decoded = decodeRESPValue(buffer, cursor);
      if (!decoded) return null;
      items.push(decoded.value);
      cursor = decoded.next;
    }
    return { value: items, next: cursor };
  }

  const err = new Error("Unsupported Redis response type.");
  err.code = "REDIS_PROTOCOL";
  return { value: err, next: buffer.length };
}

class RedisURLStore {
  constructor(redisURL) {
    this.config = parseRedisURL(redisURL);
  }

  backendName() {
    return "redis-url";
  }

  isPersistent() {
    return true;
  }

  async runPipeline(commands) {
    const pipeline = Array.isArray(commands) ? commands : [];
    if (!pipeline.length) return [];

    const commandList = [];
    if (this.config.password) {
      if (this.config.username) {
        commandList.push(["AUTH", this.config.username, this.config.password]);
      } else {
        commandList.push(["AUTH", this.config.password]);
      }
    }
    if (this.config.database > 0) {
      commandList.push(["SELECT", String(this.config.database)]);
    }
    for (let i = 0; i < pipeline.length; i += 1) {
      commandList.push(pipeline[i]);
    }

    return new Promise((resolve, reject) => {
      const options = {
        host: this.config.host,
        port: this.config.port,
      };

      let socket;
      if (this.config.tls) {
        socket = tls.connect(Object.assign({}, options, { servername: this.config.host }));
      } else {
        socket = net.connect(options);
      }

      let settled = false;
      let pendingBuffer = Buffer.alloc(0);
      const responses = [];
      const expected = commandList.length;

      function finishWithError(error) {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch (_) {}
        reject(error);
      }

      function finishWithSuccess(payload) {
        if (settled) return;
        settled = true;
        try {
          socket.end();
        } catch (_) {}
        resolve(payload);
      }

      socket.setTimeout(STORAGE_TIMEOUT_MS);
      socket.on("timeout", () => {
        finishWithError(new Error("Redis command timed out."));
      });
      socket.on("error", (error) => {
        finishWithError(error);
      });

      socket.on("connect", () => {
        let encoded = "";
        for (let i = 0; i < commandList.length; i += 1) {
          encoded += encodeRESP(commandList[i]);
        }
        socket.write(encoded);
      });

      socket.on("data", (chunk) => {
        pendingBuffer = Buffer.concat([pendingBuffer, chunk]);
        while (responses.length < expected) {
          const decoded = decodeRESPValue(pendingBuffer, 0);
          if (!decoded) break;
          responses.push(decoded.value);
          pendingBuffer = pendingBuffer.subarray(decoded.next);
        }
        if (responses.length < expected) return;

        for (let i = 0; i < responses.length; i += 1) {
          if (responses[i] instanceof Error) {
            finishWithError(responses[i]);
            return;
          }
        }

        const setupCount = expected - pipeline.length;
        const payload = responses.slice(setupCount);
        finishWithSuccess(payload);
      });
    });
  }

  async command(args) {
    const responses = await this.runPipeline([args]);
    return responses[0];
  }

  async getJSON(key) {
    const rawValue = await this.command(["GET", String(key)]);
    if (rawValue === null || typeof rawValue === "undefined") return null;
    if (typeof rawValue !== "string") return null;
    try {
      return JSON.parse(rawValue);
    } catch (_) {
      return null;
    }
  }

  async setJSON(key, value) {
    await this.command(["SET", String(key), JSON.stringify(value)]);
    return true;
  }

  async deleteJSON(key) {
    await this.command(["DEL", String(key)]);
    return true;
  }

  async incrWithTTL(key, ttlSeconds) {
    const ttl = Math.max(parseInt(ttlSeconds, 10) || 1, 1);
    const responses = await this.runPipeline([
      ["INCR", String(key)],
      ["EXPIRE", String(key), String(ttl)],
    ]);
    return Number(responses[0]) || 0;
  }

  async ping() {
    return this.command(["PING"]);
  }
}

function getMemoryStore() {
  if (!global.__dezoomifySharedMemoryStore) {
    global.__dezoomifySharedMemoryStore = new MemoryKVStore();
  }
  return global.__dezoomifySharedMemoryStore;
}

function createPrimaryStore() {
  const restURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (restURL && restToken) {
    return new KVRestStore(restURL, restToken);
  }

  const redisURL = process.env.REDIS_URL || "";
  if (redisURL) {
    try {
      return new RedisURLStore(redisURL);
    } catch (error) {
      console.error("Invalid REDIS_URL configuration, falling back to memory:", error && error.message ? error.message : String(error));
    }
  }

  return getMemoryStore();
}

function getPrimaryStore() {
  if (!global.__dezoomifyPrimaryStore) {
    global.__dezoomifyPrimaryStore = createPrimaryStore();
  }
  return global.__dezoomifyPrimaryStore;
}

async function checkStorageHealth() {
  const store = getPrimaryStore();
  try {
    await store.ping();
    return {
      ok: true,
      backend: store.backendName(),
      persistent: store.isPersistent(),
      configured: store.isPersistent(),
    };
  } catch (error) {
    return {
      ok: false,
      backend: store.backendName(),
      persistent: store.isPersistent(),
      configured: store.isPersistent(),
      error: error && error.message ? error.message : String(error),
    };
  }
}

function isPersistentConfigured() {
  const store = getPrimaryStore();
  return !!(store && typeof store.isPersistent === "function" && store.isPersistent());
}

function resetStorageForTests() {
  delete global.__dezoomifyPrimaryStore;
  delete global.__dezoomifySharedMemoryStore;
}

module.exports = {
  MemoryKVStore: MemoryKVStore,
  KVRestStore: KVRestStore,
  RedisURLStore: RedisURLStore,
  getMemoryStore: getMemoryStore,
  getPrimaryStore: getPrimaryStore,
  checkStorageHealth: checkStorageHealth,
  isPersistentConfigured: isPersistentConfigured,
  resetStorageForTests: resetStorageForTests,
};
