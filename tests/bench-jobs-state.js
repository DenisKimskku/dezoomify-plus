"use strict";

var fs = require("fs");
var jobsService = require("../lib/jobs-service");

function parseIntArg(value, fallback) {
  var parsed = parseInt(value, 10);
  return isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFloatEnv(name) {
  var raw = process.env[name];
  if (typeof raw === "undefined" || raw === null || raw === "") return null;
  var parsed = parseFloat(raw);
  if (!isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

async function main() {
  var count = parseIntArg(process.argv[2], 500);
  var maxJobs = parseIntArg(process.argv[3], count);
  var now = Date.now();
  var schedules = [];
  var i;
  for (i = 0; i < count; i += 1) {
    schedules.push({
      id: "bench-" + i,
      url: "https://example.com/" + i,
      repeat: "hourly",
      status: "scheduled",
      nextRunAt: now - 1000 - i,
      createdAt: now - 60000,
      lastResult: "pending",
    });
  }

  var start = process.hrtime();
  var result = await jobsService.runDueSchedulesForState(
    { schedules: schedules, history: [] },
    maxJobs,
    now,
    {
      probeRunner: async function () {
        return { ok: true, statusCode: 200, message: "HTTP 200" };
      },
    }
  );
  var elapsed = process.hrtime(start);
  var durationMs = elapsed[0] * 1000 + elapsed[1] / 1e6;

  var report = {
    count: count,
    maxJobs: maxJobs,
    effectiveSchedules: result.state.schedules.length,
    jobsRun: result.jobsRun,
    success: result.successCount,
    error: result.errorCount,
    durationMs: Number(durationMs.toFixed(3)),
    perJobMs: result.jobsRun ? Number((durationMs / result.jobsRun).toFixed(5)) : null,
  };
  if (count > result.state.schedules.length) {
    report.note =
      "Input schedules were capped by JOBS_MAX_SCHEDULES (" + result.state.schedules.length + ").";
  }

  var outputFile = process.env.BENCH_OUTPUT_FILE || "";
  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));

  var maxPerJobMs = parseFloatEnv("BENCH_MAX_PER_JOB_MS");
  if (maxPerJobMs !== null && report.perJobMs !== null && report.perJobMs > maxPerJobMs) {
    throw new Error(
      "perJobMs regression: " + report.perJobMs + "ms > " + maxPerJobMs + "ms threshold"
    );
  }

  var maxDurationMs = parseFloatEnv("BENCH_MAX_DURATION_MS");
  if (maxDurationMs !== null && report.durationMs > maxDurationMs) {
    throw new Error(
      "durationMs regression: " + report.durationMs + "ms > " + maxDurationMs + "ms threshold"
    );
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
