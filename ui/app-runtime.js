(function () {
  "use strict";

  function createAppRuntime(options) {
    var opts = options || {};

    var API_KEY_STORAGE_KEY = String(opts.apiKeyStorageKey || "dezoomify:api-key:v1");
    var METRICS_TOKEN_STORAGE_KEY = String(opts.metricsTokenStorageKey || "dezoomify:metrics-token:v1");
    var METRICS_TREND_STORAGE_KEY = String(opts.metricsTrendStorageKey || "dezoomify:metrics-trend:v1");
    var MAX_HISTORY_ITEMS = parseInt(opts.maxHistoryItems, 10) || 80;
    var SCHEDULER_INTERVAL_MS = parseInt(opts.schedulerIntervalMs, 10) || 15000;

    var SERVER_JOBS_ENDPOINT = String(opts.serverJobsEndpoint || "/api/jobs");
    var SERVER_METRICS_ENDPOINT = String(opts.serverMetricsEndpoint || "/api/metrics");
    var SERVER_ASYNC_SUBMIT_ENDPOINT = String(opts.serverAsyncSubmitEndpoint || "/api/submit");
    var SERVER_ASYNC_STATUS_ENDPOINT = String(opts.serverAsyncStatusEndpoint || "/api/status");
    var SERVER_ASYNC_DOWNLOAD_ENDPOINT = String(opts.serverAsyncDownloadEndpoint || "/api/download");
    var SERVER_ASYNC_LIST_ENDPOINT = String(opts.serverAsyncListEndpoint || "/api/list");
    var SERVER_ASYNC_HISTORY_ENDPOINT = String(opts.serverAsyncHistoryEndpoint || "/api/history");
    var SERVER_ASYNC_RETRY_ENDPOINT = String(opts.serverAsyncRetryEndpoint || "/api/retry");
    var SERVER_ASYNC_RETRY_BULK_ENDPOINT = String(opts.serverAsyncRetryBulkEndpoint || "/api/retry-bulk");
    var SERVER_ASYNC_REMOVE_BULK_ENDPOINT = String(opts.serverAsyncRemoveBulkEndpoint || "/api/remove-bulk");
    var SERVER_ASYNC_CANCEL_ENDPOINT = String(opts.serverAsyncCancelEndpoint || "/api/cancel");
    var SERVER_ADMIN_ENDPOINT = String(opts.serverAdminEndpoint || "/api/admin");
    var SERVER_SYNC_DEBOUNCE_MS = parseInt(opts.serverSyncDebounceMs, 10) || 800;
    var SERVER_POLL_INTERVAL_MS = parseInt(opts.serverPollIntervalMs, 10) || 45000;
    var SERVER_RETRY_COOLDOWN_MS = parseInt(opts.serverRetryCooldownMs, 10) || 60000;
    var METRICS_POLL_INTERVAL_MS = parseInt(opts.metricsPollIntervalMs, 10) || 30000;
    var ASYNC_POLL_INTERVAL_MS = parseInt(opts.asyncPollIntervalMs, 10) || 15000;

    var urlInput = opts.urlInput || document.getElementById("url");
    var form = opts.form || document.getElementById("urlform");
    var concurrencyInput = opts.concurrencyInput || document.getElementById("tile-concurrency");
    var concurrencyValue = opts.concurrencyValue || document.getElementById("tile-concurrency-value");
    var searchParams = opts.searchParams;
    if (!searchParams || typeof searchParams.get !== "function") {
      searchParams = new URLSearchParams(window.location.search);
    }

    var jobsRuntime = null;
    var jobsPanelsRuntime = null;
    var serviceSyncRuntime = null;
    var operationsRuntime = null;
    var bootstrapBridge = null;
    var authController = null;

    function getRuntimeUtils() {
      return window.dezoomifyRuntimeUtils || {};
    }

    function formatDateFallback(ts) {
      if (!ts) return "n/a";
      return new Date(ts).toLocaleString();
    }

    function formatDurationFallback(ms) {
      if (!isFinite(ms) || ms <= 0) return "0s";
      if (ms < 60000) return Math.round(ms / 1000) + "s";
      var minutes = Math.floor(ms / 60000);
      var seconds = Math.round((ms % 60000) / 1000);
      return minutes + "m " + seconds + "s";
    }

    function toLocalDateTimeInputFallback(ts) {
      var date = new Date(ts);
      var offsetMs = date.getTimezoneOffset() * 60000;
      return new Date(ts - offsetMs).toISOString().slice(0, 16);
    }

    function parseDateInputFallback(value) {
      var ts = Date.parse(value);
      return isFinite(ts) ? ts : null;
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

    function formatDate(ts) {
      if (jobsRuntime && typeof jobsRuntime.formatDate === "function") {
        return jobsRuntime.formatDate(ts);
      }
      var utils = getRuntimeUtils();
      if (typeof utils.formatDate === "function") {
        return utils.formatDate(ts);
      }
      return formatDateFallback(ts);
    }

    function formatDuration(ms) {
      if (jobsRuntime && typeof jobsRuntime.formatDuration === "function") {
        return jobsRuntime.formatDuration(ms);
      }
      var utils = getRuntimeUtils();
      if (typeof utils.formatDuration === "function") {
        return utils.formatDuration(ms);
      }
      return formatDurationFallback(ms);
    }

    function toLocalDateTimeInput(ts) {
      if (jobsRuntime && typeof jobsRuntime.toLocalDateTimeInput === "function") {
        return jobsRuntime.toLocalDateTimeInput(ts);
      }
      var utils = getRuntimeUtils();
      if (typeof utils.toLocalDateTimeInput === "function") {
        return utils.toLocalDateTimeInput(ts);
      }
      return toLocalDateTimeInputFallback(ts);
    }

    function parseDateInput(value) {
      if (jobsRuntime && typeof jobsRuntime.parseDateInput === "function") {
        return jobsRuntime.parseDateInput(value);
      }
      var utils = getRuntimeUtils();
      if (typeof utils.parseDateInput === "function") {
        return utils.parseDateInput(value);
      }
      return parseDateInputFallback(value);
    }

    function getCurrentAPIKey() {
      if (serviceSyncRuntime && typeof serviceSyncRuntime.getCurrentAPIKey === "function") {
        return String(serviceSyncRuntime.getCurrentAPIKey() || "").trim();
      }
      return ((ZoomManager && ZoomManager.api_key) ? ZoomManager.api_key : "").trim();
    }

    function isAdvancedAccessAllowed() {
      if (!authController) return true;
      if (typeof authController.isAuthEnforced !== "function") return true;
      if (!authController.isAuthEnforced()) return true;
      if (typeof authController.isAuthenticated !== "function") return false;
      return !!authController.isAuthenticated();
    }

    function getActiveJob() {
      if (!jobsRuntime || typeof jobsRuntime.getActiveJob !== "function") return null;
      return jobsRuntime.getActiveJob();
    }

    function runDezoomJob(url, source, scheduleId) {
      if (!jobsRuntime || typeof jobsRuntime.runJob !== "function") return false;
      return jobsRuntime.runJob(url, source, scheduleId);
    }

    function finalizeActiveJob(status, message) {
      if (!jobsRuntime || typeof jobsRuntime.finalizeActiveJob !== "function") return false;
      return jobsRuntime.finalizeActiveJob(status, message);
    }

    function triggerSchedule(scheduleId, manual) {
      if (!jobsRuntime || typeof jobsRuntime.triggerSchedule !== "function") return false;
      return jobsRuntime.triggerSchedule(scheduleId, manual);
    }

    function tickSchedules() {
      if (!jobsRuntime || typeof jobsRuntime.tickSchedules !== "function") return;
      jobsRuntime.tickSchedules();
    }

    function applyServerState(serverState, preserveActiveJob) {
      if (!jobsRuntime || typeof jobsRuntime.applyServerState !== "function") return;
      jobsRuntime.applyServerState(serverState, preserveActiveJob);
    }

    function queueServerSync(reason) {
      if (!serviceSyncRuntime || typeof serviceSyncRuntime.queueSync !== "function") return;
      serviceSyncRuntime.queueSync(reason);
    }

    async function fetchServerState(force, bootstrapFromLocal) {
      if (!serviceSyncRuntime || typeof serviceSyncRuntime.fetchState !== "function") {
        return { loaded: false, shouldBootstrap: false };
      }
      return serviceSyncRuntime.fetchState(!!force, !!bootstrapFromLocal);
    }

    async function initializeServerStateSync() {
      if (!serviceSyncRuntime || typeof serviceSyncRuntime.initializeServerSync !== "function") return;
      await serviceSyncRuntime.initializeServerSync();
    }

    function getStartingURL() {
      if (bootstrapBridge && typeof bootstrapBridge.getStartingURL === "function") {
        return bootstrapBridge.getStartingURL();
      }
      return searchParams.get("url") || window.location.hash.slice(1);
    }

    function updateRateLimitSummary() {
      if (!operationsRuntime || typeof operationsRuntime.updateRateLimitSummary !== "function") return;
      operationsRuntime.updateRateLimitSummary();
    }

    function setRateLimitInfo(info) {
      if (!operationsRuntime || typeof operationsRuntime.setRateLimitInfo !== "function") return;
      operationsRuntime.setRateLimitInfo(info);
    }

    function updateStorageModeSummary() {
      if (!operationsRuntime || typeof operationsRuntime.setStorageState !== "function") return;
      if (serviceSyncRuntime && typeof serviceSyncRuntime.getStorageState === "function") {
        operationsRuntime.setStorageState(serviceSyncRuntime.getStorageState());
        return;
      }
      operationsRuntime.setStorageState(defaultStorageState());
    }

    async function fetchMetricsSnapshot(force) {
      if (!isAdvancedAccessAllowed()) return false;
      if (!operationsRuntime || typeof operationsRuntime.fetchMetricsSnapshot !== "function") {
        return false;
      }
      return operationsRuntime.fetchMetricsSnapshot(!!force);
    }

    async function refreshAsyncJobs(force) {
      if (!isAdvancedAccessAllowed()) return false;
      if (!operationsRuntime || typeof operationsRuntime.refreshAsyncJobs !== "function") {
        return false;
      }
      return operationsRuntime.refreshAsyncJobs(!!force);
    }

    function isAdminAuthenticated() {
      if (!authController || typeof authController.getUser !== "function") return false;
      var user = authController.getUser();
      return !!(user && user.role === "admin");
    }

    async function refreshAdminSnapshot(force) {
      if (!isAdvancedAccessAllowed()) return false;
      if (!isAdminAuthenticated()) return false;
      if (!operationsRuntime || typeof operationsRuntime.refreshAdminSnapshot !== "function") {
        return false;
      }
      return operationsRuntime.refreshAdminSnapshot(!!force);
    }

    function getAsyncActivitySummary() {
      if (!operationsRuntime || typeof operationsRuntime.getAsyncActivitySummary !== "function") {
        return { total: 0, pending: 0, retryBlockedUntilMs: 0 };
      }
      return operationsRuntime.getAsyncActivitySummary();
    }

    function getAsyncPollIntervalMs() {
      if (!isAdvancedAccessAllowed()) return 120000;
      var summary = getAsyncActivitySummary();
      if ((summary && parseInt(summary.pending, 10) > 0) || getActiveJob()) return 5000;
      return 20000;
    }

    function getMetricsPollIntervalMs() {
      if (!isAdvancedAccessAllowed()) return 120000;
      var summary = getAsyncActivitySummary();
      if ((summary && parseInt(summary.pending, 10) > 0) || getActiveJob()) return 15000;
      return 45000;
    }

    function getServerPollIntervalMs() {
      if (!isAdvancedAccessAllowed()) return 120000;
      var hasSchedules = false;
      if (jobsRuntime && typeof jobsRuntime.getSchedules === "function") {
        var schedules = jobsRuntime.getSchedules();
        hasSchedules = Array.isArray(schedules) && schedules.length > 0;
      }
      if (getActiveJob() || hasSchedules) return 30000;
      return 90000;
    }

    function renderHistory() {
      if (!jobsPanelsRuntime || typeof jobsPanelsRuntime.renderHistory !== "function") return;
      if (!jobsRuntime || typeof jobsRuntime.getHistory !== "function") {
        jobsPanelsRuntime.renderHistory([]);
        return;
      }
      jobsPanelsRuntime.renderHistory(jobsRuntime.getHistory());
    }

    function renderSchedules() {
      if (!jobsPanelsRuntime || typeof jobsPanelsRuntime.renderSchedules !== "function") return;
      if (!jobsRuntime || typeof jobsRuntime.getSchedules !== "function") {
        jobsPanelsRuntime.renderSchedules([]);
        return;
      }
      jobsPanelsRuntime.renderSchedules(jobsRuntime.getSchedules());
    }

    function initializeJobsRuntime() {
      if (typeof window.createJobsOrchestrator !== "function") return;
      jobsRuntime = window.createJobsOrchestrator({
        historyStorageKey: "dezoomify:job-history:v1",
        scheduleStorageKey: "dezoomify:schedules:v1",
        maxHistoryItems: MAX_HISTORY_ITEMS,
        urlInput: urlInput,
        onQueueServerSync: queueServerSync,
        onStatusMessage: function (message) {
          var percent = document.getElementById("percent");
          if (percent) percent.textContent = String(message || "");
        },
        onSetCurrentURL: function (jobURL) {
          window.location.hash = jobURL;
        },
        onOpenJob: function (jobURL) {
          ZoomManager.open(jobURL);
        },
        onRunError: function (message) {
          if (typeof UI !== "undefined" && UI && typeof UI.error === "function") {
            UI.error(message);
          }
        },
        computeNextRun: function (schedule, fromTs) {
          if (jobsPanelsRuntime && typeof jobsPanelsRuntime.computeNextRun === "function") {
            return jobsPanelsRuntime.computeNextRun(schedule, fromTs);
          }
          if (schedule && schedule.repeat === "hourly") return fromTs + 3600000;
          if (schedule && schedule.repeat === "daily") return fromTs + 86400000;
          return null;
        },
        onHistoryChange: renderHistory,
        onSchedulesChange: renderSchedules,
      });
    }

    function initializeJobsPanelsRuntime() {
      if (typeof window.createJobsPanelsRuntime !== "function") return;
      jobsPanelsRuntime = window.createJobsPanelsRuntime({
        formatDate: formatDate,
        formatDuration: formatDuration,
        toLocalDateTimeInput: toLocalDateTimeInput,
        parseDateInput: parseDateInput,
        historyEndpoint: SERVER_ASYNC_HISTORY_ENDPOINT,
        getCurrentAPIKey: getCurrentAPIKey,
        getCurrentURL: function () {
          return (urlInput && urlInput.value) ? urlInput.value : "";
        },
        onRunAgain: function (jobURL) {
          if (!jobsRuntime || typeof jobsRuntime.rerunFromHistory !== "function") return;
          jobsRuntime.rerunFromHistory(jobURL);
        },
        onClearHistory: function () {
          if (!jobsRuntime || typeof jobsRuntime.clearHistory !== "function") return;
          jobsRuntime.clearHistory();
        },
        onCreateSchedule: function (schedule) {
          if (!jobsRuntime || typeof jobsRuntime.addSchedule !== "function") return;
          var result = jobsRuntime.addSchedule(schedule);
          if (result && result.ok === false && result.message) {
            var percent = document.getElementById("percent");
            if (percent) percent.textContent = result.message;
          }
        },
        onRunNowSchedule: function (scheduleId) {
          triggerSchedule(scheduleId, true);
        },
        onToggleSchedule: function (scheduleId) {
          if (!jobsRuntime || typeof jobsRuntime.toggleSchedule !== "function") return;
          jobsRuntime.toggleSchedule(scheduleId);
        },
        onDeleteSchedule: function (scheduleId) {
          if (!jobsRuntime || typeof jobsRuntime.deleteSchedule !== "function") return;
          jobsRuntime.deleteSchedule(scheduleId);
        },
      });
      jobsPanelsRuntime.initialize();
    }

    function initializeAuthRuntime() {
      if (typeof window.createAuthController !== "function") return;
      authController = window.createAuthController({
        sessionEndpoint: "/api/auth/session",
        loginEndpoint: "/api/auth/login",
        registerEndpoint: "/api/auth/register",
        logoutEndpoint: "/api/auth/logout",
        keyEndpoint: "/api/auth/key",
        rotateEndpoint: "/api/auth/key/rotate",
        storageHealthEndpoint: "/api/storage-health",
        onChange: function () {
          if (serviceSyncRuntime && typeof serviceSyncRuntime.reloadForIdentity === "function") {
            serviceSyncRuntime.reloadForIdentity();
          }
          if (isAdvancedAccessAllowed()) {
            refreshAsyncJobs(true);
            fetchMetricsSnapshot(true);
            refreshAdminSnapshot(true);
            fetchServerState(true, false);
          }
        },
      });
      authController.initialize();
    }

    function initializeServiceSyncRuntime() {
      if (typeof window.createServiceSyncRuntime !== "function") {
        ZoomManager.api_key = "";
        return;
      }
      serviceSyncRuntime = window.createServiceSyncRuntime({
        searchParams: searchParams,
        apiKeyStorageKey: API_KEY_STORAGE_KEY,
        jobsEndpoint: SERVER_JOBS_ENDPOINT,
        syncDebounceMs: SERVER_SYNC_DEBOUNCE_MS,
        retryCooldownMs: SERVER_RETRY_COOLDOWN_MS,
        applyAPIKey: function (apiKey) {
          ZoomManager.api_key = (apiKey || "").trim();
        },
        getLocalState: function () {
          if (!jobsRuntime || typeof jobsRuntime.getLocalState !== "function") {
            return { schedules: [], history: [] };
          }
          return jobsRuntime.getLocalState();
        },
        hasActiveJob: function () {
          return !!getActiveJob();
        },
        applyServerState: applyServerState,
        onIdentityChanged: function () {
          return refreshAsyncJobs(true);
        },
        onStorageStateChange: updateStorageModeSummary,
      });
      serviceSyncRuntime.initialize();
    }

    function initializeOperationsRuntime() {
      if (typeof window.createOperationsRuntime !== "function") return;
      operationsRuntime = window.createOperationsRuntime({
        searchParams: searchParams,
        metricsEndpoint: SERVER_METRICS_ENDPOINT,
        metricsTokenStorageKey: METRICS_TOKEN_STORAGE_KEY,
        metricsTrendStorageKey: METRICS_TREND_STORAGE_KEY,
        maxTrendPoints: 100,
        getInitialStorageState: function () {
          if (serviceSyncRuntime && typeof serviceSyncRuntime.getStorageState === "function") {
            return serviceSyncRuntime.getStorageState();
          }
          return defaultStorageState();
        },
        getStartingURL: getStartingURL,
        getCurrentURL: function () {
          return urlInput ? String(urlInput.value || "") : "";
        },
        getCurrentAPIKey: getCurrentAPIKey,
        formatDate: formatDate,
        asyncSubmitEndpoint: SERVER_ASYNC_SUBMIT_ENDPOINT,
        asyncStatusEndpoint: SERVER_ASYNC_STATUS_ENDPOINT,
        asyncDownloadEndpoint: SERVER_ASYNC_DOWNLOAD_ENDPOINT,
        asyncListEndpoint: SERVER_ASYNC_LIST_ENDPOINT,
        asyncRetryEndpoint: SERVER_ASYNC_RETRY_ENDPOINT,
        asyncRetryBulkEndpoint: SERVER_ASYNC_RETRY_BULK_ENDPOINT,
        asyncRemoveBulkEndpoint: SERVER_ASYNC_REMOVE_BULK_ENDPOINT,
        asyncCancelEndpoint: SERVER_ASYNC_CANCEL_ENDPOINT,
        asyncStorageKey: "dezoomify:async-tracked-jobs:v1",
        asyncMaxItems: 120,
        adminEndpoint: SERVER_ADMIN_ENDPOINT,
      });
      operationsRuntime.initialize();
    }

    function initializeBootstrapBridge() {
      if (typeof window.createBootstrapBridge !== "function") return;
      bootstrapBridge = window.createBootstrapBridge({
        searchParams: searchParams,
        urlInput: urlInput,
        form: form,
        concurrencyInput: concurrencyInput,
        concurrencyValue: concurrencyValue,
        tileStorageKey: "dezoomify:tileConcurrency",
        schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
        serverPollIntervalMs: SERVER_POLL_INTERVAL_MS,
        metricsPollIntervalMs: METRICS_POLL_INTERVAL_MS,
        asyncPollIntervalMs: ASYNC_POLL_INTERVAL_MS,
        rateLimitIntervalMs: 1000,
        getConcurrencyLimits: function () {
          return {
            defaultValue: ZoomManager.DEFAULT_TILE_CONCURRENCY || 12,
            minValue: ZoomManager.MIN_TILE_CONCURRENCY || 2,
            maxValue: ZoomManager.MAX_TILE_CONCURRENCY || 20,
          };
        },
        onSetConcurrency: function (value) {
          ZoomManager.PREFERRED_TILE_CONCURRENCY = value;
        },
        onSubmitURL: function (jobURL, source) {
          runDezoomJob(jobURL, source || "manual", null);
        },
        onStartURLDetected: function (startURL) {
          if (jobsPanelsRuntime && typeof jobsPanelsRuntime.prefillScheduleURL === "function") {
            jobsPanelsRuntime.prefillScheduleURL(startURL);
          }
        },
        onAutoStartURL: function (startURL) {
          runDezoomJob(startURL, "autostart", null);
        },
        onTickSchedules: tickSchedules,
        onRateLimitTick: updateRateLimitSummary,
        onPollServer: function () {
          if (!isAdvancedAccessAllowed()) return;
          if (getActiveJob()) return;
          return fetchServerState(false, false);
        },
        getServerPollIntervalMs: function () {
          return getServerPollIntervalMs();
        },
        onPollMetrics: function () {
          if (!isAdvancedAccessAllowed()) return;
          return fetchMetricsSnapshot(false);
        },
        getMetricsPollIntervalMs: function () {
          return getMetricsPollIntervalMs();
        },
        onPollAsync: function () {
          if (!isAdvancedAccessAllowed()) return;
          return refreshAsyncJobs(false);
        },
        getAsyncPollIntervalMs: function () {
          return getAsyncPollIntervalMs();
        },
      });
      bootstrapBridge.initialize();
    }

    function installZoomManagerHooks() {
      var originalLoadEnd = ZoomManager.loadEnd;
      ZoomManager.loadEnd = function () {
        finalizeActiveJob("success", "");
        return originalLoadEnd.apply(this, arguments);
      };

      var originalError = ZoomManager.error;
      ZoomManager.error = function (errmsg) {
        finalizeActiveJob("error", errmsg);
        return originalError.apply(this, arguments);
      };

      ZoomManager.onRateLimitInfo = function (info) {
        setRateLimitInfo(info);
      };
      if (ZoomManager.lastRateLimitInfo) {
        setRateLimitInfo(ZoomManager.lastRateLimitInfo);
      }
    }

    function startApplicationFallback() {
      initializeAuthRuntime();
      initializeJobsRuntime();
      initializeServiceSyncRuntime();
      initializeOperationsRuntime();
      initializeBootstrapBridge();
      initializeJobsPanelsRuntime();
      installZoomManagerHooks();
      if (bootstrapBridge && typeof bootstrapBridge.initializeStartURL === "function") {
        bootstrapBridge.initializeStartURL();
      }
      renderHistory();
      renderSchedules();
      updateRateLimitSummary();
      updateStorageModeSummary();
      if (bootstrapBridge && typeof bootstrapBridge.startTimers === "function") {
        bootstrapBridge.startTimers();
      }
      initializeServerStateSync();
    }

    function startApplication() {
      if (typeof window.createStartupSequencer !== "function") {
        startApplicationFallback();
        return true;
      }
      var startupSequencer = window.createStartupSequencer({
        initializeAuthRuntime: initializeAuthRuntime,
        initializeJobsRuntime: initializeJobsRuntime,
        initializeServiceSyncRuntime: initializeServiceSyncRuntime,
        initializeOperationsRuntime: initializeOperationsRuntime,
        initializeBootstrapBridge: initializeBootstrapBridge,
        initializeJobsPanelsRuntime: initializeJobsPanelsRuntime,
        installZoomManagerHooks: installZoomManagerHooks,
        initializeStartURL: function () {
          if (bootstrapBridge && typeof bootstrapBridge.initializeStartURL === "function") {
            bootstrapBridge.initializeStartURL();
          }
        },
        renderHistory: renderHistory,
        renderSchedules: renderSchedules,
        updateRateLimitSummary: updateRateLimitSummary,
        updateStorageModeSummary: updateStorageModeSummary,
        startTimers: function () {
          if (bootstrapBridge && typeof bootstrapBridge.startTimers === "function") {
            bootstrapBridge.startTimers();
          }
        },
        initializeServerStateSync: initializeServerStateSync,
      });
      startupSequencer.start();
      return true;
    }

    return {
      start: startApplication,
    };
  }

  window.createAppRuntime = createAppRuntime;
})();
