"use strict";

var assert = require("assert");

function test(name, fn) {
  return { name: name, fn: fn };
}

function fakeReq() {
  return {
    method: "GET",
    headers: {},
    socket: { remoteAddress: "203.0.113.200" },
  };
}

function loadObservability() {
  var previous = process.env.OBSERVABILITY_ENABLED;
  process.env.OBSERVABILITY_ENABLED = "false";
  var path = require.resolve("../lib/observability");
  delete require.cache[path];
  var mod = require(path);
  if (typeof previous === "undefined") delete process.env.OBSERVABILITY_ENABLED;
  else process.env.OBSERVABILITY_ENABLED = previous;
  return { mod: mod, path: path };
}

var tests = [
  test("alerts on elevated 5xx ratio", function () {
    var loaded = loadObservability();
    var observability = loaded.mod;
    try {
      observability.resetMetricsStoreForTests();
      for (var i = 0; i < 60; i += 1) {
        var finish = observability.createRequestObserver("proxy", fakeReq());
        if (i < 14) {
          finish(502, { reason: "upstream_fetch_failed" });
        } else {
          finish(200, { reason: "ok" });
        }
      }
      var snapshot = observability.getMetricsSnapshot();
      assert.ok(snapshot.rollups.requests >= 60);
      var hasAlert = (snapshot.alerts || []).some(function (item) {
        return item && item.id === "five_xx_ratio";
      });
      assert.strictEqual(hasAlert, true);
    } finally {
      delete require.cache[loaded.path];
      observability.resetMetricsStoreForTests();
    }
  }),

  test("alerts on quota spikes", function () {
    var loaded = loadObservability();
    var observability = loaded.mod;
    try {
      observability.resetMetricsStoreForTests();
      for (var i = 0; i < 28; i += 1) {
        var finish = observability.createRequestObserver("proxy", fakeReq());
        finish(429, { reason: "quota_exceeded", quotaType: "minute" });
      }
      var snapshot = observability.getMetricsSnapshot();
      assert.ok(snapshot.rollups.quotaLimited >= 28);
      var hasAlert = (snapshot.alerts || []).some(function (item) {
        return item && item.id === "quota_spike";
      });
      assert.strictEqual(hasAlert, true);
    } finally {
      delete require.cache[loaded.path];
      observability.resetMetricsStoreForTests();
    }
  }),

  test("includes recentBuckets with counter snapshots", function () {
    var loaded = loadObservability();
    var observability = loaded.mod;
    try {
      observability.resetMetricsStoreForTests();
      var finish = observability.createRequestObserver("metrics", fakeReq());
      finish(200, { reason: "snapshot" });
      var snapshot = observability.getMetricsSnapshot();
      assert.ok(Array.isArray(snapshot.recentBuckets));
      assert.ok(snapshot.recentBuckets.length >= 1);
      assert.ok(snapshot.recentBuckets[0].counters);
    } finally {
      delete require.cache[loaded.path];
      observability.resetMetricsStoreForTests();
    }
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
