(function () {
  "use strict";

  var DEFAULT_TILE_STORAGE_KEY = "dezoomify:tileConcurrency";
  var DEFAULT_SCHEDULER_INTERVAL_MS = 15000;
  var DEFAULT_SERVER_POLL_INTERVAL_MS = 45000;
  var DEFAULT_METRICS_POLL_INTERVAL_MS = 30000;
  var DEFAULT_ASYNC_POLL_INTERVAL_MS = 15000;
  var DEFAULT_RATE_LIMIT_INTERVAL_MS = 1000;

  function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
  }

  function parseIntOr(value, fallbackValue) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : fallbackValue;
  }

  function getStorageUtils() {
    return window.dezoomifyStorageUtils || {};
  }

  function createBootstrapRuntime(options) {
    var opts = options || {};
    var refs = {
      urlInput: opts.urlInput || null,
      form: opts.form || null,
      concurrencyInput: opts.concurrencyInput || null,
      concurrencyValue: opts.concurrencyValue || null,
    };
    var searchParams = opts.searchParams;
    var tileStorageKey = String(opts.tileStorageKey || DEFAULT_TILE_STORAGE_KEY);
    var timers = {
      scheduler: null,
      rateLimit: null,
      serverPoll: null,
      metricsPoll: null,
      asyncPoll: null,
    };
    var pollState = {
      serverPoll: { busy: false },
      metricsPoll: { busy: false },
      asyncPoll: { busy: false },
    };
    var initialized = false;

    function getStartingURL() {
      if (!searchParams || typeof searchParams.get !== "function") {
        return window.location.hash.slice(1);
      }
      return searchParams.get("url") || window.location.hash.slice(1);
    }

    function getConcurrencyLimits() {
      if (typeof opts.getConcurrencyLimits === "function") {
        var limits = opts.getConcurrencyLimits() || {};
        return {
          defaultValue: parseIntOr(limits.defaultValue, 12),
          minValue: parseIntOr(limits.minValue, 2),
          maxValue: parseIntOr(limits.maxValue, 20),
        };
      }
      return {
        defaultValue: 12,
        minValue: 2,
        maxValue: 20,
      };
    }

    function applyConcurrency(rawValue) {
      var limits = getConcurrencyLimits();
      var parsed = parseIntOr(rawValue, limits.defaultValue);
      parsed = clamp(parsed, limits.minValue, limits.maxValue);
      if (typeof opts.onSetConcurrency === "function") {
        opts.onSetConcurrency(parsed);
      }
      if (refs.concurrencyInput) refs.concurrencyInput.value = parsed;
      if (refs.concurrencyValue) refs.concurrencyValue.textContent = String(parsed);
      var storage = getStorageUtils();
      if (typeof storage.writeString === "function") {
        storage.writeString(tileStorageKey, String(parsed));
      } else {
        try {
          localStorage.setItem(tileStorageKey, String(parsed));
        } catch (_) { }
      }
      return parsed;
    }

    function initializeConcurrencyControls() {
      var initial = "";
      if (searchParams && typeof searchParams.get === "function") {
        initial = searchParams.get("concurrency") || "";
      }
      if (!initial) {
        var storage = getStorageUtils();
        if (typeof storage.readString === "function") {
          initial = storage.readString(tileStorageKey, "");
        } else {
          try {
            initial = localStorage.getItem(tileStorageKey) || "";
          } catch (_) { }
        }
      }
      applyConcurrency(initial);
      if (!refs.concurrencyInput) return;
      refs.concurrencyInput.addEventListener("input", function () {
        applyConcurrency(refs.concurrencyInput.value);
      });
    }

    function initializeForm() {
      if (!refs.form || !refs.urlInput) return;
      refs.form.onsubmit = function (evt) {
        evt.preventDefault();
        if (typeof opts.onSubmitURL === "function") {
          opts.onSubmitURL(refs.urlInput.value, "manual");
        }
        return false;
      };
    }

    function initializeQuickActions() {
      var pasteButton = document.getElementById("paste-url");
      if (pasteButton) {
        pasteButton.addEventListener("click", function () {
          if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") return;
          navigator.clipboard.readText().then(function (clipboardText) {
            if (clipboardText && refs.urlInput) refs.urlInput.value = clipboardText.trim();
          }).catch(function (_) { });
        });
      }

      Array.prototype.forEach.call(document.querySelectorAll(".example-url"), function (button) {
        button.addEventListener("click", function () {
          var exampleURL = button.getAttribute("data-example-url");
          if (!exampleURL || !refs.urlInput) return;
          refs.urlInput.value = exampleURL;
          refs.urlInput.focus();
          refs.urlInput.select();
        });
      });

      var popupCloseButton = document.querySelector("#popup > button[title=Close]");
      if (popupCloseButton) {
        popupCloseButton.addEventListener("click", function () {
          var popup = document.getElementById("popup");
          if (popup) popup.style.bottom = "-500px";
        });
      }
    }

    function initializeStartURL() {
      var startURL = getStartingURL();
      if (startURL) {
        if (refs.urlInput) refs.urlInput.value = startURL;
        if (typeof opts.onStartURLDetected === "function") {
          opts.onStartURLDetected(startURL);
        }
      }

      var autoStartFlag = "";
      if (searchParams && typeof searchParams.get === "function") {
        autoStartFlag = searchParams.get("autostart") || "";
      }
      var autoStart = /^(1|true|yes)$/i.test(autoStartFlag);
      if (autoStart && startURL && typeof opts.onAutoStartURL === "function") {
        opts.onAutoStartURL(startURL);
      }
    }

    function startTimers() {
      var schedulerIntervalMs = parseIntOr(opts.schedulerIntervalMs, DEFAULT_SCHEDULER_INTERVAL_MS);
      var serverPollIntervalMs = parseIntOr(opts.serverPollIntervalMs, DEFAULT_SERVER_POLL_INTERVAL_MS);
      var metricsPollIntervalMs = parseIntOr(opts.metricsPollIntervalMs, DEFAULT_METRICS_POLL_INTERVAL_MS);
      var asyncPollIntervalMs = parseIntOr(opts.asyncPollIntervalMs, DEFAULT_ASYNC_POLL_INTERVAL_MS);
      var rateLimitIntervalMs = parseIntOr(opts.rateLimitIntervalMs, DEFAULT_RATE_LIMIT_INTERVAL_MS);

      timers.scheduler = setInterval(function () {
        if (typeof opts.onTickSchedules === "function") {
          opts.onTickSchedules();
        }
      }, schedulerIntervalMs);
      timers.rateLimit = setInterval(function () {
        if (typeof opts.onRateLimitTick === "function") {
          opts.onRateLimitTick();
        }
      }, rateLimitIntervalMs);

      function resolveDynamicInterval(defaultMs, provider) {
        if (typeof provider !== "function") return Math.max(defaultMs, 1000);
        var dynamic = parseIntOr(provider(), defaultMs);
        return Math.max(dynamic, 1000);
      }

      function nextJitteredDelay(ms) {
        var base = Math.max(parseIntOr(ms, 1000), 1000);
        var jitter = Math.floor((Math.random() * 0.2 - 0.1) * base);
        return Math.max(base + jitter, 1000);
      }

      function scheduleAdaptiveTimer(timerKey, pollKey, defaultInterval, onPoll, getInterval) {
        if (typeof onPoll !== "function") return;
        var state = pollState[pollKey] || { busy: false };
        pollState[pollKey] = state;

        function runTick() {
          var interval = resolveDynamicInterval(defaultInterval, getInterval);
          timers[timerKey] = setTimeout(function () {
            if (state.busy) {
              runTick();
              return;
            }
            state.busy = true;
            Promise.resolve()
              .then(function () { return onPoll(); })
              .catch(function () { })
              .finally(function () {
                state.busy = false;
                runTick();
              });
          }, nextJitteredDelay(interval));
        }

        runTick();
      }

      scheduleAdaptiveTimer("serverPoll", "serverPoll", serverPollIntervalMs, opts.onPollServer, opts.getServerPollIntervalMs);
      scheduleAdaptiveTimer("metricsPoll", "metricsPoll", metricsPollIntervalMs, opts.onPollMetrics, opts.getMetricsPollIntervalMs);
      scheduleAdaptiveTimer("asyncPoll", "asyncPoll", asyncPollIntervalMs, opts.onPollAsync, opts.getAsyncPollIntervalMs);
    }

    function stopTimers() {
      var keys = Object.keys(timers);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!timers[key]) continue;
        clearInterval(timers[key]);
        timers[key] = null;
      }
      pollState.serverPoll.busy = false;
      pollState.metricsPoll.busy = false;
      pollState.asyncPoll.busy = false;
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;
      initializeConcurrencyControls();
      initializeForm();
      initializeQuickActions();
      return true;
    }

    return {
      initialize: initialize,
      getStartingURL: getStartingURL,
      initializeStartURL: initializeStartURL,
      startTimers: startTimers,
      stopTimers: stopTimers,
    };
  }

  window.createBootstrapRuntime = createBootstrapRuntime;
})();
