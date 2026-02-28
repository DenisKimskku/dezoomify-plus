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
    url: opts.url || "/api/history",
    socket: { remoteAddress: opts.remoteAddress || "198.51.100.33" },
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

  delete global.__dezoomifyJobsMemoryStore;
  delete global.__dezoomifyObservabilityMetrics;

  var jobsServicePath = require.resolve("../lib/jobs-service");
  var jobsPath = require.resolve("../api/jobs");
  var historyPath = require.resolve("../api/history");
  delete require.cache[jobsServicePath];
  delete require.cache[jobsPath];
  delete require.cache[historyPath];

  var jobs = require(jobsPath);
  var history = require(historyPath);

  try {
    return await runFn({ jobs: jobs, history: history });
  } finally {
    Object.keys(mergedPatch).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[jobsServicePath];
    delete require.cache[jobsPath];
    delete require.cache[historyPath];
    delete global.__dezoomifyJobsMemoryStore;
    delete global.__dezoomifyObservabilityMetrics;
  }
}

var tests = [
  test("history handler validates method", async function () {
    await withHandlers({}, async function (ctx) {
      var req = createReq({ method: "POST" });
      var res = createRes();
      await ctx.history(req, res);
      assert.strictEqual(res.statusCode, 405);
    });
  }),

  test("history handler returns filtered and paginated items", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.34";
      var putReq = createReq({
        method: "PUT",
        remoteAddress: remote,
        body: {
          schedules: [],
          history: [
            {
              id: "h-1",
              url: "https://example.com/one",
              source: "manual",
              status: "success",
              startedAt: Date.now() - 5000,
              finishedAt: Date.now() - 2000,
              durationMs: 3000,
              message: "ok",
            },
            {
              id: "h-2",
              url: "https://example.com/two",
              source: "manual",
              status: "error",
              startedAt: Date.now() - 3000,
              finishedAt: Date.now() - 1000,
              durationMs: 2000,
              message: "failed",
            },
          ],
        },
      });
      var putRes = createRes();
      await ctx.jobs(putReq, putRes);
      assert.strictEqual(putRes.statusCode, 200);

      var filteredReq = createReq({
        method: "GET",
        remoteAddress: remote,
        query: { status: "error", limit: "10", q: "two" },
      });
      var filteredRes = createRes();
      await ctx.history(filteredReq, filteredRes);
      assert.strictEqual(filteredRes.statusCode, 200);
      var filteredPayload = parseBody(filteredRes);
      assert.strictEqual(filteredPayload.ok, true);
      assert.strictEqual(filteredPayload.total, 1);
      assert.strictEqual(filteredPayload.items.length, 1);
      assert.strictEqual(filteredPayload.items[0].id, "h-2");

      var pageOneReq = createReq({
        method: "GET",
        remoteAddress: remote,
        query: { limit: "1", cursor: "0" },
      });
      var pageOneRes = createRes();
      await ctx.history(pageOneReq, pageOneRes);
      var pageOnePayload = parseBody(pageOneRes);
      assert.strictEqual(pageOnePayload.items.length, 1);
      assert.ok(pageOnePayload.nextCursor);

      var pageTwoReq = createReq({
        method: "GET",
        remoteAddress: remote,
        query: { limit: "1", cursor: pageOnePayload.nextCursor },
      });
      var pageTwoRes = createRes();
      await ctx.history(pageTwoReq, pageTwoRes);
      var pageTwoPayload = parseBody(pageTwoRes);
      assert.strictEqual(pageTwoPayload.items.length, 1);
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
