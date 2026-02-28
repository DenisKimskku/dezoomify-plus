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
    query: opts.query || {},
    headers: opts.headers || {},
    url: opts.url || "/api/metrics",
    body: opts.body,
    socket: { remoteAddress: opts.remoteAddress || "203.0.113.9" },
  };
}

function createRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader: function (name, value) {
      this.headers[name] = value;
    },
    end: function (value) {
      this.body = String(value || "");
    },
  };
}

function parseBody(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_) {
    return {};
  }
}

async function withHandler(envPatch, runFn, routeOptions) {
  var previous = {};
  Object.keys(envPatch || {}).forEach(function (key) {
    previous[key] = process.env[key];
    if (envPatch[key] === null) delete process.env[key];
    else process.env[key] = String(envPatch[key]);
  });

  delete global.__dezoomifyObservabilityMetrics;
  global.__dezoomifyPrimaryStore = createPersistentTestStore();
  var storagePath = require.resolve("../lib/storage-service");
  var authPath = require.resolve("../lib/auth-service");
  var jobsServicePath = require.resolve("../lib/jobs-service");
  var handlerPath = require.resolve("../api/observability");
  delete require.cache[storagePath];
  delete require.cache[authPath];
  delete require.cache[jobsServicePath];
  delete require.cache[handlerPath];
  var rootHandler = require(handlerPath);
  var route = routeOptions && typeof routeOptions === "object" ? routeOptions : {};
  var scope = String(route.scope || "metrics");
  var defaultURL = route.url || (scope === "my_metrics" ? "/api/my-metrics" : "/api/metrics");
  var handler = function metricsScopeHandler(req, res) {
    if (!req.query || !req.query.scope) {
      req.query = Object.assign({}, req.query || {}, { scope: scope });
    }
    req.url = req.url || defaultURL;
    return rootHandler(req, res);
  };

  try {
    return await runFn(handler);
  } finally {
    Object.keys(envPatch || {}).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[storagePath];
    delete require.cache[authPath];
    delete require.cache[jobsServicePath];
    delete require.cache[handlerPath];
    delete global.__dezoomifyPrimaryStore;
    delete global.__dezoomifySharedMemoryStore;
    delete global.__dezoomifyJobsMemoryStore;
    delete global.__dezoomifyAsyncMemoryStore;
    delete global.__dezoomifyObservabilityMetrics;
  }
}

var tests = [
  test("metrics endpoint allows GET without token when unset", async function () {
    await withHandler({ METRICS_READ_TOKEN: null, OBSERVABILITY_ENABLED: "false" }, async function (handler) {
      var req = createReq({ method: "GET" });
      var res = createRes();
      await handler(req, res);
      var payload = parseBody(res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(payload.ok, true);
      assert.ok(payload.metrics && payload.metrics.counters);
      assert.ok(Array.isArray(payload.metrics.recentBuckets));
      assert.ok(payload.metrics.rollups && typeof payload.metrics.rollups === "object");
      assert.ok(Array.isArray(payload.metrics.alerts));
    });
  }),

  test("metrics endpoint rejects non-GET", async function () {
    await withHandler({ METRICS_READ_TOKEN: null, OBSERVABILITY_ENABLED: "false" }, async function (handler) {
      var req = createReq({ method: "POST" });
      var res = createRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 405);
      assert.ok(/Only GET requests/.test(res.body));
    });
  }),

  test("metrics endpoint enforces token", async function () {
    await withHandler({ METRICS_READ_TOKEN: "topsecret", OBSERVABILITY_ENABLED: "false" }, async function (handler) {
      var req = createReq({ method: "GET" });
      var res = createRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 401);
      assert.ok(/Unauthorized/.test(res.body));
    });
  }),

  test("metrics endpoint accepts bearer token", async function () {
    await withHandler({ METRICS_READ_TOKEN: "topsecret", OBSERVABILITY_ENABLED: "false" }, async function (handler) {
      var req = createReq({
        method: "GET",
        headers: { authorization: "Bearer topsecret" },
      });
      var res = createRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 200);
      var payload = parseBody(res);
      assert.strictEqual(payload.ok, true);
    });
  }),

  test("service metrics require admin role when auth is enforced", async function () {
    await withHandler(
      {
        METRICS_READ_TOKEN: null,
        OBSERVABILITY_ENABLED: "false",
        AUTH_ENFORCE_ADVANCED: "true",
        AUTH_OPEN_SIGNUP: "true",
      },
      async function (handler) {
        var registerReq = createReq({
          method: "POST",
          query: { scope: "auth", action: "register" },
          url: "/api/auth/register",
          body: { email: "user@example.com", password: "Password123" },
        });
        var registerRes = createRes();
        await handler(registerReq, registerRes);
        assert.strictEqual(registerRes.statusCode, 201);
        var cookie = String(registerRes.headers["Set-Cookie"] || "").split(";")[0];

        var forbiddenReq = createReq({
          method: "GET",
          headers: { cookie: cookie },
        });
        var forbiddenRes = createRes();
        await handler(forbiddenReq, forbiddenRes);
        assert.strictEqual(forbiddenRes.statusCode, 403);
      }
    );
  }),

  test("personal metrics are available to signed-in non-admin users", async function () {
    await withHandler(
      {
        METRICS_READ_TOKEN: "topsecret",
        OBSERVABILITY_ENABLED: "false",
        AUTH_ENFORCE_ADVANCED: "true",
        AUTH_OPEN_SIGNUP: "true",
      },
      async function (handler) {
        var registerReqA = createReq({
          method: "POST",
          query: { scope: "auth", action: "register" },
          url: "/api/auth/register",
          body: { email: "user-a@example.com", password: "Password123" },
        });
        var registerResA = createRes();
        await handler(registerReqA, registerResA);
        assert.strictEqual(registerResA.statusCode, 201);
        var cookieA = String(registerResA.headers["Set-Cookie"] || "").split(";")[0];

        var registerReqB = createReq({
          method: "POST",
          query: { scope: "auth", action: "register" },
          url: "/api/auth/register",
          body: { email: "user-b@example.com", password: "Password123" },
        });
        var registerResB = createRes();
        await handler(registerReqB, registerResB);
        assert.strictEqual(registerResB.statusCode, 201);
        var cookieB = String(registerResB.headers["Set-Cookie"] || "").split(";")[0];

        var userAFirstReq = createReq({
          method: "GET",
          headers: { cookie: cookieA },
        });
        var userAFirstRes = createRes();
        await handler(userAFirstReq, userAFirstRes);
        assert.strictEqual(userAFirstRes.statusCode, 200);
        var userAFirstPayload = parseBody(userAFirstRes);
        assert.strictEqual(userAFirstPayload.ok, true);
        assert.strictEqual(userAFirstPayload.mode, "personal");

        var userBReq = createReq({
          method: "GET",
          headers: { cookie: cookieB },
        });
        var userBRes = createRes();
        await handler(userBReq, userBRes);
        assert.strictEqual(userBRes.statusCode, 200);

        var userASecondReq = createReq({
          method: "GET",
          headers: { cookie: cookieA },
        });
        var userASecondRes = createRes();
        await handler(userASecondReq, userASecondRes);
        assert.strictEqual(userASecondRes.statusCode, 200);
        var userASecondPayload = parseBody(userASecondRes);
        assert.strictEqual(userASecondPayload.ok, true);
        assert.strictEqual(userASecondPayload.mode, "personal");
        var totalRequests = Number(
          userASecondPayload.metrics &&
            userASecondPayload.metrics.counters &&
            userASecondPayload.metrics.counters["http.requests.total"]
        ) || 0;
        assert.ok(totalRequests <= 2, "personal metrics should not include other users");
      },
      {
        scope: "my_metrics",
        url: "/api/my-metrics",
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
