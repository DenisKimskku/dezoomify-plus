"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var playwright = require("playwright-core");

function parseArgs(argv) {
  var out = {
    baseURL: process.env.TARGET_URL || "https://dezoomify-plus.vercel.app",
    urlsFile: process.env.MATRIX_URLS_FILE || "test_urls.js",
    mode: process.env.MATRIX_MODE || "metadata",
    outputFile: process.env.MATRIX_OUTPUT || "live-matrix-results.json",
    timeoutMs: parseInt(process.env.MATRIX_TIMEOUT_MS, 10) || 30000,
    strict: /^(1|true|yes)$/i.test(process.env.MATRIX_STRICT || ""),
  };

  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === "--base-url" && argv[i + 1]) {
      out.baseURL = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--urls" && argv[i + 1]) {
      out.urlsFile = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--mode" && argv[i + 1]) {
      out.mode = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--output" && argv[i + 1]) {
      out.outputFile = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      out.timeoutMs = parseInt(argv[i + 1], 10) || out.timeoutMs;
      i += 1;
      continue;
    }
    if (arg === "--strict") {
      out.strict = true;
      continue;
    }
  }

  if (out.mode !== "full" && out.mode !== "metadata") {
    throw new Error("Invalid mode: " + out.mode + ". Expected full or metadata.");
  }
  return out;
}

function loadTestURLs(filePath) {
  var absolutePath = path.resolve(filePath);
  var source = fs.readFileSync(absolutePath, "utf8");
  var context = { test_urls: [] };
  vm.createContext(context);
  vm.runInContext(source + "\nthis.__urls = test_urls;", context, { filename: absolutePath });

  if (!Array.isArray(context.__urls)) {
    throw new Error("Expected test_urls array in " + absolutePath);
  }

  return context.__urls
    .map(function (entry, index) {
      if (typeof entry === "string") {
        return {
          id: index + 1,
          name: "case-" + (index + 1),
          url: entry,
          expectedDezoomer: "",
        };
      }
      if (!entry || typeof entry !== "object") return null;
      return {
        id: index + 1,
        name: String(entry.name || ("case-" + (index + 1))),
        url: String(entry.url || "").trim(),
        expectedDezoomer: String(entry.dezoomer || ""),
      };
    })
    .filter(function (entry) {
      return !!(entry && entry.url);
    });
}

function classifyFailure(status, detail) {
  var text = String(detail || "").toLowerCase();
  if (status === "timeout") return "timeout/slow-or-blocked";
  if (status === "exception") return "runner exception";
  if (text.indexOf("unable to fetch") >= 0) return "upstream fetch blocked/unavailable";
  if (text.indexOf("invalid xml") >= 0 || text.indexOf("invalid json") >= 0) {
    return "upstream format/response changed";
  }
  if (text.indexOf("unable to find a proper dezoomer") >= 0) {
    return "unsupported/changed site format";
  }
  if (text.indexOf("unable to load tile") >= 0) return "tile hotlink/cdn blocking";
  if (text.indexOf("typeerror") >= 0) return "parser/runtime bug candidate";
  if (text.indexOf("unable to load the meta-information file") >= 0) return "metadata discovery failed";
  return "other";
}

function initializeCountObject() {
  return {
    total: 0,
    success: 0,
    error: 0,
    timeout: 0,
    exception: 0,
  };
}

function incrementStatus(counts, status) {
  counts.total += 1;
  if (status === "success") counts.success += 1;
  else if (status === "error") counts.error += 1;
  else if (status === "timeout") counts.timeout += 1;
  else if (status === "exception") counts.exception += 1;
}

function buildSummary(results) {
  var totals = initializeCountObject();
  var buckets = {};
  var dezoomers = {};

  results.forEach(function (result) {
    incrementStatus(totals, result.status);
    var dezoomerName = result.dezoomer || "unknown";
    if (!dezoomers[dezoomerName]) {
      dezoomers[dezoomerName] = initializeCountObject();
    }
    incrementStatus(dezoomers[dezoomerName], result.status);

    if (result.status !== "success") {
      var bucket = classifyFailure(result.status, result.detail);
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    }
  });

  return {
    totals: totals,
    failureBuckets: buckets,
    byDezoomer: dezoomers,
  };
}

function toMarkdown(config, summary, results) {
  var lines = [];
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push("| Base URL | `" + config.baseURL + "` |");
  lines.push("| Mode | `" + config.mode + "` |");
  lines.push("| Total | " + summary.totals.total + " |");
  lines.push("| Success | " + summary.totals.success + " |");
  lines.push("| Error | " + summary.totals.error + " |");
  lines.push("| Timeout | " + summary.totals.timeout + " |");
  lines.push("| Exception | " + summary.totals.exception + " |");

  lines.push("");
  lines.push("#### Failure Buckets");
  lines.push("| Bucket | Count |");
  lines.push("| --- | ---: |");
  Object.keys(summary.failureBuckets)
    .sort(function (a, b) {
      return summary.failureBuckets[b] - summary.failureBuckets[a];
    })
    .forEach(function (bucket) {
      lines.push("| " + bucket + " | " + summary.failureBuckets[bucket] + " |");
    });

  lines.push("");
  lines.push("#### Per-Dezoomer");
  lines.push("| Dezoomer | Total | Success | Error | Timeout |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  Object.keys(summary.byDezoomer)
    .sort()
    .forEach(function (name) {
      var stat = summary.byDezoomer[name];
      lines.push(
        "| " +
          name +
          " | " +
          stat.total +
          " | " +
          stat.success +
          " | " +
          stat.error +
          " | " +
          stat.timeout +
          " |"
      );
    });

  lines.push("");
  lines.push("#### Failures");
  lines.push("| # | Name | Dezoomer | Status | Detail |");
  lines.push("| ---: | --- | --- | --- | --- |");
  results
    .filter(function (result) {
      return result.status !== "success";
    })
    .forEach(function (result) {
      var detail = String(result.detail || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
      if (detail.length > 220) detail = detail.slice(0, 220) + "...";
      lines.push(
        "| " +
          result.id +
          " | " +
          result.name +
          " | " +
          (result.dezoomer || "unknown") +
          " | `" +
          result.status +
          "` | " +
          detail +
          " |"
      );
    });

  return lines.join("\n") + "\n";
}

async function launchBrowser() {
  var firefoxBin = process.env.FIREFOX_BIN || process.env.BROWSER_BIN || "";
  if (firefoxBin) {
    return playwright.firefox.launch({
      headless: true,
      executablePath: firefoxBin,
    });
  }
  return playwright.firefox.launch({ headless: true });
}

async function runCase(page, config, entry) {
  var consoleMessages = [];
  var listener = function (msg) {
    if (msg.type() === "warning" || msg.type() === "error") {
      consoleMessages.push(msg.text());
    }
  };
  page.on("console", listener);

  var startedAt = Date.now();
  var result = {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    expectedDezoomer: entry.expectedDezoomer,
    dezoomer: "unknown",
    status: "exception",
    detail: "",
    durationMs: 0,
    logs: [],
  };

  try {
    await page.goto(config.baseURL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.fill("#url", entry.url);

    if (config.mode === "metadata") {
      await page.evaluate(function () {
        if (!window.ZoomManager) return;
        window.ZoomManager.ENABLE_WORKER_RENDERING = false;
        window.ZoomManager.addTile = function (_url, _x, _y, _ntries, onLoaded) {
          if (window.ZoomManager && window.ZoomManager.status) {
            window.ZoomManager.status.loaded = (window.ZoomManager.status.loaded || 0) + 1;
          }
          if (typeof onLoaded === "function") onLoaded();
        };
      });
    }

    await page.click("input[type=\"submit\"], button[type=\"submit\"]");

    var outcome = await page.evaluate(
      function (timeoutMs) {
        return new Promise(function (resolve) {
          var started = Date.now();

          function isErrorVisible() {
            var node = document.getElementById("error");
            return !!node && !node.hasAttribute("hidden");
          }

          function getErrorText() {
            var node = document.getElementById("errormsg");
            return node ? String(node.textContent || "").trim() : "";
          }

          function getProgressText() {
            var node = document.getElementById("percent");
            return node ? String(node.textContent || "").trim() : "";
          }

          function poll() {
            if (document.body && String(document.body.className || "").indexOf("download") >= 0) {
              resolve({ status: "success", detail: getProgressText() || "download_complete" });
              return;
            }
            if (isErrorVisible()) {
              resolve({ status: "error", detail: getErrorText() || "unknown_error" });
              return;
            }
            if (Date.now() - started >= timeoutMs) {
              resolve({ status: "timeout", detail: getProgressText() || "timeout_waiting_for_result" });
              return;
            }
            setTimeout(poll, 250);
          }

          poll();
        });
      },
      config.timeoutMs
    );

    result.status = outcome.status;
    result.detail = outcome.detail;
    result.dezoomer = await page.evaluate(function () {
      if (!window.ZoomManager || !window.ZoomManager.dezoomer) return "unknown";
      return String(window.ZoomManager.dezoomer.name || "unknown");
    });
  } catch (error) {
    result.status = "exception";
    result.detail = error && error.message ? error.message : String(error);
  } finally {
    page.off("console", listener);
  }

  result.durationMs = Date.now() - startedAt;
  result.logs = consoleMessages.slice(0, 8);
  return result;
}

async function main() {
  var config = parseArgs(process.argv);
  var urlsFile = path.resolve(__dirname, config.urlsFile);
  var outputFile = path.resolve(__dirname, config.outputFile);
  var outputMarkdownFile = outputFile.replace(/\.json$/i, ".md");
  var urls = loadTestURLs(urlsFile);

  var browser = await launchBrowser();
  var context = await browser.newContext();
  var page = await context.newPage();
  var results = [];

  for (var i = 0; i < urls.length; i += 1) {
    var entry = urls[i];
    var result = await runCase(page, config, entry);
    results.push(result);
  }

  await browser.close();

  var summary = buildSummary(results);
  var report = {
    config: config,
    summary: summary,
    results: results,
  };

  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(outputMarkdownFile, toMarkdown(config, summary, results));

  var totals = summary.totals;
  console.log(
    JSON.stringify(
      {
        outputFile: outputFile,
        outputMarkdownFile: outputMarkdownFile,
        total: totals.total,
        success: totals.success,
        error: totals.error,
        timeout: totals.timeout,
        exception: totals.exception,
      },
      null,
      2
    )
  );

  if (config.strict && (totals.error > 0 || totals.timeout > 0 || totals.exception > 0)) {
    process.exitCode = 1;
  }
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
