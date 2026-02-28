(function () {
  "use strict";

  function callIfFunction(handler) {
    if (typeof handler !== "function") return undefined;
    return handler();
  }

  function createStartupSequencer(options) {
    var opts = options || {};
    var started = false;

    function start() {
      if (started) return true;
      started = true;

      callIfFunction(opts.initializeJobsRuntime);
      callIfFunction(opts.initializeServiceSyncRuntime);
      callIfFunction(opts.initializeOperationsRuntime);
      callIfFunction(opts.initializeBootstrapBridge);
      callIfFunction(opts.initializeJobsPanelsRuntime);
      callIfFunction(opts.installZoomManagerHooks);
      callIfFunction(opts.initializeStartURL);
      callIfFunction(opts.renderHistory);
      callIfFunction(opts.renderSchedules);
      callIfFunction(opts.updateRateLimitSummary);
      callIfFunction(opts.updateStorageModeSummary);
      callIfFunction(opts.startTimers);
      callIfFunction(opts.initializeServerStateSync);

      return true;
    }

    return {
      start: start,
    };
  }

  window.createStartupSequencer = createStartupSequencer;
})();
