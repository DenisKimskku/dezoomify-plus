(function () {
  "use strict";

  function createJobsPanelsRuntime(options) {
    var opts = options || {};
    var historyPanelController = null;
    var schedulePanelController = null;
    var initialized = false;

    function initializeHistoryPanel() {
      if (typeof window.createHistoryPanelController !== "function") return null;
      historyPanelController = window.createHistoryPanelController({
        formatDate: opts.formatDate,
        formatDuration: opts.formatDuration,
        endpoint: opts.historyEndpoint || "/api/history",
        getAPIKey: opts.getCurrentAPIKey,
        onRunAgain: opts.onRunAgain,
        onClear: opts.onClearHistory,
      });
      if (historyPanelController && typeof historyPanelController.initialize === "function") {
        historyPanelController.initialize();
      }
      return historyPanelController;
    }

    function initializeSchedulePanel() {
      if (typeof window.createSchedulePanelController !== "function") return null;
      schedulePanelController = window.createSchedulePanelController({
        formatDate: opts.formatDate,
        toLocalDateTimeInput: opts.toLocalDateTimeInput,
        parseDateInput: opts.parseDateInput,
        getCurrentURL: opts.getCurrentURL,
        onCreate: opts.onCreateSchedule,
        onRunNow: opts.onRunNowSchedule,
        onToggle: opts.onToggleSchedule,
        onDelete: opts.onDeleteSchedule,
      });
      if (schedulePanelController && typeof schedulePanelController.initialize === "function") {
        schedulePanelController.initialize();
      }
      return schedulePanelController;
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;
      initializeHistoryPanel();
      initializeSchedulePanel();
      return true;
    }

    function renderHistory(history) {
      if (!historyPanelController || typeof historyPanelController.render !== "function") return;
      historyPanelController.render(Array.isArray(history) ? history : []);
    }

    function refreshHistory(force) {
      if (!historyPanelController || typeof historyPanelController.refresh !== "function") return false;
      return historyPanelController.refresh(!!force);
    }

    function renderSchedules(schedules) {
      if (!schedulePanelController || typeof schedulePanelController.render !== "function") return;
      schedulePanelController.render(Array.isArray(schedules) ? schedules : []);
    }

    function prefillScheduleURL(url) {
      if (!schedulePanelController || typeof schedulePanelController.prefillURL !== "function") return;
      schedulePanelController.prefillURL(url);
    }

    function computeNextRun(schedule, fromTs) {
      if (schedulePanelController && typeof schedulePanelController.computeNextRun === "function") {
        return schedulePanelController.computeNextRun(schedule, fromTs);
      }
      if (schedule && schedule.repeat === "hourly") return fromTs + 3600000;
      if (schedule && schedule.repeat === "daily") return fromTs + 86400000;
      return null;
    }

    return {
      initialize: initialize,
      renderHistory: renderHistory,
      refreshHistory: refreshHistory,
      renderSchedules: renderSchedules,
      prefillScheduleURL: prefillScheduleURL,
      computeNextRun: computeNextRun,
    };
  }

  window.createJobsPanelsRuntime = createJobsPanelsRuntime;
})();
