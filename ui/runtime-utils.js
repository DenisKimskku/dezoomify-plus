(function () {
  "use strict";

  function createDefaultStorageState() {
    return {
      serverJobsEnabled: false,
      lastServerBackend: "",
      lastServerOwner: "",
      lastServerError: "",
    };
  }

  function normalizeStorageState(state) {
    if (!state || typeof state !== "object") {
      return createDefaultStorageState();
    }
    return {
      serverJobsEnabled: !!state.serverJobsEnabled,
      lastServerBackend: String(state.lastServerBackend || ""),
      lastServerOwner: String(state.lastServerOwner || ""),
      lastServerError: String(state.lastServerError || ""),
    };
  }

  function formatDate(ts) {
    if (!ts) return "n/a";
    return new Date(ts).toLocaleString();
  }

  function formatDuration(ms) {
    if (!isFinite(ms) || ms <= 0) return "0s";
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    var minutes = Math.floor(ms / 60000);
    var seconds = Math.round((ms % 60000) / 1000);
    return minutes + "m " + seconds + "s";
  }

  function toLocalDateTimeInput(ts) {
    var date = new Date(ts);
    var offsetMs = date.getTimezoneOffset() * 60000;
    return new Date(ts - offsetMs).toISOString().slice(0, 16);
  }

  function parseDateInput(value) {
    var ts = Date.parse(value);
    return isFinite(ts) ? ts : null;
  }

  window.dezoomifyRuntimeUtils = {
    createDefaultStorageState: createDefaultStorageState,
    normalizeStorageState: normalizeStorageState,
    formatDate: formatDate,
    formatDuration: formatDuration,
    toLocalDateTimeInput: toLocalDateTimeInput,
    parseDateInput: parseDateInput,
  };
})();
