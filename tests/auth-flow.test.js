"use strict";

var assert = require("assert");

function test(name, fn) {
  return { name: name, fn: fn };
}

function createPersistentTestStore() {
  var values = new Map();
  return {
    backendName: function () { return "test-persistent"; },
    isPersistent: function () { return true; },
    getJSON: async function (key) {
      return values.has(key) ? values.get(key) : null;
    },
    setJSON: async function (key, value) {
      values.set(key, value);
      return true;
    },
    deleteJSON: async function (key) {
      values.delete(key);
      return true;
    },
    incrWithTTL: async function (key) {
      var current = values.get(key) || 0;
      var next = Number(current) + 1;
      values.set(key, next);
      return next;
    },
    ping: async function () {
      return "PONG";
    },
  };
}

function createReq(options) {
  var opts = options || {};
  return {
    method: opts.method || "GET",
    url: opts.url || "/api/observability",
    query: opts.query || {},
    headers: opts.headers || {},
    body: opts.body,
    socket: { remoteAddress: opts.remoteAddress || "198.51.100.201" },
    on: function () {},
  };
}

function createRes() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    setHeader: function (name, value) {
      this.headers[name] = value;
    },
    end: function (value) {
      if (typeof value === "undefined" || value === null) {
        this.body = Buffer.alloc(0);
        return;
      }
      this.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    },
  };
}

function parseBody(res) {
  try {
    return JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString("utf8") : String(res.body || ""));
  } catch (_) {
    return {};
  }
}

async function withHandlers(envPatch, runFn) {
  var mergedPatch = Object.assign({ OBSERVABILITY_ENABLED: "false" }, envPatch || {});
  var previous = {};

  Object.keys(mergedPatch).forEach(function (key) {
    previous[key] = process.env[key];
    if (mergedPatch[key] === null) delete process.env[key];
    else process.env[key] = String(mergedPatch[key]);
  });

  global.__dezoomifyPrimaryStore = createPersistentTestStore();

  var storagePath = require.resolve("../lib/storage-service");
  var authPath = require.resolve("../lib/auth-service");
  var jobsServicePath = require.resolve("../lib/jobs-service");
  var jobsPath = require.resolve("../api/jobs");
  var observabilityPath = require.resolve("../api/observability");

  delete require.cache[storagePath];
  delete require.cache[authPath];
  delete require.cache[jobsServicePath];
  delete require.cache[jobsPath];
  delete require.cache[observabilityPath];

  var observability = require(observabilityPath);
  var jobs = require(jobsPath);

  try {
    return await runFn({
      observability: observability,
      jobs: jobs,
    });
  } finally {
    Object.keys(mergedPatch).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });

    delete require.cache[storagePath];
    delete require.cache[authPath];
    delete require.cache[jobsServicePath];
    delete require.cache[jobsPath];
    delete require.cache[observabilityPath];
    delete global.__dezoomifyPrimaryStore;
    delete global.__dezoomifySharedMemoryStore;
    delete global.__dezoomifyJobsMemoryStore;
    delete global.__dezoomifyAsyncMemoryStore;
    delete global.__dezoomifyObservabilityMetrics;
  }
}

var tests = [
  test("auth register/session/logout flow works", async function () {
    await withHandlers(
      {
        AUTH_ENFORCE_ADVANCED: "true",
        AUTH_OPEN_SIGNUP: "true",
      },
      async function (ctx) {
        var registerReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "register" },
          body: { email: "user@example.com", password: "Password123" },
        });
        var registerRes = createRes();
        await ctx.observability(registerReq, registerRes);
        assert.strictEqual(registerRes.statusCode, 201);
        var registerPayload = parseBody(registerRes);
        assert.strictEqual(registerPayload.ok, true);
        assert.ok(registerRes.headers["Set-Cookie"]);

        var cookie = registerRes.headers["Set-Cookie"].split(";")[0];

        var sessionReq = createReq({
          method: "GET",
          query: { scope: "auth", action: "session" },
          headers: { cookie: cookie },
        });
        var sessionRes = createRes();
        await ctx.observability(sessionReq, sessionRes);
        assert.strictEqual(sessionRes.statusCode, 200);
        var sessionPayload = parseBody(sessionRes);
        assert.strictEqual(sessionPayload.authenticated, true);
        assert.strictEqual(sessionPayload.user.email, "user@example.com");

        var logoutReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "logout" },
          headers: { cookie: cookie },
        });
        var logoutRes = createRes();
        await ctx.observability(logoutReq, logoutRes);
        assert.strictEqual(logoutRes.statusCode, 200);
        assert.ok(logoutRes.headers["Set-Cookie"]);
      }
    );
  }),

  test("advanced jobs endpoint requires auth when enforced", async function () {
    await withHandlers(
      {
        AUTH_ENFORCE_ADVANCED: "true",
        AUTH_OPEN_SIGNUP: "true",
      },
      async function (ctx) {
        var unauthorizedReq = createReq({ method: "GET" });
        var unauthorizedRes = createRes();
        await ctx.jobs(unauthorizedReq, unauthorizedRes);
        assert.strictEqual(unauthorizedRes.statusCode, 401);
        var unauthorizedPayload = parseBody(unauthorizedRes);
        assert.strictEqual(unauthorizedPayload.code, "UNAUTHORIZED");

        var registerReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "register" },
          body: { email: "owner@example.com", password: "Password123" },
        });
        var registerRes = createRes();
        await ctx.observability(registerReq, registerRes);
        assert.strictEqual(registerRes.statusCode, 201);
        var cookie = registerRes.headers["Set-Cookie"].split(";")[0];

        var authorizedReq = createReq({
          method: "GET",
          headers: { cookie: cookie },
        });
        var authorizedRes = createRes();
        await ctx.jobs(authorizedReq, authorizedRes);
        assert.strictEqual(authorizedRes.statusCode, 200);
        var authorizedPayload = parseBody(authorizedRes);
        assert.strictEqual(authorizedPayload.ok, true);
        assert.strictEqual(authorizedPayload.authType, "session");
        assert.ok(String(authorizedPayload.owner || "").indexOf("@") >= 0);
      }
    );
  }),

  test("api key rotation provides bearer auth for advanced endpoint", async function () {
    await withHandlers(
      {
        AUTH_ENFORCE_ADVANCED: "true",
        AUTH_OPEN_SIGNUP: "true",
      },
      async function (ctx) {
        var registerReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "register" },
          body: { email: "keyuser@example.com", password: "Password123" },
        });
        var registerRes = createRes();
        await ctx.observability(registerReq, registerRes);
        assert.strictEqual(registerRes.statusCode, 201);
        var cookie = registerRes.headers["Set-Cookie"].split(";")[0];

        var rotateReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "key_rotate" },
          headers: { cookie: cookie },
          body: {},
        });
        var rotateRes = createRes();
        await ctx.observability(rotateReq, rotateRes);
        assert.strictEqual(rotateRes.statusCode, 200);
        var rotatePayload = parseBody(rotateRes);
        assert.strictEqual(rotatePayload.ok, true);
        assert.ok(rotatePayload.apiKey);

        var bearerReq = createReq({
          method: "GET",
          headers: { authorization: "Bearer " + rotatePayload.apiKey },
        });
        var bearerRes = createRes();
        await ctx.jobs(bearerReq, bearerRes);
        assert.strictEqual(bearerRes.statusCode, 200);
        var bearerPayload = parseBody(bearerRes);
        assert.strictEqual(bearerPayload.authType, "api_key");
      }
    );
  }),

  test("admin snapshot endpoint is gated to admin role and supports role refresh on login", async function () {
    await withHandlers(
      {
        AUTH_ENFORCE_ADVANCED: "true",
        AUTH_OPEN_SIGNUP: "true",
        ADMIN_EMAILS: "",
      },
      async function (ctx) {
        var registerReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "register" },
          body: { email: "kor8821@gmail.com", password: "Password123" },
        });
        var registerRes = createRes();
        await ctx.observability(registerReq, registerRes);
        assert.strictEqual(registerRes.statusCode, 201);
        var registerPayload = parseBody(registerRes);
        assert.strictEqual(registerPayload.user.role, "user");

        var userCookie = registerRes.headers["Set-Cookie"].split(";")[0];

        var blockedAdminReq = createReq({
          method: "GET",
          query: { scope: "admin" },
          headers: { cookie: userCookie },
        });
        var blockedAdminRes = createRes();
        await ctx.observability(blockedAdminReq, blockedAdminRes);
        assert.strictEqual(blockedAdminRes.statusCode, 403);

        process.env.ADMIN_EMAILS = "kor8821@gmail.com";
        var loginReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "login" },
          body: { email: "kor8821@gmail.com", password: "Password123" },
        });
        var loginRes = createRes();
        await ctx.observability(loginReq, loginRes);
        assert.strictEqual(loginRes.statusCode, 200);
        var loginPayload = parseBody(loginRes);
        assert.strictEqual(loginPayload.user.role, "admin");

        var adminCookie = loginRes.headers["Set-Cookie"].split(";")[0];
        var adminReq = createReq({
          method: "GET",
          query: { scope: "admin", owner_limit: "10", user_limit: "10" },
          headers: { cookie: adminCookie },
        });
        var adminRes = createRes();
        await ctx.observability(adminReq, adminRes);
        assert.strictEqual(adminRes.statusCode, 200);
        var adminPayload = parseBody(adminRes);
        assert.strictEqual(adminPayload.ok, true);
        assert.strictEqual(adminPayload.admin.email, "kor8821@gmail.com");
        assert.strictEqual(adminPayload.admin.role, "admin");
        assert.ok(adminPayload.users && Array.isArray(adminPayload.users.items));
      }
    );
  }),
];

async function run() {
  var failed = 0;
  for (var i = 0; i < tests.length; i += 1) {
    var current = tests[i];
    try {
      await current.fn();
      console.log("PASS", current.name);
    } catch (error) {
      failed += 1;
      console.error("FAIL", current.name);
      console.error(error && error.stack ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error("Tests failed:", failed);
    process.exitCode = 1;
    return;
  }
  console.log("All tests passed:", tests.length);
}

run();
