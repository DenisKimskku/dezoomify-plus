"use strict";

var assert = require("assert");

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

async function run() {
  var listThresholdMs = parseInt(process.env.BENCH_ASYNC_MAX_LIST_MS || "280", 10);
  var statusThresholdMs = parseInt(process.env.BENCH_ASYNC_MAX_STATUS_MS || "420", 10);

  await withService({}, async function (service) {
    var owner = "bench-owner";
    for (var i = 0; i < 220; i += 1) {
      await service.submitJob(owner, owner, "https://example.com/bench/" + i);
    }

    var listedStart = Date.now();
    var listed = await service.listJobsForOwner(owner, { limit: 120, cursor: 0 });
    var listDurationMs = Date.now() - listedStart;
    assert.ok(Array.isArray(listed.jobs));

    var ids = listed.jobs.slice(0, 80).map(function (job) { return job.id; });
    var statusStart = Date.now();
    for (var j = 0; j < ids.length; j += 1) {
      var loaded = await service.getJobForOwner(owner, ids[j]);
      assert.ok(loaded.job);
    }
    var statusDurationMs = Date.now() - statusStart;

    if (listDurationMs > listThresholdMs) {
      throw new Error("listJobsForOwner benchmark exceeded threshold: " + listDurationMs + "ms > " + listThresholdMs + "ms");
    }
    if (statusDurationMs > statusThresholdMs) {
      throw new Error("getJobForOwner benchmark exceeded threshold: " + statusDurationMs + "ms > " + statusThresholdMs + "ms");
    }

    console.log(JSON.stringify({
      ok: true,
      listDurationMs: listDurationMs,
      listThresholdMs: listThresholdMs,
      statusDurationMs: statusDurationMs,
      statusThresholdMs: statusThresholdMs,
      sampleSize: ids.length,
    }));
  });
}

run().catch(function (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
