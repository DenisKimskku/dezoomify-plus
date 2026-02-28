"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

function test(name, fn) {
  return { name: name, fn: fn };
}

function makeDziXml(options) {
  var opts = options || {};
  return {
    getElementsByTagName: function (name) {
      if (name === "Image") {
        return [
          {
            getAttribute: function (attr) {
              if (attr === "TileSize") return String(opts.tileSize || 256);
              if (attr === "Overlap") return String(opts.overlap || 0);
              if (attr === "Format") return String(opts.format || "jpg");
              return "";
            },
          },
        ];
      }
      if (name === "Size") {
        return [
          {
            getAttribute: function (attr) {
              if (attr === "Width") return String(opts.width || 4000);
              if (attr === "Height") return String(opts.height || 3000);
              return "";
            },
          },
        ];
      }
      return [];
    },
  };
}

function loadSeadragonDezoomer(options) {
  var opts = options || {};
  var getFileCalls = [];
  var setDezoomerCalls = [];
  var openCalls = [];
  var readyCalls = [];
  var errorCalls = [];
  var addedDezoomer = null;
  var iiifDezoomer = { name: "IIIF" };

  var context = {
    console: console,
    Math: Math,
    ZoomManager: {
      getFile: function (url, params, callback) {
        getFileCalls.push({ url: url, params: params });
        if (opts.failGetFile && opts.failGetFile[url]) {
          var failOpts = params || {};
          if (typeof failOpts.error_callback === "function") {
            failOpts.error_callback(opts.failGetFile[url]);
          }
          return;
        }
        if (opts.getFileMap && Object.prototype.hasOwnProperty.call(opts.getFileMap, url)) {
          callback(opts.getFileMap[url], {});
          return;
        }
        callback("", {});
      },
      addDezoomer: function (dezoomer) {
        addedDezoomer = dezoomer;
      },
      setDezoomer: function (dezoomer) {
        setDezoomerCalls.push(dezoomer);
      },
      open: function (url) {
        openCalls.push(url);
      },
      readyToRender: function (data) {
        readyCalls.push(data);
      },
      error: function (message) {
        errorCalls.push(String(message));
      },
      dezoomersList: {
        IIIF: iiifDezoomer,
      },
    },
  };

  var source = fs.readFileSync(path.join(__dirname, "..", "dezoomers", "seadragon.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "seadragon.js" });

  return {
    dezoomer: addedDezoomer,
    getFileCalls: getFileCalls,
    setDezoomerCalls: setDezoomerCalls,
    openCalls: openCalls,
    readyCalls: readyCalls,
    errorCalls: errorCalls,
    iiifDezoomer: iiifDezoomer,
  };
}

var tests = [
  test("Seadragon BL finder prefers IIIF manifest from modern viewer HTML", function () {
    var baseURL = "http://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar";
    var manifestURL = "https://bl.digirati.io/iiif/ark:/81055/vdc_100104060212.0x000001";
    var harness = loadSeadragonDezoomer({
      getFileMap: {
        [baseURL]: '<a href="' + manifestURL + '">Open manifest</a>',
      },
    });

    var found = null;
    harness.dezoomer.findFile(baseURL, function (url) {
      found = url;
    });

    assert.strictEqual(found, manifestURL);
    assert.strictEqual(harness.getFileCalls.length, 1);
  }),

  test("Seadragon BL finder falls back to legacy proxy when HTML fetch fails", function () {
    var baseURL = "http://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar";
    var harness = loadSeadragonDezoomer({
      failGetFile: {
        [baseURL]: "fetch failed",
      },
    });

    var found = null;
    harness.dezoomer.findFile(baseURL, function (url) {
      found = url;
    });

    assert.strictEqual(found, "http://www.bl.uk/manuscripts/Proxy.ashx?view=burney_ms_276_f031ar.xml");
    assert.strictEqual(harness.getFileCalls.length, 1);
  }),

  test("Seadragon open delegates manifest URLs to IIIF dezoomer", function () {
    var harness = loadSeadragonDezoomer();
    var manifestURL = "https://bl.digirati.io/iiif/ark:/81055/vdc_100104060212.0x000001";

    harness.dezoomer.open(manifestURL);

    assert.strictEqual(harness.setDezoomerCalls.length, 1);
    assert.strictEqual(harness.setDezoomerCalls[0], harness.iiifDezoomer);
    assert.deepStrictEqual(harness.openCalls, [manifestURL]);
    assert.strictEqual(harness.getFileCalls.length, 0);
  }),

  test("Seadragon open keeps XML flow for DZI descriptors", function () {
    var dziURL = "https://example.org/test/example.dzi";
    var harness = loadSeadragonDezoomer({
      getFileMap: {
        [dziURL]: makeDziXml({
          tileSize: 512,
          overlap: 1,
          format: "png",
          width: 12000,
          height: 8000,
        }),
      },
    });

    harness.dezoomer.open(dziURL);

    assert.strictEqual(harness.readyCalls.length, 1);
    assert.strictEqual(harness.readyCalls[0].origin, "https://example.org/test/example_files/");
    assert.strictEqual(harness.readyCalls[0].tileSize, 512);
    assert.strictEqual(harness.readyCalls[0].format, "png");
    assert.strictEqual(harness.errorCalls.length, 0);
  }),
];

async function run() {
  var failures = 0;
  for (var i = 0; i < tests.length; i += 1) {
    var current = tests[i];
    try {
      await current.fn();
      console.log("PASS", current.name);
    } catch (error) {
      failures += 1;
      console.error("FAIL", current.name);
      console.error(error && error.stack ? error.stack : error);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
    console.error("Failed tests:", failures);
  } else {
    console.log("All tests passed:", tests.length);
  }
}

run();
