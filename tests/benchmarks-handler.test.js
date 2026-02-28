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
    body: opts.body,
    socket: { remoteAddress: opts.remoteAddress || "198.51.100.40" },
    on: function () {},
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
  var mergedPatch = Object.assign({ OBSERVABILITY_ENABLED: "false" }, envPatch || {});
  var previous = {};
  Object.keys(mergedPatch).forEach(function (key) {
    previous[key] = process.env[key];
    if (mergedPatch[key] === null) delete process.env[key];
    else process.env[key] = String(mergedPatch[key]);
  });

  delete global.__dezoomifyBenchMemoryStore;
  delete global.__dezoomifyObservabilityMetrics;

  var benchmarksLibPath = require.resolve("../lib/benchmark-trends");
  var observabilityPath = require.resolve("../lib/observability");
  var handlerPath = require.resolve("../api/benchmarks");
  delete require.cache[benchmarksLibPath];
  delete require.cache[observabilityPath];
  delete require.cache[handlerPath];
  var handler = require(handlerPath);

  try {
    return await runFn(handler);
  } finally {
    Object.keys(mergedPatch).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[benchmarksLibPath];
    delete require.cache[observabilityPath];
    delete require.cache[handlerPath];
    delete global.__dezoomifyBenchMemoryStore;
    delete global.__dezoomifyObservabilityMetrics;
  }
}

var tests = [
  test("benchmark endpoint allows unauthenticated GET when token unset", async function () {
    await withHandler(
      { BENCHMARK_READ_TOKEN: null, BENCHMARK_WRITE_TOKEN: null },
      async function (handler) {
        var req = createReq({ method: "GET" });
        var res = createRes();
        await handler(req, res);
        var payload = parseBody(res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(payload.ok, true);
        assert.ok(Array.isArray(payload.runs));
      }
    );
  }),

  test("benchmark endpoint stores run with POST and returns via GET", async function () {
    await withHandler(
      { BENCHMARK_READ_TOKEN: null, BENCHMARK_WRITE_TOKEN: null },
      async function (handler) {
        var postReq = createReq({
          method: "POST",
          body: {
            suite: "jobs-state",
            report: { durationMs: 100, perJobMs: 1.5 },
            metadata: { source: "test" },
          },
        });
        var postRes = createRes();
        await handler(postReq, postRes);
        assert.strictEqual(postRes.statusCode, 201);
        var postPayload = parseBody(postRes);
        assert.strictEqual(postPayload.ok, true);
        assert.strictEqual(postPayload.suite, "jobs-state");

        var getReq = createReq({
          method: "GET",
          query: { suite: "jobs-state", limit: "10" },
        });
        var getRes = createRes();
        await handler(getReq, getRes);
        var getPayload = parseBody(getRes);
        assert.strictEqual(getRes.statusCode, 200);
        assert.strictEqual(getPayload.ok, true);
        assert.ok(Array.isArray(getPayload.runs));
        assert.strictEqual(getPayload.runs.length, 1);
        assert.strictEqual(getPayload.runs[0].suite, "jobs-state");
        assert.ok(getPayload.runs[0].report);
      }
    );
  }),

  test("benchmark endpoint enforces read token", async function () {
    await withHandler(
      { BENCHMARK_READ_TOKEN: "reader-secret", BENCHMARK_WRITE_TOKEN: "writer-secret" },
      async function (handler) {
        var req = createReq({ method: "GET" });
        var res = createRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 401);
        assert.ok(/Unauthorized/.test(res.body));
      }
    );
  }),

  test("benchmark endpoint enforces write token", async function () {
    await withHandler(
      { BENCHMARK_READ_TOKEN: null, BENCHMARK_WRITE_TOKEN: "writer-secret" },
      async function (handler) {
        var req = createReq({
          method: "POST",
          body: { suite: "jobs-state", report: { durationMs: 50 } },
        });
        var res = createRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 401);
        assert.ok(/Unauthorized/.test(res.body));
      }
    );
  }),

  test("benchmark endpoint rejects unsupported methods", async function () {
    await withHandler({}, async function (handler) {
      var req = createReq({ method: "PATCH" });
      var res = createRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 405);
      assert.ok(/Only GET and POST requests/.test(res.body));
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
