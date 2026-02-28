"use strict";

var assert = require("assert");
var jobsService = require("../lib/jobs-service");

function test(name, fn) {
  return { name: name, fn: fn };
}

var tests = [
  test("applyStatePatch sanitizes invalid schedule URLs", function () {
    var state = jobsService.applyStatePatch(
      { schedules: [], history: [] },
      {
        schedules: [
          {
            id: "ok-1",
            url: "https://example.com/a",
            repeat: "daily",
            status: "scheduled",
            nextRunAt: 1000,
          },
          {
            id: "bad-1",
            url: "javascript:alert(1)",
          },
          {
            id: "bad-2",
            url: "ftp://example.com/file",
          },
        ],
        history: [
          {
            id: "h1",
            url: "https://example.com/b",
            status: "success",
            startedAt: 2000,
          },
        ],
      }
    );

    assert.strictEqual(state.schedules.length, 1);
    assert.strictEqual(state.schedules[0].id, "ok-1");
    assert.strictEqual(state.history.length, 1);
    assert.strictEqual(state.history[0].status, "success");
  }),

  test("applyStatePatch supports clearHistory", function () {
    var next = jobsService.applyStatePatch(
      {
        schedules: [{ id: "s1", url: "https://example.com", repeat: "none", status: "scheduled" }],
        history: [{ id: "h1", url: "https://example.com", status: "error", startedAt: Date.now() }],
      },
      { clearHistory: true }
    );
    assert.strictEqual(next.history.length, 0);
    assert.strictEqual(next.schedules.length, 1);
  }),

  test("runDueSchedulesForState marks one-time schedules completed", async function () {
    var now = 1700000000000;
    var state = {
      schedules: [
        {
          id: "s1",
          url: "https://example.com/job",
          repeat: "none",
          status: "scheduled",
          nextRunAt: now - 1000,
          createdAt: now - 5000,
          lastResult: "pending",
        },
      ],
      history: [],
    };

    var result = await jobsService.runDueSchedulesForState(state, 10, now, {
      probeRunner: async function () {
        return { ok: true, statusCode: 200, message: "HTTP 200" };
      },
    });

    assert.strictEqual(result.jobsRun, 1);
    assert.strictEqual(result.successCount, 1);
    assert.strictEqual(result.errorCount, 0);
    assert.strictEqual(result.state.schedules[0].status, "completed");
    assert.strictEqual(result.state.schedules[0].nextRunAt, null);
    assert.strictEqual(result.state.history.length, 1);
    assert.strictEqual(result.state.history[0].status, "success");
  }),

  test("runDueSchedulesForState advances repeat schedules to the future", async function () {
    var now = 1700000000000;
    var state = {
      schedules: [
        {
          id: "s-hourly",
          url: "https://example.com/hourly",
          repeat: "hourly",
          status: "scheduled",
          nextRunAt: now - 3 * 3600000,
          createdAt: now - 5000,
          lastResult: "pending",
        },
      ],
      history: [],
    };

    var result = await jobsService.runDueSchedulesForState(state, 10, now, {
      probeRunner: async function () {
        return { ok: true, statusCode: 200, message: "HTTP 200" };
      },
    });

    assert.strictEqual(result.jobsRun, 1);
    assert.strictEqual(result.state.schedules[0].status, "scheduled");
    assert.ok(result.state.schedules[0].nextRunAt > now);
    assert.ok(result.state.schedules[0].nextRunAt <= now + 3600000);
  }),

  test("runDueSchedulesForState respects maxJobs", async function () {
    var now = 1700000000000;
    var schedules = [];
    for (var i = 0; i < 5; i += 1) {
      schedules.push({
        id: "s-" + i,
        url: "https://example.com/" + i,
        repeat: "none",
        status: "scheduled",
        nextRunAt: now - 1000 - i,
        createdAt: now - 10000,
        lastResult: "pending",
      });
    }

    var result = await jobsService.runDueSchedulesForState(
      { schedules: schedules, history: [] },
      2,
      now,
      {
        probeRunner: async function () {
          return { ok: true, statusCode: 200, message: "HTTP 200" };
        },
      }
    );

    assert.strictEqual(result.jobsRun, 2);
    assert.strictEqual(result.state.history.length, 2);
  }),

  test("runDueSchedulesForState captures probe failures", async function () {
    var now = 1700000000000;
    var state = {
      schedules: [
        {
          id: "s-err",
          url: "https://example.com/error",
          repeat: "none",
          status: "scheduled",
          nextRunAt: now - 10,
          createdAt: now - 5000,
          lastResult: "pending",
        },
      ],
      history: [],
    };

    var result = await jobsService.runDueSchedulesForState(state, 1, now, {
      probeRunner: async function () {
        throw new Error("boom");
      },
    });

    assert.strictEqual(result.jobsRun, 1);
    assert.strictEqual(result.errorCount, 1);
    assert.strictEqual(result.state.history[0].status, "error");
    assert.ok(/boom/.test(result.state.history[0].message));
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
