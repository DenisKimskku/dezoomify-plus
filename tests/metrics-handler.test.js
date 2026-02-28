"use strict";

var assert = require("assert");

function test(name, fn) {
  return { name: name, fn: fn };
}

function createReq(options) {
  var opts = options || {};
  return {
    method: opts.method || "GET",
    query: opts.query || {},
    headers: opts.headers || {},
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

async function withHandler(envPatch, runFn) {
  var previous = {};
  Object.keys(envPatch || {}).forEach(function (key) {
    previous[key] = process.env[key];
    if (envPatch[key] === null) delete process.env[key];
    else process.env[key] = String(envPatch[key]);
  });

  delete global.__dezoomifyObservabilityMetrics;
  var handlerPath = require.resolve("../api/metrics");
  delete require.cache[handlerPath];
  var handler = require(handlerPath);

  try {
    return await runFn(handler);
  } finally {
    Object.keys(envPatch || {}).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[handlerPath];
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
