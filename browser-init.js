(function () {
  var appRuntime = null;
  if (typeof window.createAppRuntime !== "function") return;
  var searchParams = new URLSearchParams(window.location.search || "");
  var appRuntimeDisabled =
    searchParams.get("app_runtime") === "0" ||
    searchParams.get("runtime") === "0";
  if (appRuntimeDisabled) return;

  appRuntime = window.createAppRuntime({
    apiKeyStorageKey: "dezoomify:api-key:v1",
    metricsTokenStorageKey: "dezoomify:metrics-token:v1",
    metricsTrendStorageKey: "dezoomify:metrics-trend:v1",
    maxHistoryItems: 80,
    schedulerIntervalMs: 15000,
    serverJobsEndpoint: "/api/jobs",
    serverMetricsEndpoint: "/api/metrics",
    serverMyMetricsEndpoint: "/api/my-metrics",
    serverAsyncSubmitEndpoint: "/api/submit",
    serverAsyncStatusEndpoint: "/api/status",
    serverAsyncDownloadEndpoint: "/api/download",
    serverAsyncListEndpoint: "/api/list",
    serverAsyncHistoryEndpoint: "/api/history",
    serverAsyncRetryEndpoint: "/api/retry",
    serverAsyncRetryBulkEndpoint: "/api/retry-bulk",
    serverAsyncRemoveBulkEndpoint: "/api/remove-bulk",
    serverAsyncCancelEndpoint: "/api/cancel",
    serverAdminEndpoint: "/api/admin",
    serverSyncDebounceMs: 800,
    serverPollIntervalMs: 45000,
    serverRetryCooldownMs: 60000,
    metricsPollIntervalMs: 30000,
    asyncPollIntervalMs: 15000,
    urlInput: document.getElementById("url"),
    form: document.getElementById("urlform"),
    concurrencyInput: document.getElementById("tile-concurrency"),
    concurrencyValue: document.getElementById("tile-concurrency-value"),
    searchParams: searchParams,
  });

  if (appRuntime && typeof appRuntime.start === "function") {
    appRuntime.start();
  }
})();
