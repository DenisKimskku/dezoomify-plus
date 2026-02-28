"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

function createElement(tagName) {
  return {
    tagName: String(tagName || "div").toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    width: 0,
    height: 0,
    checked: false,
    textContent: "",
    innerHTML: "",
    href: "",
    download: "",
    className: "",
    appendChild: function (child) {
      this.children.push(child);
      return child;
    },
    setAttribute: function (name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute: function (name) {
      delete this.attributes[name];
    },
    addEventListener: function () {},
    getContext: function () {
      return {
        drawImage: function () {},
        getImageData: function () {
          return { data: [0, 0, 0, 0] };
        },
      };
    },
    toBlob: function (cb) {
      cb({});
    },
  };
}

function bootstrapZoomManager() {
  var elementStore = {};
  var requiredIds = [
    "rendering-canvas",
    "dezoomers",
    "error",
    "percent",
    "errormsg",
    "error-img",
    "gh-search",
    "gh-open-issue",
    "status",
    "progressbar",
  ];
  requiredIds.forEach(function (id) {
    elementStore[id] = createElement("div");
  });
  elementStore["rendering-canvas"] = createElement("canvas");

  global.document = {
    body: createElement("body"),
    title: "test",
    getElementById: function (id) {
      if (!elementStore[id]) elementStore[id] = createElement("div");
      return elementStore[id];
    },
    createElement: function (tagName) {
      return createElement(tagName);
    },
  };
  global.window = {
    innerHeight: 800,
    innerWidth: 1200,
    location: { href: "http://localhost/" },
    onerror: null,
  };
  global.URL = global.URL || require("url").URL;
  global.navigator = global.navigator || {};
  global.Blob = global.Blob || function Blob() {};

  var source = fs.readFileSync(path.join(__dirname, "..", "zoommanager.js"), "utf8");
  vm.runInThisContext(source, { filename: "zoommanager.js" });

  // Replace UI mutations with no-op deterministic hooks for these unit tests.
  UI.setDezoomer = function () {};
  UI.reset = function () {};
  UI.setupRendering = function () {};
  UI.updateProgress = function () {};
  UI.drawTile = function () {};
  UI.error = function (message) {
    throw new Error("UI.error called: " + message);
  };
  UI.loadEnd = function () {};

  ZoomManager.dezoomersList["Select automatically"] = { name: "Select automatically" };
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function setupStatus() {
  ZoomManager.reset();
  ZoomManager.init();
}

async function testRecordTileFailure() {
  setupStatus();
  ZoomManager.status.dynamicConcurrency = 6;
  var before = Date.now();
  var originalRandom = Math.random;
  try {
    Math.random = function () { return 1; };
    ZoomManager.recordTileFailure();
  } finally {
    Math.random = originalRandom;
  }

  assert.strictEqual(ZoomManager.status.dynamicConcurrency, 5);
  assert.ok(ZoomManager.status.backoffUntil >= before);
  assert.strictEqual(ZoomManager.status.tileConsecutiveFailures, 1);
  assert.strictEqual(ZoomManager.status.tileConsecutiveSuccesses, 0);
}

async function testRecordTileSuccessAdaptiveConcurrency() {
  setupStatus();
  ZoomManager.status.dynamicConcurrency = 2;
  ZoomManager.status.tileConsecutiveSuccesses = 19;
  ZoomManager.recordTileSuccess();

  assert.strictEqual(ZoomManager.status.dynamicConcurrency, 3);
  assert.strictEqual(ZoomManager.status.tileConsecutiveSuccesses, 0);
  assert.strictEqual(ZoomManager.status.tileConsecutiveFailures, 0);
}

async function testDefaultRenderBackoffAndConcurrency() {
  setupStatus();
  ZoomManager.status.dynamicConcurrency = 3;
  ZoomManager.status.backoffUntil = Date.now() + 40;
  ZoomManager.dezoomer = {
    name: "fake",
    getTileURL: function (x, y) {
      return "tile-" + x + "-" + y;
    },
  };

  var dispatchCount = 0;
  var maxActive = 0;
  var firstDispatchAt = 0;
  var startedAt = Date.now();
  var originalAddTile = ZoomManager.addTile;
  try {
    ZoomManager.addTile = function (url, x, y, ntries, onLoaded) {
      dispatchCount += 1;
      maxActive = Math.max(maxActive, ZoomManager.status.activeTiles);
      if (!firstDispatchAt) firstDispatchAt = Date.now();
      setTimeout(function () {
        ZoomManager.status.loaded += 1;
        if (typeof onLoaded === "function") onLoaded();
      }, 0);
    };

    ZoomManager.defaultRender({
      width: 512,
      height: 512,
      tileSize: 256,
      overlap: 0,
      nbrTilesX: 2,
      nbrTilesY: 2,
      totalTiles: 4,
    });

    await sleep(15);
    assert.strictEqual(dispatchCount, 0, "No tile should dispatch during backoff window");

    await sleep(80);
    assert.ok(dispatchCount > 0, "Tile dispatch should resume after backoff");
    assert.ok(firstDispatchAt - startedAt >= 25, "Dispatch should be delayed by global backoff");
    assert.ok(maxActive <= 3, "Active tile count should respect dynamic concurrency");

    await sleep(80);
    assert.strictEqual(ZoomManager.status.loaded, 4, "All tiles should complete");
  } finally {
    ZoomManager.addTile = originalAddTile;
  }
}

async function testAddTileDirectThenProxyFallback() {
  setupStatus();
  ZoomManager.proxy_tiles = "https://proxy.example/proxy.php";
  ZoomManager.PREFER_DIRECT_TILE_FETCH = true;
  ZoomManager.BACKOFF_BASE_MS = 1;
  ZoomManager.BACKOFF_CAP_MS = 5;

  var requested = [];
  var oldImage = global.Image;
  var oldGetRetryDelay = ZoomManager.getRetryDelay;
  var oldGetProxyTileURL = ZoomManager.getProxyTileURL;

  function FakeImage() {
    this.listeners = {};
    this.crossOrigin = "";
    this.referrerPolicy = "";
  }
  FakeImage.plan = ["error", "load"];
  FakeImage.prototype.addEventListener = function (eventName, callback) {
    this.listeners[eventName] = callback;
  };
  Object.defineProperty(FakeImage.prototype, "src", {
    set: function (value) {
      var self = this;
      this._src = value;
      requested.push(value);
      var nextEvent = FakeImage.plan.shift();
      setTimeout(function () {
        if (nextEvent && typeof self.listeners[nextEvent] === "function") {
          self.listeners[nextEvent]({});
        }
      }, 0);
    },
    get: function () {
      return this._src;
    },
  });

  ZoomManager.getRetryDelay = function () { return 0; };
  ZoomManager.getProxyTileURL = function (url) {
    return "proxy::" + url;
  };
  global.Image = FakeImage;

  try {
    await new Promise(function (resolve, reject) {
      ZoomManager.addTile(
        "https://tiles.example/a.jpg",
        0,
        0,
        0,
        function () { resolve(); },
        function () { reject(new Error("tile failed")); }
      );
    });
  } finally {
    global.Image = oldImage;
    ZoomManager.getRetryDelay = oldGetRetryDelay;
    ZoomManager.getProxyTileURL = oldGetProxyTileURL;
  }

  assert.deepStrictEqual(
    requested.slice(0, 2),
    ["https://tiles.example/a.jpg", "proxy::https://tiles.example/a.jpg"]
  );
  assert.strictEqual(ZoomManager.status.loaded, 1);
}

async function testAddTileWorkerRendererPath() {
  setupStatus();
  ZoomManager.proxy_tiles = "https://proxy.example/proxy.php";
  ZoomManager.PREFER_DIRECT_TILE_FETCH = true;

  var oldIsWorkerActive = ZoomManager.isWorkerRendererActive;
  var oldRenderTileViaWorker = ZoomManager.renderTileViaWorker;
  var oldGetProxyTileURL = ZoomManager.getProxyTileURL;
  var oldGetRetryDelay = ZoomManager.getRetryDelay;

  var workerRequests = [];
  ZoomManager.isWorkerRendererActive = function () { return true; };
  ZoomManager.getProxyTileURL = function (url) { return "proxy::" + url; };
  ZoomManager.getRetryDelay = function () { return 0; };

  ZoomManager.renderTileViaWorker = function (requestUrl, x, y, done) {
    workerRequests.push(requestUrl);
    if (workerRequests.length === 1) {
      setTimeout(function () {
        done(new Error("worker-failure"));
      }, 0);
      return;
    }
    setTimeout(function () {
      done(null);
    }, 0);
  };

  try {
    await new Promise(function (resolve, reject) {
      ZoomManager.addTile(
        "https://tiles.example/worker.jpg",
        0,
        0,
        0,
        function () { resolve(); },
        function () { reject(new Error("tile failed")); }
      );
    });
  } finally {
    ZoomManager.isWorkerRendererActive = oldIsWorkerActive;
    ZoomManager.renderTileViaWorker = oldRenderTileViaWorker;
    ZoomManager.getProxyTileURL = oldGetProxyTileURL;
    ZoomManager.getRetryDelay = oldGetRetryDelay;
  }

  assert.deepStrictEqual(
    workerRequests.slice(0, 2),
    ["https://tiles.example/worker.jpg", "proxy::https://tiles.example/worker.jpg"]
  );
  assert.strictEqual(ZoomManager.status.loaded, 1);
}

async function run() {
  bootstrapZoomManager();
  var tests = [
    { name: "recordTileFailure adjusts backoff + concurrency", fn: testRecordTileFailure },
    { name: "recordTileSuccess adaptive concurrency increase", fn: testRecordTileSuccessAdaptiveConcurrency },
    { name: "defaultRender respects global backoff and concurrency", fn: testDefaultRenderBackoffAndConcurrency },
    { name: "addTile direct->proxy fallback before retries", fn: testAddTileDirectThenProxyFallback },
    { name: "addTile worker path keeps proxy fallback behavior", fn: testAddTileWorkerRendererPath },
  ];

  var failed = 0;
  for (var i = 0; i < tests.length; i += 1) {
    var t = tests[i];
    try {
      await t.fn();
      console.log("PASS", t.name);
    } catch (error) {
      failed += 1;
      console.error("FAIL", t.name);
      console.error(error && error.stack ? error.stack : String(error));
    }
  }

  if (failed > 0) {
    console.error("Tests failed:", failed);
    process.exitCode = 1;
    return;
  }
  console.log("All tests passed:", tests.length);
}

run();
