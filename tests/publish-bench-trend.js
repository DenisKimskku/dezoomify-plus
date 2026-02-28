"use strict";

var fs = require("fs");

function readJSON(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  var endpoint = String(process.env.BENCHMARK_TREND_ENDPOINT || "").trim();
  if (!endpoint) {
    console.log("Skipping benchmark trend publish: BENCHMARK_TREND_ENDPOINT is not set.");
    return;
  }

  var inputPath = process.argv[2] || process.env.BENCH_OUTPUT_FILE || "";
  if (!inputPath) {
    throw new Error("Missing benchmark input file path.");
  }

  var report = readJSON(inputPath);
  var suite = String(process.env.BENCHMARK_SUITE || "jobs-state").trim() || "jobs-state";
  var token = String(process.env.BENCHMARK_WRITE_TOKEN || "").trim();

  var payload = {
    suite: suite,
    report: report,
    metadata: {
      source: process.env.BENCHMARK_SOURCE || "github-actions",
      runId: process.env.GITHUB_RUN_ID || "",
      runNumber: process.env.GITHUB_RUN_NUMBER || "",
      sha: process.env.GITHUB_SHA || "",
      ref: process.env.GITHUB_REF || "",
      workflow: process.env.GITHUB_WORKFLOW || "",
      nodeVersion: process.version,
      ciRecordedAt: new Date().toISOString(),
    },
  };

  var response = await fetch(endpoint, {
    method: "POST",
    headers: Object.assign(
      {
        "Content-Type": "application/json",
      },
      token ? { Authorization: "Bearer " + token } : {}
    ),
    body: JSON.stringify(payload),
  });
  var bodyText = await response.text();
  if (!response.ok) {
    throw new Error("Benchmark trend publish failed (" + response.status + "): " + bodyText);
  }

  console.log("Benchmark trend published:", endpoint);
  if (bodyText) console.log(bodyText);
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
