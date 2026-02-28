"use strict";

var assert = require("assert");

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function test(name, fn) {
  return { name: name, fn: fn };
}

async function withService(envPatch, runFn) {
  var patch = Object.assign({}, envPatch || {});
  var previous = {};
  Object.keys(patch).forEach(function (key) {
    previous[key] = process.env[key];
    if (patch[key] === null) delete process.env[key];
    else process.env[key] = String(patch[key]);
  });

  delete global.__dezoomifyAsyncMemoryStore;
  var servicePath = require.resolve("../lib/async-service");
  delete require.cache[servicePath];
  var service = require(servicePath);

  try {
    return await runFn(service);
  } finally {
    Object.keys(patch).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[servicePath];
    delete global.__dezoomifyAsyncMemoryStore;
  }
}

var tests = [
  test("submitJob queues a job and enforces owner scoping", async function () {
    await withService({}, async function (service) {
      var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/a");
      assert.ok(submitted.job);
      assert.strictEqual(submitted.job.status, "queued");
      assert.strictEqual(submitted.job.targetURL, "https://example.com/a");

      var loaded = await service.getJobForOwner("owner-a", submitted.job.id);
      assert.ok(loaded.job);
      assert.strictEqual(loaded.job.status, "queued");

      var hidden = await service.getJobForOwner("owner-b", submitted.job.id);
      assert.strictEqual(hidden.job, null);
    });
  }),

  test("runPendingJobsForOwner completes job and creates artifact", async function () {
    await withService({}, async function (service) {
      var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/a");
      var result = await service.runPendingJobsForOwner("owner-a", 5, {
        probeRunner: async function () {
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });
      assert.strictEqual(result.jobsRun, 1);
      assert.strictEqual(result.successCount, 1);

      var loaded = await service.getJobForOwner("owner-a", submitted.job.id);
      assert.ok(loaded.job);
      assert.strictEqual(loaded.job.status, "completed");
      assert.ok(loaded.job.artifact);

      var artifact = await service.getArtifactForOwner("owner-a", submitted.job.id);
      assert.strictEqual(artifact.ok, true);
      assert.ok(Buffer.isBuffer(artifact.buffer));
      assert.ok(artifact.buffer.toString("utf8").indexOf(submitted.job.id) >= 0);
    });
  }),

  test("runPendingJobs aggregates across owners", async function () {
    await withService({}, async function (service) {
      await service.submitJob("owner-a", "owner-a", "https://example.com/a");
      await service.submitJob("owner-b", "owner-b", "https://example.com/b");
      var result = await service.runPendingJobs(10, Date.now(), {
        probeRunner: async function (url) {
          if (String(url).indexOf("/b") >= 0) {
            return { ok: false, statusCode: 503, message: "HTTP 503" };
          }
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });
      assert.strictEqual(result.jobsRun, 2);
      assert.strictEqual(result.successCount, 1);
      assert.strictEqual(result.errorCount, 1);
    });
  }),

  test("parseByteRange supports normal and suffix ranges", async function () {
    await withService({}, async function (service) {
      var full = service.parseByteRange("", 100);
      assert.strictEqual(full, null);

      var span = service.parseByteRange("bytes=10-19", 100);
      assert.strictEqual(span.valid, true);
      assert.strictEqual(span.start, 10);
      assert.strictEqual(span.end, 19);

      var suffix = service.parseByteRange("bytes=-20", 100);
      assert.strictEqual(suffix.valid, true);
      assert.strictEqual(suffix.start, 80);
      assert.strictEqual(suffix.end, 99);

      var openEnd = service.parseByteRange("bytes=95-", 100);
      assert.strictEqual(openEnd.valid, true);
      assert.strictEqual(openEnd.start, 95);
      assert.strictEqual(openEnd.end, 99);

      var invalid = service.parseByteRange("bytes=500-900", 100);
      assert.strictEqual(invalid.valid, false);
    });
  }),

  test("artifact expiration is enforced", async function () {
    await withService(
      {
        ASYNC_ARTIFACT_TTL_MS: "60000",
        ASYNC_JOB_TTL_MS: "60000",
      },
      async function (service) {
        var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/a");
        await service.runPendingJobsForOwner("owner-a", 1, {
          probeRunner: async function () {
            return { ok: true, statusCode: 200, message: "HTTP 200" };
          },
        });
        var originalNow = Date.now;
        try {
          Date.now = function () {
            return originalNow() + 61000;
          };
          var artifact = await service.getArtifactForOwner("owner-a", submitted.job.id);
          assert.strictEqual(artifact.ok, false);
          assert.strictEqual(artifact.statusCode, 410);
        } finally {
          Date.now = originalNow;
        }
      }
    );
  }),

  test("chunked artifact storage works and cleans up on expiry", async function () {
    await withService(
      {
        ASYNC_ARTIFACT_STORAGE_MODE: "chunked",
        ASYNC_ARTIFACT_CHUNK_BYTES: "1024",
        ASYNC_MAX_ARTIFACT_CHUNKS: "50",
        ASYNC_MAX_ARTIFACT_BYTES: "8192",
        ASYNC_ARTIFACT_TTL_MS: "60000",
        ASYNC_JOB_TTL_MS: "60000",
      },
      async function (service) {
        var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/chunked");
        await service.runPendingJobsForOwner("owner-a", 1, {
          probeRunner: async function () {
            return {
              ok: true,
              statusCode: 200,
              message: "HTTP 200 chunked payload " + new Array(5000).join("x"),
            };
          },
        });

        var loaded = await service.getJobForOwner("owner-a", submitted.job.id);
        assert.ok(loaded.job);
        assert.ok(loaded.job.artifact);
        assert.strictEqual(loaded.job.artifact.storage, "chunked");
        assert.ok(loaded.job.artifact.chunkCount >= 2);

        var chunkPrefix = loaded.job.artifact.chunkKeyPrefix;
        var memoryStore = global.__dezoomifyAsyncMemoryStore;
        var beforeKeys = Array.from(memoryStore.values.keys()).filter(function (key) {
          return String(key).indexOf(chunkPrefix) === 0;
        });
        assert.strictEqual(beforeKeys.length, loaded.job.artifact.chunkCount);

        var artifact = await service.getArtifactForOwner("owner-a", submitted.job.id);
        assert.strictEqual(artifact.ok, true);
        assert.ok(artifact.buffer.toString("utf8").indexOf(submitted.job.id) >= 0);

        var originalNow = Date.now;
        try {
          Date.now = function () {
            return originalNow() + 61000;
          };
          var expired = await service.getArtifactForOwner("owner-a", submitted.job.id);
          assert.strictEqual(expired.ok, false);
          assert.strictEqual(expired.statusCode, 410);
        } finally {
          Date.now = originalNow;
        }

        var afterKeys = Array.from(memoryStore.values.keys()).filter(function (key) {
          return String(key).indexOf(chunkPrefix) === 0;
        });
        assert.strictEqual(afterKeys.length, 0);
      }
    );
  }),

  test("listJobsForOwner supports filters and cursor pagination", async function () {
    await withService({}, async function (service) {
      var first = await service.submitJob("owner-a", "owner-a", "https://example.com/list-a");
      var second = await service.submitJob("owner-a", "owner-a", "https://example.com/list-b");

      await service.runPendingJobsForOwner("owner-a", 2, {
        probeRunner: async function (url) {
          if (String(url).indexOf("list-b") >= 0) {
            return { ok: false, statusCode: 503, message: "HTTP 503" };
          }
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });

      var errors = await service.listJobsForOwner("owner-a", { status: "error", limit: 10 });
      assert.strictEqual(errors.total, 1);
      assert.strictEqual(errors.jobs[0].status, "error");

      var pageOne = await service.listJobsForOwner("owner-a", { limit: 1 });
      assert.strictEqual(pageOne.jobs.length, 1);
      assert.ok(pageOne.nextCursor);

      var pageTwo = await service.listJobsForOwner("owner-a", {
        limit: 1,
        cursor: pageOne.nextCursor,
      });
      assert.strictEqual(pageTwo.jobs.length, 1);

      var searched = await service.listJobsForOwner("owner-a", { query: first.job.id });
      assert.strictEqual(searched.total, 1);
      assert.strictEqual(searched.jobs[0].id, first.job.id);

      var secondSearch = await service.listJobsForOwner("owner-a", { query: second.job.id });
      assert.strictEqual(secondSearch.total, 1);
      assert.strictEqual(secondSearch.jobs[0].id, second.job.id);
    });
  }),

  test("retryJobForOwner creates a new job and supports processNow", async function () {
    await withService({}, async function (service) {
      var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/retry-a");
      await service.runPendingJobsForOwner("owner-a", 1, {
        probeRunner: async function () {
          return { ok: false, statusCode: 500, message: "HTTP 500" };
        },
      });

      var retried = await service.retryJobForOwner("owner-a", submitted.job.id, {
        processNow: true,
        probeRunner: async function () {
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });
      assert.ok(retried.job);
      assert.strictEqual(retried.reason, "retried_processed");
      assert.notStrictEqual(retried.job.id, submitted.job.id);
      assert.strictEqual(retried.job.status, "completed");

      var listed = await service.listJobsForOwner("owner-a", { limit: 10 });
      assert.strictEqual(listed.total, 2);
    });
  }),

  test("cancelJobForOwner cancels queued jobs only", async function () {
    await withService({}, async function (service) {
      var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/cancel-a");
      var canceled = await service.cancelJobForOwner("owner-a", submitted.job.id);
      assert.ok(canceled.job);
      assert.strictEqual(canceled.job.status, "canceled");

      var second = await service.submitJob("owner-a", "owner-a", "https://example.com/cancel-b");
      await service.runPendingJobsForOwner("owner-a", 1, {
        probeRunner: async function () {
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });
      var denied = await service.cancelJobForOwner("owner-a", second.job.id);
      assert.strictEqual(denied.statusCode, 409);
      assert.strictEqual(denied.reason, "not_cancelable");
    });
  }),

  test("cleanupExpiredJobs purges expired jobs after grace window", async function () {
    await withService(
      {
        ASYNC_JOB_TTL_MS: "60000",
        ASYNC_ARTIFACT_TTL_MS: "60000",
        ASYNC_CLEANUP_EXPIRED_GRACE_MS: "0",
      },
      async function (service) {
        var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/cleanup-a");
        await service.runPendingJobsForOwner("owner-a", 1, {
          probeRunner: async function () {
            return { ok: true, statusCode: 200, message: "HTTP 200" };
          },
        });

        var originalNow = Date.now;
        try {
          Date.now = function () {
            return originalNow() + 61000;
          };
          var cleanup = await service.cleanupExpiredJobs(20, Date.now());
          assert.ok(cleanup.jobsMarkedExpired >= 1);
          assert.ok(cleanup.jobsPurged >= 1);
        } finally {
          Date.now = originalNow;
        }

        var loaded = await service.getJobForOwner("owner-a", submitted.job.id);
        assert.strictEqual(loaded.job, null);
      }
    );
  }),

  test("cleanupExpiredJobs purges finished jobs by retention policy", async function () {
    await withService(
      {
        ASYNC_FINISHED_RETENTION_MS: "60000",
        ASYNC_JOB_TTL_MS: "600000",
        ASYNC_ARTIFACT_TTL_MS: "600000",
      },
      async function (service) {
        var submitted = await service.submitJob("owner-a", "owner-a", "https://example.com/retention-a");
        await service.runPendingJobsForOwner("owner-a", 1, {
          probeRunner: async function () {
            return { ok: true, statusCode: 200, message: "HTTP 200" };
          },
        });

        var originalNow = Date.now;
        try {
          Date.now = function () {
            return originalNow() + 61000;
          };
          var cleanup = await service.cleanupExpiredJobs(50, Date.now());
          assert.ok(cleanup.jobsFinishedPurged >= 1);
        } finally {
          Date.now = originalNow;
        }

        var loaded = await service.getJobForOwner("owner-a", submitted.job.id);
        assert.strictEqual(loaded.job, null);
      }
    );
  }),

  test("retryJobsForOwner and removeJobsForOwner support owner-scoped bulk operations", async function () {
    await withService({}, async function (service) {
      var first = await service.submitJob("owner-a", "owner-a", "https://example.com/bulk-a");
      var second = await service.submitJob("owner-a", "owner-a", "https://example.com/bulk-b");

      await service.runPendingJobsForOwner("owner-a", 2, {
        probeRunner: async function () {
          return { ok: false, statusCode: 500, message: "HTTP 500" };
        },
      });

      var retried = await service.retryJobsForOwner("owner-a", [first.job.id, "missing-job"], {
        processNow: true,
        probeRunner: async function () {
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      });
      assert.strictEqual(retried.requested, 2);
      assert.strictEqual(retried.successCount, 1);
      assert.strictEqual(retried.failedCount, 1);
      assert.ok(retried.results[0].sourceJobId);

      var newJobId = retried.results.filter(function (item) {
        return item && item.ok && item.job && item.job.id;
      })[0].job.id;
      assert.ok(newJobId);

      var removed = await service.removeJobsForOwner("owner-a", [second.job.id, newJobId, "missing-job"]);
      assert.strictEqual(removed.requested, 3);
      assert.strictEqual(removed.removed >= 2, true);
      assert.strictEqual(removed.notFound >= 1, true);

      var list = await service.listJobsForOwner("owner-a", { limit: 20 });
      var ids = list.jobs.map(function (job) { return job.id; });
      assert.strictEqual(ids.indexOf(second.job.id), -1);
      assert.strictEqual(ids.indexOf(newJobId), -1);
    });
  }),

  test("submitJob rejects invalid URL", async function () {
    await withService({}, async function (service) {
      var errored = false;
      try {
        await service.submitJob("owner-a", "owner-a", "javascript:alert(1)");
      } catch (error) {
        errored = true;
        assert.ok(/Only http\(s\) URLs are allowed/.test(error.message));
      }
      assert.strictEqual(errored, true);
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
