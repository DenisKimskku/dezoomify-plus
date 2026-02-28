(function () {
  "use strict";

  function createBootstrapBridge(options) {
    var opts = options || {};
    var runtime = null;
    var initialized = false;

    function defaultStartingURL() {
      var searchParams = opts.searchParams;
      if (!searchParams || typeof searchParams.get !== "function") {
        return window.location.hash.slice(1);
      }
      return searchParams.get("url") || window.location.hash.slice(1);
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;
      if (typeof window.createBootstrapRuntime !== "function") {
        return false;
      }
      runtime = window.createBootstrapRuntime({
        searchParams: opts.searchParams,
        urlInput: opts.urlInput,
        form: opts.form,
        concurrencyInput: opts.concurrencyInput,
        concurrencyValue: opts.concurrencyValue,
        tileStorageKey: opts.tileStorageKey,
        schedulerIntervalMs: opts.schedulerIntervalMs,
        serverPollIntervalMs: opts.serverPollIntervalMs,
        metricsPollIntervalMs: opts.metricsPollIntervalMs,
        asyncPollIntervalMs: opts.asyncPollIntervalMs,
        rateLimitIntervalMs: opts.rateLimitIntervalMs,
        getConcurrencyLimits: opts.getConcurrencyLimits,
        onSetConcurrency: opts.onSetConcurrency,
        onSubmitURL: opts.onSubmitURL,
        onStartURLDetected: opts.onStartURLDetected,
        onAutoStartURL: opts.onAutoStartURL,
        onTickSchedules: opts.onTickSchedules,
        onRateLimitTick: opts.onRateLimitTick,
        onPollServer: opts.onPollServer,
        getServerPollIntervalMs: opts.getServerPollIntervalMs,
        onPollMetrics: opts.onPollMetrics,
        getMetricsPollIntervalMs: opts.getMetricsPollIntervalMs,
        onPollAsync: opts.onPollAsync,
        getAsyncPollIntervalMs: opts.getAsyncPollIntervalMs,
      });
      if (runtime && typeof runtime.initialize === "function") {
        runtime.initialize();
      }
      return true;
    }

    function getStartingURL() {
      if (runtime && typeof runtime.getStartingURL === "function") {
        return runtime.getStartingURL();
      }
      return defaultStartingURL();
    }

    function initializeStartURL() {
      if (!runtime || typeof runtime.initializeStartURL !== "function") return;
      runtime.initializeStartURL();
    }

    function startTimers() {
      if (!runtime || typeof runtime.startTimers !== "function") return;
      runtime.startTimers();
    }

    function stopTimers() {
      if (!runtime || typeof runtime.stopTimers !== "function") return;
      runtime.stopTimers();
    }

    return {
      initialize: initialize,
      getStartingURL: getStartingURL,
      initializeStartURL: initializeStartURL,
      startTimers: startTimers,
      stopTimers: stopTimers,
    };
  }

  window.createBootstrapBridge = createBootstrapBridge;
})();
