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
    socket: { remoteAddress: opts.remoteAddress || "198.51.100.5" },
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

async function withCron(envPatch, runFn) {
  var patch = Object.assign({ OBSERVABILITY_ENABLED: "false" }, envPatch || {});
  var previous = {};
  Object.keys(patch).forEach(function (key) {
    previous[key] = process.env[key];
    if (patch[key] === null) delete process.env[key];
    else process.env[key] = String(patch[key]);
  });

  delete global.__dezoomifyJobsMemoryStore;
  delete global.__dezoomifyAsyncMemoryStore;
  delete global.__dezoomifyObservabilityMetrics;

  var asyncServicePath = require.resolve("../lib/async-service");
  var cronPath = require.resolve("../api/cron");
  delete require.cache[asyncServicePath];
  delete require.cache[cronPath];

  var asyncService = require(asyncServicePath);
  var cronHandler = require(cronPath);

  try {
    return await runFn({ asyncService: asyncService, cronHandler: cronHandler });
  } finally {
    Object.keys(patch).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[asyncServicePath];
    delete require.cache[cronPath];
    delete global.__dezoomifyJobsMemoryStore;
    delete global.__dezoomifyAsyncMemoryStore;
    delete global.__dezoomifyObservabilityMetrics;
  }
}

var tests = [
  test("cron rejects invalid secret", async function () {
    await withCron({ CRON_SECRET: "secret" }, async function (ctx) {
      var req = createReq({ method: "GET", query: {} });
      var res = createRes();
      await ctx.cronHandler(req, res);
      assert.strictEqual(res.statusCode, 401);
      assert.ok(/Unauthorized/.test(res.body));
    });
  }),

  test("cron processes async queue and reports counters", async function () {
    await withCron(
      {
        CRON_SECRET: "secret",
        ASYNC_MAX_JOBS_PER_CRON_RUN: "5",
        ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN: "10",
      },
      async function (ctx) {
        await ctx.asyncService.submitJob("owner-a", "owner-a", "http://127.0.0.1/private");

        var req = createReq({
          method: "GET",
          query: { secret: "secret" },
        });
        var res = createRes();
        await ctx.cronHandler(req, res);
        assert.strictEqual(res.statusCode, 200);
        var payload = parseBody(res);
        assert.strictEqual(payload.ok, true);
        assert.ok(payload.asyncJobsRun >= 1);
        assert.ok(payload.asyncError >= 1);
        assert.ok(payload.asyncMaxJobsPerRun >= 1);
        assert.ok(payload.asyncCleanupMaxJobsPerRun >= 1);
        assert.ok(payload.asyncCleanupScanned >= 0);
        assert.ok(payload.asyncCleanupPurged >= 0);
      }
    );
  }),

  test("cron cleanup purges expired async jobs", async function () {
    await withCron(
      {
        CRON_SECRET: "secret",
        ASYNC_MAX_JOBS_PER_CRON_RUN: "1",
        ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN: "20",
        ASYNC_CLEANUP_EXPIRED_GRACE_MS: "0",
        ASYNC_JOB_TTL_MS: "60000",
        ASYNC_ARTIFACT_TTL_MS: "60000",
      },
      async function (ctx) {
        var submitted = await ctx.asyncService.submitJob("owner-a", "owner-a", "https://example.com/cleanup-cron");
        await ctx.asyncService.runPendingJobsForOwner("owner-a", 1, {
          probeRunner: async function () {
            return { ok: true, statusCode: 200, message: "HTTP 200" };
          },
        });

        var baseNow = Date.now;
        try {
          Date.now = function () {
            return baseNow() + 61000;
          };
          var req = createReq({
            method: "GET",
            query: { secret: "secret" },
          });
          var res = createRes();
          await ctx.cronHandler(req, res);
          assert.strictEqual(res.statusCode, 200);
          var payload = parseBody(res);
          assert.strictEqual(payload.ok, true);
          assert.ok(payload.asyncCleanupPurged >= 1);
        } finally {
          Date.now = baseNow;
        }

        var loaded = await ctx.asyncService.getJobForOwner("owner-a", submitted.job.id);
        assert.strictEqual(loaded.job, null);
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
