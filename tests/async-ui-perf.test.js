"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

function createElement(tagName) {
  var listeners = {};
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
      for (var i = 0; i < queue.length; i++) queue[i](evt || { type: eventName });
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
    setAttribute: function (name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
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
      return "";
    },
    set: function () {
      this.children = [];
    },
  });
  return element;
}

function createContext() {
  var elements = {};
  var document = {
    body: createElement("body"),
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
    querySelectorAll: function () {
      return [];
    },
  };
  var localStorageStore = {};
  var context = {
    window: {
      location: { search: "", hash: "", href: "http://localhost/" },
      document: document,
    },
    document: document,
    URL: URL,
    URLSearchParams: URLSearchParams,
    localStorage: {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(localStorageStore, key) ? localStorageStore[key] : null; },
      setItem: function (key, value) { localStorageStore[key] = String(value); },
      removeItem: function (key) { delete localStorageStore[key]; },
    },
    navigator: {},
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: function () { return 1; },
    clearInterval: function () {},
    fetch: null,
    console: console,
    Date: Date,
    Math: Math,
    JSON: JSON,
    parseInt: parseInt,
    isFinite: isFinite,
    Promise: Promise,
  };
  context.window.window = context.window;
  context.window.localStorage = context.localStorage;
  context.window.fetch = function () {
    return context.fetch.apply(null, arguments);
  };
  return vm.createContext(context);
}

function runScript(filePath, context) {
  var source = fs.readFileSync(filePath, "utf8");
  vm.runInContext(source, context, { filename: path.basename(filePath) });
}

async function run() {
  var context = createContext();
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

  var jobs = [];
  for (var i = 0; i < 1000; i += 1) {
    jobs.push({
      id: "bench-job-" + i,
      targetURL: "https://example.com/" + i,
      status: "completed",
      createdAt: Date.now() - i * 10,
      updatedAt: Date.now() - i * 5,
      artifactAvailable: false,
    });
  }

  context.fetch = function (url) {
    var parsed = new URL(String(url), "http://localhost");
    if (parsed.pathname === "/api/list") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve({ ok: true, jobs: jobs }); },
        headers: { get: function () { return null; } },
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve({ ok: true }); },
      headers: { get: function () { return null; } },
    });
  };

  runScript(path.join(__dirname, "..", "ui", "runtime-utils.js"), context);
  runScript(path.join(__dirname, "..", "ui", "storage-utils.js"), context);
  runScript(path.join(__dirname, "..", "ui", "http-client.js"), context);
  runScript(path.join(__dirname, "..", "ui", "async-queue.js"), context);

  var controller = context.window.createAsyncQueueController({
    listEndpoint: "/api/list",
    maxItems: 1200,
    pageSize: 60,
    getAPIKey: function () { return ""; },
    getCurrentURL: function () { return ""; },
    getStartingURL: function () { return ""; },
  });

  var start = Date.now();
  controller.initialize();
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  if (context.document.getElementById("async-list").children.length === 0) {
    await controller.refresh(true);
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
  }
  var durationMs = Date.now() - start;
  var thresholdMs = parseInt(process.env.ASYNC_UI_MAX_REFRESH_MS || "1800", 10);

  var list = context.document.getElementById("async-list");
  assert.strictEqual(list.children.length, 60, "windowed render should only paint first page");
  assert.ok(durationMs <= thresholdMs, "async ui refresh exceeded threshold: " + durationMs + "ms > " + thresholdMs + "ms");

  console.log(JSON.stringify({
    ok: true,
    durationMs: durationMs,
    thresholdMs: thresholdMs,
    renderedRows: list.children.length,
  }));
}

run().catch(function (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
