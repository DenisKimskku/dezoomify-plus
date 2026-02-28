(function () {
  "use strict";

  var DEFAULT_API_KEY_STORAGE_KEY = "dezoomify:api-key:v1";
  var DEFAULT_JOBS_ENDPOINT = "/api/jobs";
  var DEFAULT_SYNC_DEBOUNCE_MS = 800;
  var DEFAULT_RETRY_COOLDOWN_MS = 60000;

  function maybePromise(value) {
    return value && typeof value.then === "function";
  }

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

  function createServiceSyncRuntime(options) {
    var opts = options || {};
    var apiKeyStorageKey = String(opts.apiKeyStorageKey || DEFAULT_API_KEY_STORAGE_KEY);
    var jobsEndpoint = String(opts.jobsEndpoint || DEFAULT_JOBS_ENDPOINT);
    var syncDebounceMs = Math.max(parseInt(opts.syncDebounceMs, 10) || DEFAULT_SYNC_DEBOUNCE_MS, 0);
    var retryCooldownMs = Math.max(parseInt(opts.retryCooldownMs, 10) || DEFAULT_RETRY_COOLDOWN_MS, 0);

    var currentAPIKey = "";
    var jobsSyncController = null;
    var apiKeyControls = null;
    var initialized = false;

    function applyAPIKey(apiKey) {
      currentAPIKey = String(apiKey || "").trim();
      if (typeof opts.applyAPIKey === "function") {
        opts.applyAPIKey(currentAPIKey);
      }
    }

    function getCurrentAPIKey() {
      return currentAPIKey;
    }

    function getLocalState() {
      if (typeof opts.getLocalState !== "function") {
        return { schedules: [], history: [] };
      }
      var state = opts.getLocalState();
      if (!state || typeof state !== "object") {
        return { schedules: [], history: [] };
      }
      return {
        schedules: Array.isArray(state.schedules) ? state.schedules : [],
        history: Array.isArray(state.history) ? state.history : [],
      };
    }

    function hasActiveJob() {
      if (typeof opts.hasActiveJob !== "function") return false;
      return !!opts.hasActiveJob();
    }

    function applyServerState(serverState, preserveActiveJob) {
      if (typeof opts.applyServerState !== "function") return;
      opts.applyServerState(serverState, preserveActiveJob);
    }

    function getStorageState() {
      if (!jobsSyncController || typeof jobsSyncController.getStorageState !== "function") {
        return defaultStorageState();
      }
      return jobsSyncController.getStorageState();
    }

    function emitStorageStateChange() {
      if (typeof opts.onStorageStateChange !== "function") return;
      opts.onStorageStateChange(getStorageState());
    }

    async function onIdentityChanged() {
      if (jobsSyncController && typeof jobsSyncController.reloadForIdentity === "function") {
        await jobsSyncController.reloadForIdentity();
      }
      if (typeof opts.onIdentityChanged === "function") {
        var result = opts.onIdentityChanged();
        if (maybePromise(result)) {
          await result.catch(function () { });
        }
      }
      emitStorageStateChange();
    }

    function initializeAPIKeyControls() {
      if (typeof window.createAPIKeyControls !== "function") {
        applyAPIKey("");
        return null;
      }
      apiKeyControls = window.createAPIKeyControls({
        searchParams: opts.searchParams,
        storageKey: apiKeyStorageKey,
        applyAPIKey: applyAPIKey,
        onIdentityChanged: onIdentityChanged,
      });
      if (apiKeyControls && typeof apiKeyControls.initialize === "function") {
        apiKeyControls.initialize();
      }
      return apiKeyControls;
    }

    function initializeJobsSyncController() {
      if (typeof window.createJobsSyncController !== "function") {
        emitStorageStateChange();
        return null;
      }
      jobsSyncController = window.createJobsSyncController({
        endpoint: jobsEndpoint,
        syncDebounceMs: syncDebounceMs,
        retryCooldownMs: retryCooldownMs,
        getAPIKey: getCurrentAPIKey,
        getLocalState: getLocalState,
        hasActiveJob: hasActiveJob,
        applyServerState: applyServerState,
        onStorageStateChange: emitStorageStateChange,
      });
      emitStorageStateChange();
      return jobsSyncController;
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;
      initializeAPIKeyControls();
      initializeJobsSyncController();
      return true;
    }

    async function initializeServerSync() {
      if (!jobsSyncController || typeof jobsSyncController.initialize !== "function") return;
      return jobsSyncController.initialize();
    }

    function queueSync(reason) {
      if (!jobsSyncController || typeof jobsSyncController.queueSync !== "function") return;
      jobsSyncController.queueSync(reason);
    }

    async function pushState(reason) {
      if (!jobsSyncController || typeof jobsSyncController.pushState !== "function") {
        return false;
      }
      return jobsSyncController.pushState(reason);
    }

    async function fetchState(force, bootstrapFromLocal) {
      if (!jobsSyncController || typeof jobsSyncController.fetchState !== "function") {
        return { loaded: false, shouldBootstrap: false };
      }
      return jobsSyncController.fetchState(!!force, !!bootstrapFromLocal);
    }

    async function reloadForIdentity() {
      return onIdentityChanged();
    }

    function dispose() {
      if (jobsSyncController && typeof jobsSyncController.dispose === "function") {
        jobsSyncController.dispose();
      }
    }

    return {
      initialize: initialize,
      initializeServerSync: initializeServerSync,
      queueSync: queueSync,
      pushState: pushState,
      fetchState: fetchState,
      reloadForIdentity: reloadForIdentity,
      getCurrentAPIKey: getCurrentAPIKey,
      getStorageState: getStorageState,
      dispose: dispose,
    };
  }

  window.createServiceSyncRuntime = createServiceSyncRuntime;
})();
