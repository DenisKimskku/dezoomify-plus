"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

function test(name, fn) {
  return { name: name, fn: fn };
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function loadIIIFDezoomer(options) {
  var opts = options || {};
  var readyCalls = [];
  var errorCalls = [];
  var getFileCalls = [];
  var imageInstances = [];
  var addedDezoomer = null;

  function FakeImage() {
    this.listeners = {};
    this.width = opts.imageWidth || 512;
    this.height = opts.imageHeight || 512;
    imageInstances.push(this);
  }
  FakeImage.plan = (opts.imagePlan || []).slice();
  FakeImage.prototype.addEventListener = function (name, callback) {
    this.listeners[name] = callback;
  };
  Object.defineProperty(FakeImage.prototype, "src", {
    set: function (value) {
      this._src = value;
      var eventName = FakeImage.plan.length ? FakeImage.plan.shift() : null;
      if (!eventName) return;
      var self = this;
      setTimeout(function () {
        if (typeof self.listeners[eventName] === "function") {
          self.listeners[eventName]({});
        }
      }, 0);
    },
    get: function () {
      return this._src;
    },
  });

  var context = {
    console: console,
    URL: URL,
    Image: FakeImage,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    ZoomManager: {
      getFile: function (url, params, callback) {
        getFileCalls.push({ url: url, params: params });
        callback(opts.manifest, {});
      },
      readyToRender: function (data) {
        readyCalls.push(data);
      },
      error: function (message) {
        errorCalls.push(String(message));
      },
      addDezoomer: function (dezoomer) {
        addedDezoomer = dezoomer;
      },
    },
  };

  var source = fs.readFileSync(path.join(__dirname, "..", "dezoomers", "iiif.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "iiif.js" });

  return {
    dezoomer: addedDezoomer,
    readyCalls: readyCalls,
    errorCalls: errorCalls,
    getFileCalls: getFileCalls,
    imageInstances: imageInstances,
  };
}

var tests = [
  test("IIIF open fast-path skips probe tile when metadata is reliable", async function () {
    var harness = loadIIIFDezoomer({
      manifest: {
        "@id": "https://iiif.example/images/abc",
        width: 10000,
        height: 8000,
        tiles: [
          { width: 512, scaleFactors: [1, 2, 4, 8] },
        ],
        qualities: ["default"],
        formats: ["jpg"],
      },
      imagePlan: ["load"], // should not be consumed in fast-path
    });

    harness.dezoomer.open("https://iiif.example/images/abc/info.json");
    await sleep(10);

    assert.strictEqual(harness.getFileCalls.length, 1);
    assert.strictEqual(harness.readyCalls.length, 1);
    assert.strictEqual(harness.errorCalls.length, 0);
    assert.strictEqual(harness.imageInstances.length, 0);
    assert.strictEqual(harness.readyCalls[0].tileSize, 512);
  }),

  test("IIIF open fallback probes first tile and surfaces probe error", async function () {
    var harness = loadIIIFDezoomer({
      manifest: {
        "@id": "https://iiif.example/images/legacy",
        width: 4000,
        height: 3000,
        tile_width: 256,
        qualities: ["default"],
        formats: ["jpg"],
      },
      imagePlan: ["error"],
    });

    harness.dezoomer.open("https://iiif.example/images/legacy/info.json");
    await sleep(15);

    assert.strictEqual(harness.readyCalls.length, 1, "fallback should still call readyToRender");
    assert.strictEqual(harness.imageInstances.length, 1, "probe image should be attempted");
    assert.strictEqual(harness.errorCalls.length, 1, "probe failure should be reported");
    assert.ok(/Unable to load first tile/.test(harness.errorCalls[0]));
  }),
];

async function run() {
  var failed = 0;
  for (var i = 0; i < tests.length; i += 1) {
    var current = tests[i];
    try {
      await current.fn();
      console.log("PASS", current.name);
    } catch (error) {
      failed += 1;
      console.error("FAIL", current.name);
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
