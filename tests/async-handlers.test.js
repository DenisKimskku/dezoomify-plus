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
    url: opts.url || "/api/test",
    socket: { remoteAddress: opts.remoteAddress || "198.51.100.50" },
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
      if (Buffer.isBuffer(value)) {
        this.body = value;
        return;
      }
      this.body = Buffer.from(String(value));
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

  delete global.__dezoomifyAsyncMemoryStore;
  delete global.__dezoomifyObservabilityMetrics;

  var asyncServicePath = require.resolve("../lib/async-service");
  var submitPath = require.resolve("../api/submit");
  var statusPath = require.resolve("../api/status");
  var downloadPath = require.resolve("../api/download");
  var listPath = require.resolve("../api/list");
  var retryPath = require.resolve("../api/retry");
  var retryBulkPath = require.resolve("../api/retry-bulk");
  var removeBulkPath = require.resolve("../api/remove-bulk");
  var cancelPath = require.resolve("../api/cancel");
  delete require.cache[asyncServicePath];
  delete require.cache[submitPath];
  delete require.cache[statusPath];
  delete require.cache[downloadPath];
  delete require.cache[listPath];
  delete require.cache[retryPath];
  delete require.cache[retryBulkPath];
  delete require.cache[removeBulkPath];
  delete require.cache[cancelPath];

  var asyncService = require(asyncServicePath);
  var submit = require(submitPath);
  var status = require(statusPath);
  var download = require(downloadPath);
  var list = require(listPath);
  var retry = require(retryPath);
  var retryBulk = require(retryBulkPath);
  var removeBulk = require(removeBulkPath);
  var cancel = require(cancelPath);

  try {
    return await runFn({
      asyncService: asyncService,
      submit: submit,
      status: status,
      download: download,
      list: list,
      retry: retry,
      retryBulk: retryBulk,
      removeBulk: removeBulk,
      cancel: cancel,
    });
  } finally {
    Object.keys(mergedPatch).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[asyncServicePath];
    delete require.cache[submitPath];
    delete require.cache[statusPath];
    delete require.cache[downloadPath];
    delete require.cache[listPath];
    delete require.cache[retryPath];
    delete require.cache[retryBulkPath];
    delete require.cache[removeBulkPath];
    delete require.cache[cancelPath];
    delete global.__dezoomifyAsyncMemoryStore;
    delete global.__dezoomifyObservabilityMetrics;
  }
}

var tests = [
  test("submit handler validates method", async function () {
    await withHandlers({}, async function (ctx) {
      var req = createReq({ method: "GET" });
      var res = createRes();
      await ctx.submit(req, res);
      assert.strictEqual(res.statusCode, 405);
    });
  }),

  test("submit -> status -> download flow with range support", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.77";
      var submitReq = createReq({
        method: "POST",
        url: "/api/submit",
        remoteAddress: remote,
        body: { url: "https://example.com/async" },
      });
      var submitRes = createRes();
      await ctx.submit(submitReq, submitRes);
      assert.strictEqual(submitRes.statusCode, 202);
      var submitPayload = parseBody(submitRes);
      assert.strictEqual(submitPayload.ok, true);
      assert.ok(submitPayload.job && submitPayload.job.id);
      assert.strictEqual(submitPayload.job.status, "queued");
      var jobID = submitPayload.job.id;

      var ownerID = ctx.asyncService.buildAnonOwnerId(submitReq);
      await ctx.asyncService.runPendingJobsForOwner(ownerID, 1, {
        probeRunner: async function () {
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });

      var statusReq = createReq({
        method: "GET",
        url: "/api/status?id=" + encodeURIComponent(jobID),
        query: { id: jobID },
        remoteAddress: remote,
      });
      var statusRes = createRes();
      await ctx.status(statusReq, statusRes);
      assert.strictEqual(statusRes.statusCode, 200);
      var statusPayload = parseBody(statusRes);
      assert.strictEqual(statusPayload.ok, true);
      assert.strictEqual(statusPayload.job.status, "completed");
      assert.strictEqual(statusPayload.job.artifactAvailable, true);

      var downloadReq = createReq({
        method: "GET",
        url: "/api/download?id=" + encodeURIComponent(jobID),
        query: { id: jobID },
        remoteAddress: remote,
      });
      var downloadRes = createRes();
      await ctx.download(downloadReq, downloadRes);
      assert.strictEqual(downloadRes.statusCode, 200);
      assert.ok(downloadRes.headers["Accept-Ranges"]);
      assert.ok(downloadRes.body.length > 0);

      var partialReq = createReq({
        method: "GET",
        url: "/api/download?id=" + encodeURIComponent(jobID),
        query: { id: jobID },
        remoteAddress: remote,
        headers: { range: "bytes=0-20" },
      });
      var partialRes = createRes();
      await ctx.download(partialReq, partialRes);
      assert.strictEqual(partialRes.statusCode, 206);
      assert.ok(partialRes.headers["Content-Range"]);
      assert.strictEqual(partialRes.body.length, 21);
    });
  }),

  test("download works for chunked artifact storage mode", async function () {
    await withHandlers(
      {
        ASYNC_ARTIFACT_STORAGE_MODE: "chunked",
        ASYNC_ARTIFACT_CHUNK_BYTES: "1024",
        ASYNC_MAX_ARTIFACT_CHUNKS: "50",
        ASYNC_MAX_ARTIFACT_BYTES: "8192",
      },
      async function (ctx) {
        var remote = "198.51.100.78";
        var submitReq = createReq({
          method: "POST",
          url: "/api/submit",
          remoteAddress: remote,
          body: { url: "https://example.com/async-chunked" },
        });
        var submitRes = createRes();
        await ctx.submit(submitReq, submitRes);
        assert.strictEqual(submitRes.statusCode, 202);
        var submitPayload = parseBody(submitRes);
        var jobID = submitPayload.job.id;

        var ownerID = ctx.asyncService.buildAnonOwnerId(submitReq);
        await ctx.asyncService.runPendingJobsForOwner(ownerID, 1, {
          probeRunner: async function () {
            return {
              ok: true,
              statusCode: 200,
              message: "HTTP 200 chunked " + new Array(5000).join("x"),
            };
          },
        });

        var statusReq = createReq({
          method: "GET",
          query: { id: jobID },
          remoteAddress: remote,
        });
        var statusRes = createRes();
        await ctx.status(statusReq, statusRes);
        assert.strictEqual(statusRes.statusCode, 200);
        var statusPayload = parseBody(statusRes);
        assert.strictEqual(statusPayload.job.status, "completed");
        assert.strictEqual(statusPayload.job.artifact.storage, "chunked");

        var downloadReq = createReq({
          method: "GET",
          query: { id: jobID },
          remoteAddress: remote,
        });
        var downloadRes = createRes();
        await ctx.download(downloadReq, downloadRes);
        assert.strictEqual(downloadRes.statusCode, 200);
        assert.ok(downloadRes.body.length > 0);

        var partialReq = createReq({
          method: "GET",
          query: { id: jobID },
          remoteAddress: remote,
          headers: { range: "bytes=10-90" },
        });
        var partialRes = createRes();
        await ctx.download(partialReq, partialRes);
        assert.strictEqual(partialRes.statusCode, 206);
        assert.strictEqual(partialRes.body.length, 81);
      }
    );
  }),

  test("status hides jobs from other owners", async function () {
    await withHandlers({}, async function (ctx) {
      var submitReq = createReq({
        method: "POST",
        remoteAddress: "198.51.100.90",
        body: { url: "https://example.com/owner-a" },
      });
      var submitRes = createRes();
      await ctx.submit(submitReq, submitRes);
      var payload = parseBody(submitRes);
      var jobID = payload.job.id;

      var statusReq = createReq({
        method: "GET",
        query: { id: jobID },
        remoteAddress: "198.51.100.91",
      });
      var statusRes = createRes();
      await ctx.status(statusReq, statusRes);
      assert.strictEqual(statusRes.statusCode, 404);
    });
  }),

  test("list endpoint returns filtered jobs for owner", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.93";
      var submitAReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/list-handler-a" },
      });
      var submitARes = createRes();
      await ctx.submit(submitAReq, submitARes);
      var submitAPayload = parseBody(submitARes);

      var submitBReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/list-handler-b" },
      });
      var submitBRes = createRes();
      await ctx.submit(submitBReq, submitBRes);
      var submitBPayload = parseBody(submitBRes);

      var ownerID = ctx.asyncService.buildAnonOwnerId(submitAReq);
      await ctx.asyncService.runPendingJobsForOwner(ownerID, 2, {
        probeRunner: async function (url) {
          if (String(url).indexOf("list-handler-b") >= 0) {
            return { ok: false, statusCode: 503, message: "HTTP 503" };
          }
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });

      var listReq = createReq({
        method: "GET",
        remoteAddress: remote,
        query: { status: "error", limit: "10" },
      });
      var listRes = createRes();
      await ctx.list(listReq, listRes);
      assert.strictEqual(listRes.statusCode, 200);
      var listPayload = parseBody(listRes);
      assert.strictEqual(listPayload.ok, true);
      assert.strictEqual(listPayload.jobs.length, 1);
      assert.strictEqual(listPayload.jobs[0].id, submitBPayload.job.id);
      assert.notStrictEqual(listPayload.jobs[0].id, submitAPayload.job.id);
      assert.strictEqual(listPayload.jobs[0].status, "error");
    });
  }),

  test("retry endpoint creates a new queued job scoped to owner", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.94";
      var submitReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/retry-handler" },
      });
      var submitRes = createRes();
      await ctx.submit(submitReq, submitRes);
      var submitPayload = parseBody(submitRes);
      var sourceJobID = submitPayload.job.id;

      var ownerID = ctx.asyncService.buildAnonOwnerId(submitReq);
      await ctx.asyncService.runPendingJobsForOwner(ownerID, 1, {
        probeRunner: async function () {
          return { ok: false, statusCode: 500, message: "HTTP 500" };
        },
      });

      var retryReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { id: sourceJobID },
      });
      var retryRes = createRes();
      await ctx.retry(retryReq, retryRes);
      assert.strictEqual(retryRes.statusCode, 202);
      var retryPayload = parseBody(retryRes);
      assert.strictEqual(retryPayload.ok, true);
      assert.strictEqual(retryPayload.sourceJobId, sourceJobID);
      assert.ok(retryPayload.job && retryPayload.job.id);
      assert.notStrictEqual(retryPayload.job.id, sourceJobID);
      assert.strictEqual(retryPayload.job.status, "queued");
    });
  }),

  test("retry-bulk endpoint retries multiple jobs for owner", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.95";
      var submitAReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/retry-bulk-a" },
      });
      var submitARes = createRes();
      await ctx.submit(submitAReq, submitARes);
      var submitAPayload = parseBody(submitARes);

      var submitBReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/retry-bulk-b" },
      });
      var submitBRes = createRes();
      await ctx.submit(submitBReq, submitBRes);
      var submitBPayload = parseBody(submitBRes);

      var ownerID = ctx.asyncService.buildAnonOwnerId(submitAReq);
      await ctx.asyncService.runPendingJobsForOwner(ownerID, 2, {
        probeRunner: async function () {
          return { ok: false, statusCode: 500, message: "HTTP 500" };
        },
      });

      var retryBulkReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { ids: [submitAPayload.job.id, submitBPayload.job.id] },
      });
      var retryBulkRes = createRes();
      await ctx.retryBulk(retryBulkReq, retryBulkRes);
      assert.strictEqual(retryBulkRes.statusCode, 200);
      var retryBulkPayload = parseBody(retryBulkRes);
      assert.strictEqual(retryBulkPayload.ok, true);
      assert.strictEqual(retryBulkPayload.requested, 2);
      assert.strictEqual(retryBulkPayload.successCount, 2);
      assert.strictEqual(retryBulkPayload.results.length, 2);
      assert.ok(retryBulkPayload.results[0].job && retryBulkPayload.results[0].job.id);
      assert.ok(retryBulkPayload.results[1].job && retryBulkPayload.results[1].job.id);
      assert.notStrictEqual(retryBulkPayload.results[0].job.id, submitAPayload.job.id);
      assert.notStrictEqual(retryBulkPayload.results[1].job.id, submitBPayload.job.id);
    });
  }),

  test("cancel endpoint cancels queued jobs for owner", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.97";
      var submitReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/cancel-handler" },
      });
      var submitRes = createRes();
      await ctx.submit(submitReq, submitRes);
      var submitPayload = parseBody(submitRes);

      var cancelReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { id: submitPayload.job.id },
      });
      var cancelRes = createRes();
      await ctx.cancel(cancelReq, cancelRes);
      assert.strictEqual(cancelRes.statusCode, 200);
      var cancelPayload = parseBody(cancelRes);
      assert.strictEqual(cancelPayload.ok, true);
      assert.strictEqual(cancelPayload.job.status, "canceled");
    });
  }),

  test("remove-bulk endpoint deletes selected jobs for owner", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.96";
      var submitReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/remove-bulk-a" },
      });
      var submitRes = createRes();
      await ctx.submit(submitReq, submitRes);
      var submitPayload = parseBody(submitRes);
      var jobID = submitPayload.job.id;

      var removeBulkReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { ids: [jobID] },
      });
      var removeBulkRes = createRes();
      await ctx.removeBulk(removeBulkReq, removeBulkRes);
      assert.strictEqual(removeBulkRes.statusCode, 200);
      var removePayload = parseBody(removeBulkRes);
      assert.strictEqual(removePayload.ok, true);
      assert.strictEqual(removePayload.requested, 1);
      assert.strictEqual(removePayload.removed, 1);
      assert.strictEqual(removePayload.removedIds.length, 1);
      assert.strictEqual(removePayload.removedIds[0], jobID);

      var statusReq = createReq({
        method: "GET",
        query: { id: jobID },
        remoteAddress: remote,
      });
      var statusRes = createRes();
      await ctx.status(statusReq, statusRes);
      assert.strictEqual(statusRes.statusCode, 404);
    });
  }),

  test("download returns not-ready and invalid-range errors", async function () {
    await withHandlers({}, async function (ctx) {
      var remote = "198.51.100.110";
      var submitReq = createReq({
        method: "POST",
        remoteAddress: remote,
        body: { url: "https://example.com/not-ready" },
      });
      var submitRes = createRes();
      await ctx.submit(submitReq, submitRes);
      var payload = parseBody(submitRes);
      var jobID = payload.job.id;

      var earlyReq = createReq({
        method: "GET",
        query: { id: jobID },
        remoteAddress: remote,
      });
      var earlyRes = createRes();
      await ctx.download(earlyReq, earlyRes);
      assert.strictEqual(earlyRes.statusCode, 409);

      var ownerID = ctx.asyncService.buildAnonOwnerId(submitReq);
      await ctx.asyncService.runPendingJobsForOwner(ownerID, 1, {
        probeRunner: async function () {
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });

      var invalidRangeReq = createReq({
        method: "GET",
        query: { id: jobID },
        remoteAddress: remote,
        headers: { range: "bytes=999999-1000000" },
      });
      var invalidRangeRes = createRes();
      await ctx.download(invalidRangeReq, invalidRangeRes);
      assert.strictEqual(invalidRangeRes.statusCode, 416);
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
