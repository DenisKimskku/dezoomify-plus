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
        if (opts.getFileMap && Object.prototype.hasOwnProperty.call(opts.getFileMap, url)) {
          callback(opts.getFileMap[url], {});
          return;
        }
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

  test("IIIF findFile supports caret-size IIIF image URLs", async function () {
    var harness = loadIIIFDezoomer({ manifest: {} });
    var found = null;
    harness.dezoomer.findFile(
      "https://iiif.micr.io/WjxgV/full/^1024,538/0/default.webp",
      function (url) {
        found = url;
      }
    );
    assert.strictEqual(found, "https://iiif.micr.io/WjxgV/info.json");
    assert.strictEqual(harness.getFileCalls.length, 0, "direct IIIF URL should not require HTML fetch");
  }),

  test("IIIF findFile resolves Polona item URLs to page IIIF manifests", async function () {
    var itemId = "9388882";
    var newId = "522bfc2f-60a8-4548-85c9-6f41e621fc34";
    var idURL = "https://polona.pl/api/library-object-query/digital-objects/new-id/" + itemId;
    var contentsURL = "https://polona.pl/api/library-object-query/digital-objects/" + newId + "/contents";
    var harness = loadIIIFDezoomer({
      manifest: {},
      getFileMap: {
        [idURL]: newId,
        [contentsURL]: {
          pages: [
            {
              content: [{ iiifImageAPIManifest: "https://polona.pl/iiif/2/page-0/info.json" }],
            },
            {
              content: [{ iiifImageAPIManifest: "https://polona.pl/iiif/2/page-1/info.json" }],
            },
          ],
        },
      },
    });

    var found = null;
    harness.dezoomer.findFile("https://polona.pl/item/" + itemId + "/1/", function (url) {
      found = url;
    });

    assert.strictEqual(found, "https://polona.pl/iiif/2/page-1/info.json");
    assert.strictEqual(harness.getFileCalls.length, 2);
    assert.strictEqual(harness.getFileCalls[0].url, idURL);
    assert.strictEqual(harness.getFileCalls[1].url, contentsURL);
  }),

  test("IIIF findFile resolves presentation manifest URLs to image info.json", async function () {
    var manifestURL = "https://bl.digirati.io/iiif/ark:/81055/vdc_100104060212.0x000001";
    var imageService = "https://bl.digirati.io/images/ark:/81055/vdc_100104060214.0x000001";
    var harness = loadIIIFDezoomer({
      manifest: {},
      getFileMap: {
        [manifestURL]: {
          "@context": "http://iiif.io/api/presentation/3/context.json",
          type: "Manifest",
          items: [
            {
              items: [
                {
                  items: [
                    {
                      body: {
                        service: [{ id: imageService }],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    var found = null;
    harness.dezoomer.findFile(manifestURL, function (url) {
      found = url;
    });

    assert.strictEqual(found, imageService + "/info.json");
    assert.strictEqual(harness.getFileCalls.length, 1);
    assert.strictEqual(harness.getFileCalls[0].url, manifestURL);
  }),

  test("IIIF findFile resolves uv manifest query URLs", async function () {
    var manifestURL = "https://bl.digirati.io/iiif/ark:/81055/vdc_100104060212.0x000001";
    var imageService = "https://bl.digirati.io/images/ark:/81055/vdc_100104060214.0x000001";
    var harness = loadIIIFDezoomer({
      manifest: {},
      getFileMap: {
        [manifestURL]: {
          items: [
            {
              items: [
                {
                  items: [
                    {
                      body: {
                        service: [{ "@id": imageService }],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    var found = null;
    harness.dezoomer.findFile(
      "https://iiif.bl.uk/uv/#?manifest=" + encodeURIComponent(manifestURL),
      function (url) {
        found = url;
      }
    );

    assert.strictEqual(found, imageService + "/info.json");
    assert.strictEqual(harness.getFileCalls.length, 1);
    assert.strictEqual(harness.getFileCalls[0].url, manifestURL);
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
