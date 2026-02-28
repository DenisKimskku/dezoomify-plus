"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

function test(name, fn) {
  return { name: name, fn: fn };
}

function createElement(tagName) {
  var listeners = {};
  var innerHTMLValue = "";
  var element = {
    tagName: String(tagName || "div").toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    addEventListener: function (name, fn) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(fn);
    },
    dispatchEvent: function (evt) {
      var eventName = evt && evt.type ? evt.type : String(evt || "");
      var queue = listeners[eventName] || [];
      for (var i = 0; i < queue.length; i++) {
        queue[i](evt || { type: eventName });
      }
    },
    appendChild: function (child) {
      if (child && typeof child === "object") child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild: function (child) {
      var index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      if (child && typeof child === "object") child.parentNode = null;
      return child;
    },
    replaceChild: function (nextChild, oldChild) {
      var index = this.children.indexOf(oldChild);
      if (index < 0) return oldChild;
      if (nextChild && typeof nextChild === "object") nextChild.parentNode = this;
      this.children[index] = nextChild;
      if (oldChild && typeof oldChild === "object") oldChild.parentNode = null;
      return oldChild;
    },
    setAttribute: function (name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    hasAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    removeAttribute: function (name) {
      delete this.attributes[name];
    },
    querySelectorAll: function () {
      return [];
    },
    focus: function () {},
    select: function () {},
    reset: function () {},
  };
  Object.defineProperty(element, "innerHTML", {
    get: function () {
      return innerHTMLValue;
    },
    set: function (value) {
      innerHTMLValue = String(value || "");
      this.children = [];
    },
  });
  return element;
}

function createDocument() {
  var elements = {};
  var body = createElement("body");
  return {
    _elements: elements,
    body: body,
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement("div");
      return elements[id];
    },
    createElement: function (tagName) {
      return createElement(tagName);
    },
    createElementNS: function (_, tagName) {
      return createElement(tagName);
    },
    querySelector: function () {
      return null;
    },
    querySelectorAll: function () {
      return [];
    },
  };
}

function createLocalStorage() {
  var store = {};
  return {
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem: function (key, value) {
      store[key] = String(value);
    },
    removeItem: function (key) {
      delete store[key];
    },
  };
}

function createMockResponse(statusCode, payload, headers) {
  var status = parseInt(statusCode, 10) || 200;
  var headerMap = headers && typeof headers === "object" ? headers : {};
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: function () {
      return Promise.resolve(payload);
    },
    headers: {
      get: function (name) {
        if (!name) return null;
        var lower = String(name).toLowerCase();
        var keys = Object.keys(headerMap);
        for (var i = 0; i < keys.length; i++) {
          if (String(keys[i]).toLowerCase() === lower) {
            return headerMap[keys[i]];
          }
        }
        return null;
      },
    },
  };
}

function runScriptInContext(filePath, context) {
  var source = fs.readFileSync(filePath, "utf8");
  vm.runInContext(source, context, { filename: path.basename(filePath) });
}

function createBaseContext() {
  var document = createDocument();
  var window = {
    location: {
      search: "",
      hash: "",
      href: "http://localhost/",
    },
  };
  var context = {
    window: window,
    document: document,
    localStorage: createLocalStorage(),
    URLSearchParams: URLSearchParams,
    URL: URL,
    navigator: {},
    setInterval: function () { return 1; },
    clearInterval: function () {},
    setTimeout: function (fn) { if (typeof fn === "function") fn(); },
    clearTimeout: function () {},
    console: console,
    Math: Math,
    Date: Date,
    JSON: JSON,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    RegExp: RegExp,
    parseInt: parseInt,
    isFinite: isFinite,
    Promise: Promise,
  };
  window.window = window;
  window.document = document;
  window.localStorage = context.localStorage;
  return vm.createContext(context);
}

function createAppRuntimeHarness() {
  var context = createBaseContext();
  var calls = {
    startupStart: 0,
    createJobsOrchestrator: 0,
    jobsPanelsInitialize: 0,
    serviceInitialize: 0,
    serviceInitializeServerSync: 0,
    operationsInitialize: 0,
    bootstrapInitialize: 0,
    bootstrapInitializeStartURL: 0,
    bootstrapStartTimers: 0,
    historyRender: 0,
    scheduleRender: 0,
  };

  [
    "url",
    "urlform",
    "tile-concurrency",
    "tile-concurrency-value",
    "percent",
  ].forEach(function (id) {
    context.document.getElementById(id);
  });

  context.UI = {
    error: function () {},
  };

  context.ZoomManager = {
    DEFAULT_TILE_CONCURRENCY: 12,
    MIN_TILE_CONCURRENCY: 2,
    MAX_TILE_CONCURRENCY: 20,
    PREFERRED_TILE_CONCURRENCY: 12,
    api_key: "",
    loadEnd: function () {},
    error: function () {},
    open: function () {},
    onRateLimitInfo: null,
    lastRateLimitInfo: null,
  };

  context.window.createJobsOrchestrator = function () {
    calls.createJobsOrchestrator += 1;
    return {
      formatDate: function (ts) { return ts ? "date" : "n/a"; },
      formatDuration: function () { return "1s"; },
      toLocalDateTimeInput: function () { return "2026-01-01T00:00"; },
      parseDateInput: function () { return Date.now(); },
      getActiveJob: function () { return null; },
      runJob: function () { return true; },
      finalizeActiveJob: function () { return true; },
      triggerSchedule: function () { return true; },
      tickSchedules: function () {},
      applyServerState: function () { return true; },
      getLocalState: function () { return { schedules: [], history: [] }; },
      getHistory: function () { return []; },
      getSchedules: function () { return []; },
      addSchedule: function () {},
      toggleSchedule: function () {},
      deleteSchedule: function () {},
      rerunFromHistory: function () {},
      clearHistory: function () {},
    };
  };

  context.window.createJobsPanelsRuntime = function () {
    return {
      initialize: function () {
        calls.jobsPanelsInitialize += 1;
      },
      renderHistory: function () {
        calls.historyRender += 1;
      },
      renderSchedules: function () {
        calls.scheduleRender += 1;
      },
      prefillScheduleURL: function () {},
      computeNextRun: function (_, ts) {
        return ts + 60000;
      },
    };
  };

  context.window.createServiceSyncRuntime = function () {
    return {
      initialize: function () {
        calls.serviceInitialize += 1;
      },
      initializeServerSync: function () {
        calls.serviceInitializeServerSync += 1;
        return Promise.resolve({ loaded: true, shouldBootstrap: false });
      },
      queueSync: function () {},
      fetchState: function () {
        return Promise.resolve({ loaded: true, shouldBootstrap: false });
      },
      getCurrentAPIKey: function () {
        return "";
      },
      getStorageState: function () {
        return {
          serverJobsEnabled: true,
          lastServerBackend: "memory",
          lastServerOwner: "anon",
          lastServerError: "",
        };
      },
    };
  };

  context.window.createOperationsRuntime = function () {
    return {
      initialize: function () {
        calls.operationsInitialize += 1;
      },
      updateRateLimitSummary: function () {},
      setRateLimitInfo: function () {},
      setStorageState: function () {},
      fetchMetricsSnapshot: function () {
        return Promise.resolve(true);
      },
      refreshAsyncJobs: function () {
        return Promise.resolve(true);
      },
    };
  };

  context.window.createBootstrapBridge = function () {
    return {
      initialize: function () {
        calls.bootstrapInitialize += 1;
      },
      getStartingURL: function () {
        return "";
      },
      initializeStartURL: function () {
        calls.bootstrapInitializeStartURL += 1;
      },
      startTimers: function () {
        calls.bootstrapStartTimers += 1;
      },
    };
  };

  context.window.createStartupSequencer = function (opts) {
    return {
      start: function () {
        calls.startupStart += 1;
        if (opts && typeof opts.initializeJobsRuntime === "function") opts.initializeJobsRuntime();
        if (opts && typeof opts.initializeServiceSyncRuntime === "function") opts.initializeServiceSyncRuntime();
        if (opts && typeof opts.initializeOperationsRuntime === "function") opts.initializeOperationsRuntime();
        if (opts && typeof opts.initializeBootstrapBridge === "function") opts.initializeBootstrapBridge();
        if (opts && typeof opts.initializeJobsPanelsRuntime === "function") opts.initializeJobsPanelsRuntime();
        if (opts && typeof opts.installZoomManagerHooks === "function") opts.installZoomManagerHooks();
        if (opts && typeof opts.initializeStartURL === "function") opts.initializeStartURL();
        if (opts && typeof opts.renderHistory === "function") opts.renderHistory();
        if (opts && typeof opts.renderSchedules === "function") opts.renderSchedules();
        if (opts && typeof opts.updateRateLimitSummary === "function") opts.updateRateLimitSummary();
        if (opts && typeof opts.updateStorageModeSummary === "function") opts.updateStorageModeSummary();
        if (opts && typeof opts.startTimers === "function") opts.startTimers();
        if (opts && typeof opts.initializeServerStateSync === "function") opts.initializeServerStateSync();
      },
    };
  };

  return {
    context: context,
    calls: calls,
  };
}

function createBrowserInitHarness() {
  var context = createBaseContext();
  var calls = {
    createAppRuntime: 0,
    start: 0,
    options: null,
  };

  [
    "url",
    "urlform",
    "tile-concurrency",
    "tile-concurrency-value",
  ].forEach(function (id) {
    context.document.getElementById(id);
  });

  context.window.createAppRuntime = function (options) {
    calls.createAppRuntime += 1;
    calls.options = options || {};
    return {
      start: function () {
        calls.start += 1;
      },
    };
  };

  return {
    context: context,
    calls: calls,
  };
}

var tests = [
  test("ui modules export expected factory functions", function () {
    var context = createBaseContext();
    var files = [
      "ui/runtime-utils.js",
      "ui/storage-utils.js",
      "ui/http-client.js",
      "ui/limits-panel.js",
      "ui/metrics-panel.js",
      "ui/retention-controls.js",
      "ui/history-panel.js",
      "ui/schedule-panel.js",
      "ui/async-queue.js",
      "ui/operations-runtime.js",
      "ui/bootstrap-runtime.js",
      "ui/bootstrap-bridge.js",
      "ui/jobs-panels-runtime.js",
      "ui/jobs-orchestrator.js",
      "ui/jobs-sync-controller.js",
      "ui/api-key-controls.js",
      "ui/service-sync-runtime.js",
      "ui/startup-sequencer.js",
      "ui/app-runtime.js",
    ];

    files.forEach(function (relativeFile) {
      runScriptInContext(path.join(__dirname, "..", relativeFile), context);
    });

    assert.strictEqual(typeof context.window.createLimitsPanelController, "function");
    assert.strictEqual(typeof context.window.dezoomifyRuntimeUtils, "object");
    assert.strictEqual(typeof context.window.dezoomifyStorageUtils, "object");
    assert.strictEqual(typeof context.window.dezoomifyHttpClient, "object");
    assert.strictEqual(typeof context.window.createMetricsPanelController, "function");
    assert.strictEqual(typeof context.window.createRetentionControls, "function");
    assert.strictEqual(typeof context.window.createHistoryPanelController, "function");
    assert.strictEqual(typeof context.window.createSchedulePanelController, "function");
    assert.strictEqual(typeof context.window.createAsyncQueueController, "function");
    assert.strictEqual(typeof context.window.createOperationsRuntime, "function");
    assert.strictEqual(typeof context.window.createBootstrapRuntime, "function");
    assert.strictEqual(typeof context.window.createBootstrapBridge, "function");
    assert.strictEqual(typeof context.window.createJobsPanelsRuntime, "function");
    assert.strictEqual(typeof context.window.createJobsOrchestrator, "function");
    assert.strictEqual(typeof context.window.createJobsSyncController, "function");
    assert.strictEqual(typeof context.window.createAPIKeyControls, "function");
    assert.strictEqual(typeof context.window.createServiceSyncRuntime, "function");
    assert.strictEqual(typeof context.window.createStartupSequencer, "function");
    assert.strictEqual(typeof context.window.createAppRuntime, "function");
  }),

  test("history panel supports local filter and pagination fallback", async function () {
    var context = createBaseContext();
    [
      "history-empty",
      "history-list",
      "clear-history",
      "history-status",
      "history-filter-status",
      "history-filter-query",
      "history-filter-apply",
      "history-filter-reset",
      "history-page-prev",
      "history-page-next",
      "history-page-info",
    ].forEach(function (id) {
      context.document.getElementById(id);
    });

    context.fetch = function () {
      return Promise.resolve(createMockResponse(404, { ok: false, error: "missing" }));
    };
    context.window.fetch = context.fetch;

    runScriptInContext(path.join(__dirname, "..", "ui", "runtime-utils.js"), context);
    runScriptInContext(path.join(__dirname, "..", "ui", "storage-utils.js"), context);
    runScriptInContext(path.join(__dirname, "..", "ui", "http-client.js"), context);
    runScriptInContext(path.join(__dirname, "..", "ui", "history-panel.js"), context);

    var controller = context.window.createHistoryPanelController({
      endpoint: "/api/history",
      getAPIKey: function () { return ""; },
      onRunAgain: function () {},
      onClear: function () {},
    });
    controller.initialize();
    controller.render([
      { id: "h1", url: "https://example.com/a", status: "success", startedAt: 1000, durationMs: 1000 },
      { id: "h2", url: "https://example.com/b", status: "error", startedAt: 2000, durationMs: 1000, message: "failed" },
    ]);
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    await new Promise(function (resolve) { setTimeout(resolve, 0); });

    var filter = context.document.getElementById("history-filter-status");
    filter.value = "error";
    filter.dispatchEvent({ type: "change", preventDefault: function () {} });
    await controller.refresh(true);

    var list = context.document.getElementById("history-list");
    assert.strictEqual(list.children.length, 1);
  }),

  test("async queue renders incrementally and supports load more", async function () {
    var context = createBaseContext();
    [
      "async-form",
      "async-url",
      "async-use-current",
      "async-process-now",
      "async-filter-status",
      "async-filter-query",
      "async-filter-apply",
      "async-filter-reset",
      "async-bulk-retry-failed",
      "async-bulk-remove-finished",
      "async-refresh",
      "async-clear-local",
      "async-auto-refresh",
      "async-status",
      "async-empty",
      "async-list",
      "async-load-more",
    ].forEach(function (id) {
      context.document.getElementById(id);
    });
    context.document.getElementById("async-auto-refresh").checked = true;

    var byId = {};
    for (var i = 0; i < 100; i++) {
      byId["job-" + i] = {
        id: "job-" + i,
        targetURL: "https://example.com/" + i,
        status: "completed",
        createdAt: Date.now() - i,
        updatedAt: Date.now() - i,
        artifactAvailable: false,
      };
    }

    context.fetch = function (url) {
      var parsed = new URL(String(url), "http://localhost");
      if (parsed.pathname === "/api/list") {
        return Promise.resolve(createMockResponse(200, {
          ok: true,
          jobs: Object.keys(byId).map(function (id) { return byId[id]; }),
        }));
      }
      if (parsed.pathname === "/api/status") {
        var id = parsed.searchParams.get("id");
        return Promise.resolve(createMockResponse(200, { ok: true, job: byId[id] || null }));
      }
      return Promise.resolve(createMockResponse(200, { ok: true }));
    };
    context.window.fetch = context.fetch;

    runScriptInContext(path.join(__dirname, "..", "ui", "runtime-utils.js"), context);
    runScriptInContext(path.join(__dirname, "..", "ui", "storage-utils.js"), context);
    runScriptInContext(path.join(__dirname, "..", "ui", "http-client.js"), context);
    runScriptInContext(path.join(__dirname, "..", "ui", "async-queue.js"), context);

    var controller = context.window.createAsyncQueueController({
      listEndpoint: "/api/list",
      statusEndpoint: "/api/status",
      getAPIKey: function () { return ""; },
      getCurrentURL: function () { return ""; },
      getStartingURL: function () { return ""; },
      maxItems: 120,
      pageSize: 60,
    });
    controller.initialize();
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    if (context.document.getElementById("async-list").children.length === 0) {
      await controller.refresh(true);
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    var list = context.document.getElementById("async-list");
    assert.strictEqual(list.children.length, 60);
    var loadMore = context.document.getElementById("async-load-more");
    loadMore.dispatchEvent({ type: "click", preventDefault: function () {} });
    assert.ok(list.children.length > 60);
  }),

  test("app-runtime boots modular wiring with stubs", async function () {
    var harness = createAppRuntimeHarness();
    runScriptInContext(path.join(__dirname, "..", "ui", "app-runtime.js"), harness.context);

    var runtime = harness.context.window.createAppRuntime({
      searchParams: new URLSearchParams(""),
      urlInput: harness.context.document.getElementById("url"),
      form: harness.context.document.getElementById("urlform"),
      concurrencyInput: harness.context.document.getElementById("tile-concurrency"),
      concurrencyValue: harness.context.document.getElementById("tile-concurrency-value"),
    });
    runtime.start();

    await new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });

    assert.strictEqual(harness.calls.startupStart, 1);
    assert.strictEqual(harness.calls.createJobsOrchestrator, 1);
    assert.strictEqual(harness.calls.jobsPanelsInitialize, 1);
    assert.strictEqual(harness.calls.serviceInitialize, 1);
    assert.strictEqual(harness.calls.serviceInitializeServerSync, 1);
    assert.strictEqual(harness.calls.operationsInitialize, 1);
    assert.strictEqual(harness.calls.bootstrapInitialize, 1);
    assert.strictEqual(harness.calls.bootstrapInitializeStartURL, 1);
    assert.strictEqual(harness.calls.bootstrapStartTimers, 1);
    assert.ok(harness.calls.historyRender >= 1);
    assert.ok(harness.calls.scheduleRender >= 1);
  }),

  test("browser-init delegates to app-runtime", function () {
    var harness = createBrowserInitHarness();
    runScriptInContext(path.join(__dirname, "..", "browser-init.js"), harness.context);

    assert.strictEqual(harness.calls.createAppRuntime, 1);
    assert.strictEqual(harness.calls.start, 1);
    assert.strictEqual(harness.calls.options.serverJobsEndpoint, "/api/jobs");
    assert.strictEqual(harness.calls.options.serverMetricsEndpoint, "/api/metrics");
    assert.strictEqual(harness.calls.options.maxHistoryItems, 80);
  }),

  test("browser-init supports runtime disable query flag", function () {
    var harness = createBrowserInitHarness();
    harness.context.window.location.search = "?app_runtime=0";
    runScriptInContext(path.join(__dirname, "..", "browser-init.js"), harness.context);

    assert.strictEqual(harness.calls.createAppRuntime, 0);
    assert.strictEqual(harness.calls.start, 0);
  }),

  test("index.html loads required runtime modules before browser-init", function () {
    var source = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    var runtimeUtilsMarker = 'src="ui/runtime-utils.js"';
    var storageUtilsMarker = 'src="ui/storage-utils.js"';
    var httpClientMarker = 'src="ui/http-client.js"';
    var retentionControlsMarker = 'src="ui/retention-controls.js"';
    var operationsMarker = 'src="ui/operations-runtime.js"';
    var bootstrapBridgeMarker = 'src="ui/bootstrap-bridge.js"';
    var jobsPanelsMarker = 'src="ui/jobs-panels-runtime.js"';
    var serviceSyncMarker = 'src="ui/service-sync-runtime.js"';
    var startupSequencerMarker = 'src="ui/startup-sequencer.js"';
    var appRuntimeMarker = 'src="ui/app-runtime.js"';
    var initMarker = 'src="browser-init.js"';
    var runtimeUtilsPos = source.indexOf(runtimeUtilsMarker);
    var storageUtilsPos = source.indexOf(storageUtilsMarker);
    var httpClientPos = source.indexOf(httpClientMarker);
    var retentionControlsPos = source.indexOf(retentionControlsMarker);
    var operationsPos = source.indexOf(operationsMarker);
    var bootstrapBridgePos = source.indexOf(bootstrapBridgeMarker);
    var jobsPanelsPos = source.indexOf(jobsPanelsMarker);
    var serviceSyncPos = source.indexOf(serviceSyncMarker);
    var startupSequencerPos = source.indexOf(startupSequencerMarker);
    var appRuntimePos = source.indexOf(appRuntimeMarker);
    var initPos = source.indexOf(initMarker);

    assert.ok(runtimeUtilsPos >= 0, "runtime utils script include is required");
    assert.ok(storageUtilsPos >= 0, "storage utils script include is required");
    assert.ok(httpClientPos >= 0, "http client script include is required");
    assert.ok(retentionControlsPos >= 0, "retention controls script include is required");
    assert.ok(operationsPos >= 0, "operations runtime script include is required");
    assert.ok(bootstrapBridgePos >= 0, "bootstrap bridge script include is required");
    assert.ok(jobsPanelsPos >= 0, "jobs panels runtime script include is required");
    assert.ok(serviceSyncPos >= 0, "service sync runtime script include is required");
    assert.ok(startupSequencerPos >= 0, "startup sequencer script include is required");
    assert.ok(appRuntimePos >= 0, "app runtime script include is required");
    assert.ok(initPos >= 0, "browser-init script include is required");

    assert.ok(runtimeUtilsPos < initPos, "runtime utils must load before browser-init");
    assert.ok(storageUtilsPos < initPos, "storage utils must load before browser-init");
    assert.ok(httpClientPos < initPos, "http client must load before browser-init");
    assert.ok(retentionControlsPos < initPos, "retention controls must load before browser-init");
    assert.ok(operationsPos < initPos, "operations runtime must load before browser-init");
    assert.ok(bootstrapBridgePos < initPos, "bootstrap bridge must load before browser-init");
    assert.ok(jobsPanelsPos < initPos, "jobs panels runtime must load before browser-init");
    assert.ok(serviceSyncPos < initPos, "service sync runtime must load before browser-init");
    assert.ok(startupSequencerPos < initPos, "startup sequencer must load before browser-init");
    assert.ok(appRuntimePos < initPos, "app runtime must load before browser-init");
  }),
];

async function runTests() {
  for (var i = 0; i < tests.length; i++) {
    var current = tests[i];
    try {
      await current.fn();
      console.log("ok - " + current.name);
    } catch (error) {
      console.error("not ok - " + current.name);
      console.error(error && error.stack ? error.stack : String(error));
      process.exitCode = 1;
      return;
    }
  }
}

runTests();
