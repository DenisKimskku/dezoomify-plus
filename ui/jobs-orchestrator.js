(function () {
  "use strict";

  var DEFAULT_HISTORY_STORAGE_KEY = "dezoomify:job-history:v1";
  var DEFAULT_SCHEDULE_STORAGE_KEY = "dezoomify:schedules:v1";
  var DEFAULT_MAX_HISTORY_ITEMS = 80;
  var DEFAULT_SCHEDULE_DEDUPE_WINDOW_MS = 60000;
  var RETENTION_STORAGE_KEY = "dezoomify:retention:v1";

  function parseIntOr(value, fallbackValue) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : fallbackValue;
  }

  function getRuntimeUtils() {
    return window.dezoomifyRuntimeUtils || {};
  }

  function getStorageUtils() {
    return window.dezoomifyStorageUtils || {};
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

  function loadLocalArray(storageKey, fallback) {
    var storage = getStorageUtils();
    if (typeof storage.readJSON === "function") {
      var loaded = storage.readJSON(storageKey, fallback);
      return Array.isArray(loaded) ? loaded : fallback;
    }
    try {
      var raw = localStorage.getItem(storageKey);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveLocalValue(storageKey, value) {
    var storage = getStorageUtils();
    if (typeof storage.writeJSON === "function") {
      storage.writeJSON(storageKey, value);
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (_) { }
  }

  function getHistoryRetentionMs() {
    var storage = getStorageUtils();
    var historyDays = 30;
    if (typeof storage.readJSON === "function") {
      var settings = storage.readJSON(RETENTION_STORAGE_KEY, { historyDays: 30 });
      historyDays = parseIntOr(settings && settings.historyDays, 30);
    } else {
      try {
        var raw = localStorage.getItem(RETENTION_STORAGE_KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        historyDays = parseIntOr(parsed && parsed.historyDays, 30);
      } catch (_) {
        historyDays = 30;
      }
    }
    historyDays = Math.max(historyDays, 1);
    return historyDays * 24 * 60 * 60 * 1000;
  }

  function createJobsOrchestrator(options) {
    var opts = options || {};
    var historyStorageKey = String(opts.historyStorageKey || DEFAULT_HISTORY_STORAGE_KEY);
    var scheduleStorageKey = String(opts.scheduleStorageKey || DEFAULT_SCHEDULE_STORAGE_KEY);
    var maxHistoryItems = parseIntOr(opts.maxHistoryItems, DEFAULT_MAX_HISTORY_ITEMS);
    var scheduleDedupeWindowMs = parseIntOr(opts.scheduleDedupeWindowMs, DEFAULT_SCHEDULE_DEDUPE_WINDOW_MS);
    if (!isFinite(maxHistoryItems) || maxHistoryItems <= 0) {
      maxHistoryItems = DEFAULT_MAX_HISTORY_ITEMS;
    }
    if (!isFinite(scheduleDedupeWindowMs) || scheduleDedupeWindowMs < 0) {
      scheduleDedupeWindowMs = DEFAULT_SCHEDULE_DEDUPE_WINDOW_MS;
    }

    var refs = {
      urlInput: opts.urlInput || null,
    };

    var history = loadLocalArray(historyStorageKey, []);
    var schedules = loadLocalArray(scheduleStorageKey, []);
    var activeJobId = null;

    function pruneHistoryByRetention() {
      var cutoffTs = Date.now() - getHistoryRetentionMs();
      history = history.filter(function (item) {
        if (!item || typeof item !== "object") return false;
        if (String(item.status || "").toLowerCase() === "running") return true;
        var ts = parseIntOr(item.startedAt, parseIntOr(item.updatedAt, 0));
        if (!isFinite(ts) || ts <= 0) return true;
        return ts >= cutoffTs;
      });
    }

    pruneHistoryByRetention();

    function notifyHistoryChange() {
      if (typeof opts.onHistoryChange === "function") {
        opts.onHistoryChange(history, activeJobId);
      }
    }

    function notifySchedulesChange() {
      if (typeof opts.onSchedulesChange === "function") {
        opts.onSchedulesChange(schedules);
      }
    }

    function queueSync(reason, options) {
      if (options && options.skipServer) return;
      if (typeof opts.onQueueServerSync === "function") {
        opts.onQueueServerSync(reason);
      }
    }

    function saveHistory(options) {
      pruneHistoryByRetention();
      saveLocalValue(historyStorageKey, history);
      queueSync("history", options);
    }

    function saveSchedules(options) {
      saveLocalValue(scheduleStorageKey, schedules);
      queueSync("schedules", options);
    }

    function getHistory() {
      return history;
    }

    function getSchedules() {
      return schedules;
    }

    function getLocalState() {
      return {
        history: history,
        schedules: schedules,
      };
    }

    function getActiveJob() {
      if (!activeJobId) return null;
      for (var i = 0; i < history.length; i++) {
        if (history[i].id === activeJobId) return history[i];
      }
      return null;
    }

    function hasActiveJob() {
      return !!getActiveJob();
    }

    function formatDate(ts) {
      var utils = getRuntimeUtils();
      if (typeof utils.formatDate === "function") {
        return utils.formatDate(ts);
      }
      return formatDateFallback(ts);
    }

    function formatDuration(ms) {
      var utils = getRuntimeUtils();
      if (typeof utils.formatDuration === "function") {
        return utils.formatDuration(ms);
      }
      return formatDurationFallback(ms);
    }

    function toLocalDateTimeInput(ts) {
      var utils = getRuntimeUtils();
      if (typeof utils.toLocalDateTimeInput === "function") {
        return utils.toLocalDateTimeInput(ts);
      }
      return toLocalDateTimeInputFallback(ts);
    }

    function parseDateInput(value) {
      var utils = getRuntimeUtils();
      if (typeof utils.parseDateInput === "function") {
        return utils.parseDateInput(value);
      }
      return parseDateInputFallback(value);
    }

    function setStatusMessage(message) {
      if (typeof opts.onStatusMessage === "function") {
        opts.onStatusMessage(String(message || ""));
      }
    }

    function setCurrentURL(url) {
      if (refs.urlInput) refs.urlInput.value = url;
      if (typeof opts.onSetCurrentURL === "function") {
        opts.onSetCurrentURL(url);
      } else {
        window.location.hash = url;
      }
    }

    function runJob(url, source, scheduleId) {
      url = (url || "").trim();
      if (!url) return false;

      if (getActiveJob()) {
        setStatusMessage("A job is already running. Please wait for completion.");
        return false;
      }

      var now = Date.now();
      var job = {
        id: "job-" + now + "-" + Math.random().toString(16).slice(2),
        url: url,
        source: source || "manual",
        scheduleId: scheduleId || null,
        status: "running",
        startedAt: now,
      };

      history.unshift(job);
      if (history.length > maxHistoryItems) {
        history = history.slice(0, maxHistoryItems);
      }
      activeJobId = job.id;
      saveHistory();
      notifyHistoryChange();

      setCurrentURL(url);
      try {
        if (typeof opts.onOpenJob === "function") {
          opts.onOpenJob(url);
        }
      } catch (error) {
        var message = error && error.message ? error.message : String(error);
        finalizeActiveJob("error", message);
        if (typeof opts.onRunError === "function") {
          opts.onRunError(message);
        }
        return false;
      }
      return true;
    }

    function finalizeActiveJob(status, message) {
      var activeJob = getActiveJob();
      if (!activeJob) return false;

      activeJob.status = status;
      activeJob.finishedAt = Date.now();
      activeJob.durationMs = activeJob.finishedAt - activeJob.startedAt;
      if (message) activeJob.message = String(message);

      if (activeJob.scheduleId) {
        for (var i = 0; i < schedules.length; i++) {
          if (schedules[i].id !== activeJob.scheduleId) continue;
          schedules[i].lastRunAt = Date.now();
          schedules[i].lastResult = status + (message ? (": " + message) : "");
          break;
        }
        saveSchedules();
        notifySchedulesChange();
      }

      activeJobId = null;
      saveHistory();
      notifyHistoryChange();
      return true;
    }

    function computeNextRun(schedule, fromTs) {
      if (typeof opts.computeNextRun === "function") {
        var computed = opts.computeNextRun(schedule, fromTs);
        if (computed === null || isFinite(computed)) return computed;
      }
      if (schedule && schedule.repeat === "hourly") return fromTs + 3600000;
      if (schedule && schedule.repeat === "daily") return fromTs + 86400000;
      return null;
    }

    function triggerSchedule(scheduleId, manual) {
      var schedule = null;
      for (var i = 0; i < schedules.length; i++) {
        if (schedules[i].id === scheduleId) {
          schedule = schedules[i];
          break;
        }
      }
      if (!schedule || schedule.status === "completed") return false;

      if (getActiveJob()) {
        schedule.lastResult = "deferred: another job is running";
        schedule.nextRunAt = Date.now() + 60000;
        saveSchedules();
        notifySchedulesChange();
        return false;
      }

      var now = Date.now();
      schedule.lastRunAt = now;
      schedule.lastResult = "running";

      if (!manual) {
        var nextRun = computeNextRun(schedule, schedule.nextRunAt || now);
        if (nextRun === null) {
          schedule.status = "completed";
          schedule.nextRunAt = null;
        } else {
          schedule.nextRunAt = nextRun;
        }
      }

      saveSchedules();
      notifySchedulesChange();

      var sourceLabel = manual ? "schedule-manual" : "schedule";
      return runJob(schedule.url, sourceLabel, schedule.id);
    }

    function tickSchedules() {
      var now = Date.now();
      for (var i = 0; i < schedules.length; i++) {
        var schedule = schedules[i];
        if (schedule.status !== "scheduled") continue;
        if (!isFinite(schedule.nextRunAt)) continue;
        if (schedule.nextRunAt <= now) {
          triggerSchedule(schedule.id, false);
          break;
        }
      }
    }

    function addSchedule(schedule) {
      if (!schedule || typeof schedule !== "object") {
        return {
          ok: false,
          reason: "invalid_schedule",
          message: "Invalid schedule payload.",
        };
      }
      var normalizedURL = "";
      try {
        normalizedURL = new URL(String(schedule.url || "").trim()).toString();
      } catch (_) {
        normalizedURL = String(schedule.url || "").trim();
      }
      var repeat = String(schedule.repeat || "none");
      var runAt = parseIntOr(schedule.nextRunAt, 0);
      for (var i = 0; i < schedules.length; i++) {
        var existing = schedules[i];
        if (!existing || String(existing.status || "").toLowerCase() === "completed") continue;
        var existingURL = "";
        try {
          existingURL = new URL(String(existing.url || "").trim()).toString();
        } catch (_) {
          existingURL = String(existing.url || "").trim();
        }
        if (existingURL !== normalizedURL) continue;
        if (String(existing.repeat || "none") !== repeat) continue;
        var existingRunAt = parseIntOr(existing.nextRunAt, 0);
        if (Math.abs(existingRunAt - runAt) > scheduleDedupeWindowMs) continue;
        return {
          ok: false,
          reason: "duplicate_schedule",
          message: "A similar schedule already exists.",
        };
      }
      schedules.unshift(schedule);
      saveSchedules();
      notifySchedulesChange();
      return { ok: true, schedule: schedule };
    }

    function toggleSchedule(scheduleId) {
      for (var i = 0; i < schedules.length; i++) {
        if (schedules[i].id !== scheduleId) continue;
        if (schedules[i].status === "paused") schedules[i].status = "scheduled";
        else schedules[i].status = "paused";
        saveSchedules();
        notifySchedulesChange();
        return true;
      }
      return false;
    }

    function deleteSchedule(scheduleId) {
      var beforeLength = schedules.length;
      schedules = schedules.filter(function (item) {
        return item.id !== scheduleId;
      });
      if (schedules.length === beforeLength) return false;
      saveSchedules();
      notifySchedulesChange();
      return true;
    }

    function clearHistory() {
      history = [];
      activeJobId = null;
      saveHistory();
      notifyHistoryChange();
      return true;
    }

    function rerunFromHistory(jobURL) {
      return runJob(jobURL, "history-rerun", null);
    }

    function applyServerState(serverState, preserveActiveJob) {
      if (!serverState || typeof serverState !== "object") return false;
      var changed = false;

      if (Array.isArray(serverState.schedules)) {
        schedules = serverState.schedules;
        saveSchedules({ skipServer: true });
        notifySchedulesChange();
        changed = true;
      }
      if (Array.isArray(serverState.history) && !preserveActiveJob) {
        history = serverState.history;
        activeJobId = null;
        saveHistory({ skipServer: true });
        notifyHistoryChange();
        changed = true;
      }

      return changed;
    }

    return {
      formatDate: formatDate,
      formatDuration: formatDuration,
      toLocalDateTimeInput: toLocalDateTimeInput,
      parseDateInput: parseDateInput,
      getHistory: getHistory,
      getSchedules: getSchedules,
      getLocalState: getLocalState,
      getActiveJob: getActiveJob,
      hasActiveJob: hasActiveJob,
      runJob: runJob,
      rerunFromHistory: rerunFromHistory,
      finalizeActiveJob: finalizeActiveJob,
      computeNextRun: computeNextRun,
      tickSchedules: tickSchedules,
      triggerSchedule: triggerSchedule,
      addSchedule: addSchedule,
      toggleSchedule: toggleSchedule,
      deleteSchedule: deleteSchedule,
      clearHistory: clearHistory,
      applyServerState: applyServerState,
    };
  }

  window.createJobsOrchestrator = createJobsOrchestrator;
})();
