(function () {
  "use strict";

  function createLimitsPanelController(options) {
    var opts = options || {};
    var refs = {
      rateLimitSummary: document.getElementById("rate-limit-summary"),
      jobsStorageMode: document.getElementById("jobs-storage-mode"),
    };

    var lastRateLimitInfo = null;

    function updateRateLimitSummary() {
      if (!refs.rateLimitSummary) return;
      if (!lastRateLimitInfo) {
        refs.rateLimitSummary.textContent = "Waiting for first proxy request.";
        return;
      }
      var limit = lastRateLimitInfo.limit;
      var remaining = lastRateLimitInfo.remaining;
      var resetEpochSeconds = lastRateLimitInfo.resetEpochSeconds;
      var retryAfterSeconds = lastRateLimitInfo.retryAfterSeconds || 0;
      var resetIn = 0;
      if (isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
        resetIn = Math.max(Math.ceil(resetEpochSeconds - Date.now() / 1000), 0);
      }
      var ipText = (isFinite(remaining) && isFinite(limit))
        ? (remaining + "/" + limit + " edge requests left")
        : "edge rate-limit info unavailable";
      var text = ipText + (resetIn ? " • resets in " + resetIn + "s" : "");
      if (retryAfterSeconds > 0) {
        text += " • retry after " + retryAfterSeconds + "s";
      }

      if (
        isFinite(lastRateLimitInfo.quotaDailyLimit) &&
        isFinite(lastRateLimitInfo.quotaDailyUsed) &&
        isFinite(lastRateLimitInfo.quotaMinuteLimit) &&
        isFinite(lastRateLimitInfo.quotaMinuteUsed)
      ) {
        var minuteResetIn = 0;
        var dayResetIn = 0;
        if (isFinite(lastRateLimitInfo.quotaMinuteResetEpochSeconds)) {
          minuteResetIn = Math.max(Math.ceil(lastRateLimitInfo.quotaMinuteResetEpochSeconds - Date.now() / 1000), 0);
        }
        if (isFinite(lastRateLimitInfo.quotaDailyResetEpochSeconds)) {
          dayResetIn = Math.max(Math.ceil(lastRateLimitInfo.quotaDailyResetEpochSeconds - Date.now() / 1000), 0);
        }
        text += "\nquota minute: " + lastRateLimitInfo.quotaMinuteUsed + "/" + lastRateLimitInfo.quotaMinuteLimit;
        if (minuteResetIn) text += " (reset " + minuteResetIn + "s)";
        text += "\nquota day: " + lastRateLimitInfo.quotaDailyUsed + "/" + lastRateLimitInfo.quotaDailyLimit;
        if (dayResetIn) text += " (reset " + dayResetIn + "s)";
        if (lastRateLimitInfo.quotaIdentity) {
          text += "\nidentity: " + lastRateLimitInfo.quotaIdentity;
        }
        if (lastRateLimitInfo.quotaBackend) {
          text += " • backend: " + lastRateLimitInfo.quotaBackend;
        }
      }

      refs.rateLimitSummary.textContent = text;
    }

    function setRateLimitInfo(info) {
      lastRateLimitInfo = info || null;
      updateRateLimitSummary();
    }

    function setStorageState(state) {
      if (!refs.jobsStorageMode) return;
      var next = state && typeof state === "object" ? state : {};
      if (next.serverJobsEnabled) {
        var details = [];
        if (next.lastServerBackend) details.push(next.lastServerBackend);
        if (next.lastServerOwner) details.push(next.lastServerOwner);
        refs.jobsStorageMode.textContent = "Storage mode: server" + (details.length ? (" (" + details.join(" • ") + ")") : ".");
        return;
      }
      if (next.lastServerError) {
        refs.jobsStorageMode.textContent = "Storage mode: browser local (" + next.lastServerError + ")";
        return;
      }
      refs.jobsStorageMode.textContent = "Storage mode: browser local (offline fallback).";
    }

    function refresh() {
      updateRateLimitSummary();
    }

    function initialize() {
      updateRateLimitSummary();
      if (opts.initialStorageState) {
        setStorageState(opts.initialStorageState);
      }
      return true;
    }

    return {
      initialize: initialize,
      setRateLimitInfo: setRateLimitInfo,
      setStorageState: setStorageState,
      refresh: refresh,
    };
  }

  window.createLimitsPanelController = createLimitsPanelController;
})();
