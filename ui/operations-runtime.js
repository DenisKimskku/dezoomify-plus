(function () {
  "use strict";

  function getRuntimeUtils() {
    return window.dezoomifyRuntimeUtils || {};
  }

  function defaultStorageState() {
    var utils = getRuntimeUtils();
    if (typeof utils.createDefaultStorageState === "function") {
      return utils.createDefaultStorageState();
    }
    return {
      serverJobsEnabled: false,
      lastServerBackend: "",
      lastServerOwner: "",
      lastServerError: "",
    };
  }

  function createOperationsRuntime(options) {
    var opts = options || {};
    var limitsPanelController = null;
    var metricsPanelController = null;
    var asyncQueueController = null;
    var retentionController = null;
    var adminConsoleController = null;
    var initialized = false;

    function getInitialStorageState() {
      var utils = getRuntimeUtils();
      if (typeof opts.getInitialStorageState !== "function") {
        return defaultStorageState();
      }
      var state = opts.getInitialStorageState();
      if (typeof utils.normalizeStorageState === "function") {
        return utils.normalizeStorageState(state);
      }
      if (!state || typeof state !== "object") return defaultStorageState();
      return state;
    }

    function initializeLimitsPanel() {
      if (typeof window.createLimitsPanelController !== "function") return null;
      limitsPanelController = window.createLimitsPanelController({
        initialStorageState: getInitialStorageState(),
      });
      if (limitsPanelController && typeof limitsPanelController.initialize === "function") {
        limitsPanelController.initialize();
      }
      return limitsPanelController;
    }

    function initializeMetricsPanel() {
      if (typeof window.createMetricsPanelController !== "function") return null;
      metricsPanelController = window.createMetricsPanelController({
        searchParams: opts.searchParams,
        endpoint: opts.metricsEndpoint || "/api/metrics",
        personalEndpoint: opts.myMetricsEndpoint || "/api/my-metrics",
        serviceEndpoint: opts.metricsEndpoint || "/api/metrics",
        tokenStorageKey: opts.metricsTokenStorageKey,
        trendStorageKey: opts.metricsTrendStorageKey,
        maxTrendPoints: parseInt(opts.maxTrendPoints, 10) || 100,
        formatDate: opts.formatDate,
      });
      if (metricsPanelController && typeof metricsPanelController.initialize === "function") {
        metricsPanelController.initialize();
      }
      return metricsPanelController;
    }

    function initializeAsyncPanel() {
      if (typeof window.createAsyncQueueController !== "function") return null;
      asyncQueueController = window.createAsyncQueueController({
        searchParams: opts.searchParams,
        getStartingURL: opts.getStartingURL,
        getCurrentURL: opts.getCurrentURL,
        getAPIKey: opts.getCurrentAPIKey,
        formatDate: opts.formatDate,
        submitEndpoint: opts.asyncSubmitEndpoint || "/api/submit",
        statusEndpoint: opts.asyncStatusEndpoint || "/api/status",
        downloadEndpoint: opts.asyncDownloadEndpoint || "/api/download",
        listEndpoint: opts.asyncListEndpoint || "/api/list",
        retryEndpoint: opts.asyncRetryEndpoint || "/api/retry",
        retryBulkEndpoint: opts.asyncRetryBulkEndpoint || "/api/retry-bulk",
        removeBulkEndpoint: opts.asyncRemoveBulkEndpoint || "/api/remove-bulk",
        cancelEndpoint: opts.asyncCancelEndpoint || "/api/cancel",
        storageKey: opts.asyncStorageKey || "dezoomify:async-tracked-jobs:v1",
        maxItems: parseInt(opts.asyncMaxItems, 10) || 120,
      });
      if (asyncQueueController && typeof asyncQueueController.initialize === "function") {
        asyncQueueController.initialize();
      }
      return asyncQueueController;
    }

    function initializeRetentionControls() {
      if (typeof window.createRetentionControls !== "function") return null;
      retentionController = window.createRetentionControls({
        storageKey: opts.retentionStorageKey || "dezoomify:retention:v1",
      });
      if (retentionController && typeof retentionController.initialize === "function") {
        retentionController.initialize();
      }
      return retentionController;
    }

    function initializeAdminConsole() {
      if (typeof window.createAdminConsoleController !== "function") return null;
      adminConsoleController = window.createAdminConsoleController({
        endpoint: opts.adminEndpoint || "/api/admin",
      });
      if (adminConsoleController && typeof adminConsoleController.initialize === "function") {
        adminConsoleController.initialize();
      }
      return adminConsoleController;
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;
      initializeLimitsPanel();
      initializeMetricsPanel();
      initializeAsyncPanel();
      initializeRetentionControls();
      initializeAdminConsole();
      return true;
    }

    function updateRateLimitSummary() {
      if (!limitsPanelController || typeof limitsPanelController.refresh !== "function") return;
      limitsPanelController.refresh();
    }

    function setRateLimitInfo(info) {
      if (!limitsPanelController || typeof limitsPanelController.setRateLimitInfo !== "function") return;
      limitsPanelController.setRateLimitInfo(info);
    }

    function setStorageState(storageState) {
      if (!limitsPanelController || typeof limitsPanelController.setStorageState !== "function") return;
      if (!storageState || typeof storageState !== "object") {
        limitsPanelController.setStorageState(defaultStorageState());
        return;
      }
      limitsPanelController.setStorageState(storageState);
    }

    async function fetchMetricsSnapshot(force) {
      if (!metricsPanelController || typeof metricsPanelController.refresh !== "function") {
        return false;
      }
      return metricsPanelController.refresh(!!force);
    }

    async function refreshAsyncJobs(force) {
      if (!asyncQueueController || typeof asyncQueueController.refresh !== "function") {
        return false;
      }
      return asyncQueueController.refresh(!!force);
    }

    function getAsyncActivitySummary() {
      if (!asyncQueueController || typeof asyncQueueController.getActivitySummary !== "function") {
        return { total: 0, pending: 0, retryBlockedUntilMs: 0 };
      }
      return asyncQueueController.getActivitySummary();
    }

    async function refreshAdminSnapshot(force) {
      if (!adminConsoleController || typeof adminConsoleController.refresh !== "function") {
        return false;
      }
      return adminConsoleController.refresh(!!force);
    }

    return {
      initialize: initialize,
      updateRateLimitSummary: updateRateLimitSummary,
      setRateLimitInfo: setRateLimitInfo,
      setStorageState: setStorageState,
      fetchMetricsSnapshot: fetchMetricsSnapshot,
      refreshAsyncJobs: refreshAsyncJobs,
      getAsyncActivitySummary: getAsyncActivitySummary,
      refreshAdminSnapshot: refreshAdminSnapshot,
    };
  }

  window.createOperationsRuntime = createOperationsRuntime;
})();
