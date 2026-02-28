(function () {
  "use strict";

  var DEFAULT_ENDPOINT = "/api/jobs";
  var DEFAULT_SYNC_DEBOUNCE_MS = 800;
  var DEFAULT_RETRY_COOLDOWN_MS = 60000;

  function parseJSONSafe(response) {
    return response.json().catch(function () {
      return null;
    });
  }

  function getHttpClient() {
    return window.dezoomifyHttpClient || {};
  }

  function isStateEmpty(state) {
    if (!state || typeof state !== "object") return true;
    var hasSchedules = Array.isArray(state.schedules) && state.schedules.length > 0;
    var hasHistory = Array.isArray(state.history) && state.history.length > 0;
    return !hasSchedules && !hasHistory;
  }

  function createJobsSyncController(options) {
    var opts = options || {};
    var endpoint = String(opts.endpoint || DEFAULT_ENDPOINT);
    var syncDebounceMs = Math.max(parseInt(opts.syncDebounceMs, 10) || DEFAULT_SYNC_DEBOUNCE_MS, 0);
    var retryCooldownMs = Math.max(parseInt(opts.retryCooldownMs, 10) || DEFAULT_RETRY_COOLDOWN_MS, 0);

    var serverJobsEnabled = false;
    var serverSyncBusy = false;
    var serverSyncTimer = null;
    var nextServerProbeAt = 0;
    var lastServerError = "";
    var lastServerBackend = "";
    var lastServerOwner = "";

    function getAPIKey() {
      if (typeof opts.getAPIKey !== "function") return "";
      return String(opts.getAPIKey() || "").trim();
    }

    function getEndpointURL() {
      var apiKey = getAPIKey();
      if (!apiKey) return endpoint;
      return endpoint + "?api_key=" + encodeURIComponent(apiKey);
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

    function getStorageState() {
      return {
        serverJobsEnabled: serverJobsEnabled,
        lastServerBackend: lastServerBackend,
        lastServerOwner: lastServerOwner,
        lastServerError: lastServerError,
      };
    }

    function emitStorageStateChange() {
      if (typeof opts.onStorageStateChange !== "function") return;
      opts.onStorageStateChange(getStorageState());
    }

    function markServerUnavailable(message) {
      serverJobsEnabled = false;
      if (message) lastServerError = message;
      nextServerProbeAt = Date.now() + retryCooldownMs;
      emitStorageStateChange();
    }

    function applyServerState(serverState, preserveActiveJob) {
      if (typeof opts.applyServerState !== "function") return;
      opts.applyServerState(serverState, preserveActiveJob);
    }

    async function pushState(reason) {
      if (!window.fetch || !serverJobsEnabled || serverSyncBusy) return false;

      var localState = getLocalState();
      serverSyncBusy = true;
      try {
        var http = getHttpClient();
        var result;
        if (typeof http.requestJSON === "function") {
          result = await http.requestJSON(getEndpointURL(), {
            method: "PUT",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              reason: reason || "sync",
              schedules: localState.schedules,
              history: localState.history
            })
          });
        } else {
          var response = await fetch(getEndpointURL(), {
            method: "PUT",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              reason: reason || "sync",
              schedules: localState.schedules,
              history: localState.history
            })
          });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: await parseJSONSafe(response),
            category: response.status === 401 ? "unauthorized" : (response.status === 404 || response.status === 405 ? "unavailable" : ""),
            retryAfterSeconds: 0,
          };
        }

        if (!result.ok) {
          if (result.category === "unavailable" || result.category === "not_found") {
            markServerUnavailable("jobs API unavailable");
            return false;
          }
          if (result.category === "unauthorized") {
            markServerUnavailable("API key required for server jobs");
            return false;
          }
          if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
            markServerUnavailable("jobs sync rate-limited (" + result.retryAfterSeconds + "s)");
            return false;
          }
          throw new Error("sync failed (" + result.status + ")");
        }

        var payload = result.payload;
        if (payload && payload.state) {
          if (!hasActiveJob()) {
            applyServerState(payload.state, false);
          }
          lastServerBackend = payload.backend || lastServerBackend;
          lastServerOwner = payload.owner || lastServerOwner;
        }
        lastServerError = "";
        emitStorageStateChange();
        return true;
      } catch (error) {
        lastServerError = error && error.message ? error.message : String(error);
        emitStorageStateChange();
        return false;
      } finally {
        serverSyncBusy = false;
      }
    }

    function queueSync(reason) {
      if (!serverJobsEnabled || serverSyncTimer) return;
      serverSyncTimer = setTimeout(function () {
        serverSyncTimer = null;
        pushState(reason || "state-change");
      }, syncDebounceMs);
    }

    async function fetchState(force, bootstrapFromLocal) {
      if (!window.fetch || serverSyncBusy) return { loaded: false, shouldBootstrap: false };
      if (!force && !serverJobsEnabled && Date.now() < nextServerProbeAt) {
        return { loaded: false, shouldBootstrap: false };
      }

      serverSyncBusy = true;
      try {
        var http = getHttpClient();
        var result;
        if (typeof http.getJSON === "function") {
          result = await http.getJSON(getEndpointURL(), {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
          });
        } else {
          var response = await fetch(getEndpointURL(), {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
          });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: await parseJSONSafe(response),
            category: response.status === 401 ? "unauthorized" : (response.status === 404 || response.status === 405 ? "unavailable" : ""),
            retryAfterSeconds: 0,
          };
        }

        if (!result.ok) {
          if (result.category === "unavailable" || result.category === "not_found") {
            markServerUnavailable("jobs API unavailable");
            return { loaded: false, shouldBootstrap: false };
          }
          if (result.category === "unauthorized") {
            markServerUnavailable("API key required for server jobs");
            return { loaded: false, shouldBootstrap: false };
          }
          if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
            markServerUnavailable("jobs API rate-limited (" + result.retryAfterSeconds + "s)");
            return { loaded: false, shouldBootstrap: false };
          }
          markServerUnavailable("jobs API error (" + result.status + ")");
          return { loaded: false, shouldBootstrap: false };
        }

        var payload = result.payload;
        if (!payload || !payload.state) {
          markServerUnavailable("invalid jobs response");
          return { loaded: false, shouldBootstrap: false };
        }

        serverJobsEnabled = true;
        lastServerBackend = payload.backend || "";
        lastServerOwner = payload.owner || "";
        lastServerError = "";
        nextServerProbeAt = 0;
        emitStorageStateChange();

        var localState = getLocalState();
        var hasLocalState =
          (Array.isArray(localState.history) && localState.history.length > 0) ||
          (Array.isArray(localState.schedules) && localState.schedules.length > 0);
        var shouldBootstrap = !!bootstrapFromLocal && isStateEmpty(payload.state) && hasLocalState;
        if (!shouldBootstrap) {
          applyServerState(payload.state, hasActiveJob());
        }
        return { loaded: true, shouldBootstrap: shouldBootstrap };
      } catch (error) {
        markServerUnavailable(error && error.message ? error.message : String(error));
        return { loaded: false, shouldBootstrap: false };
      } finally {
        serverSyncBusy = false;
      }
    }

    async function initialize() {
      var loaded = await fetchState(true, true);
      if (loaded.loaded && loaded.shouldBootstrap && serverJobsEnabled) {
        await pushState("bootstrap-local-state");
      }
      return loaded;
    }

    async function reloadForIdentity() {
      serverJobsEnabled = false;
      nextServerProbeAt = 0;
      lastServerError = "";
      lastServerOwner = "";
      lastServerBackend = "";
      emitStorageStateChange();
      return fetchState(true, false);
    }

    function dispose() {
      if (!serverSyncTimer) return;
      clearTimeout(serverSyncTimer);
      serverSyncTimer = null;
    }

    return {
      initialize: initialize,
      fetchState: fetchState,
      pushState: pushState,
      queueSync: queueSync,
      reloadForIdentity: reloadForIdentity,
      getStorageState: getStorageState,
      dispose: dispose,
    };
  }

  window.createJobsSyncController = createJobsSyncController;
})();
