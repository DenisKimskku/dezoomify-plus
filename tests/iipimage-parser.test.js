"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

function test(name, fn) {
  return { name: name, fn: fn };
}

function loadIIPImageHarness(options) {
  var opts = options || {};
  var addedDezoomer = null;
  var readyCalls = [];
  var getFileCalls = [];

  var context = {
    console: console,
    ZoomManager: {
      getFile: function (url, params, callback) {
        getFileCalls.push({ url: url, params: params });
        if (typeof opts.getFile === "function") {
          return opts.getFile(url, params, callback);
        }
        callback("", {});
      },
      resolveRelative: function (rel, base) {
        return new URL(rel, base).toString();
      },
      readyToRender: function (data) {
        readyCalls.push(data);
      },
      addDezoomer: function (dezoomer) {
        addedDezoomer = dezoomer;
      },
    },
  };

  var source = fs.readFileSync(path.join(__dirname, "..", "dezoomers", "iipimage.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "iipimage.js" });

  return {
    dezoomer: addedDezoomer,
    readyCalls: readyCalls,
    getFileCalls: getFileCalls,
  };
}

var tests = [
  test("national gallery parser surfaces explicit error when image metadata is missing", function () {
    var harness = loadIIPImageHarness({
      getFile: function (_url, _params, callback) {
        callback("<html><body>no image metadata here</body></html>", {});
      },
    });

    assert.throws(function () {
      harness.dezoomer.findFile("https://www.nationalgallery.org.uk/paintings/example", function () {});
    }, /Unable to locate National Gallery image metadata/);
  }),

  test("national gallery parser surfaces explicit error when image metadata JSON is invalid", function () {
    var harness = loadIIPImageHarness({
      getFile: function (_url, _params, callback) {
        callback("<script>image:\"\\u00" + "ZZ\"</script>", {});
      },
    });

    assert.throws(function () {
      harness.dezoomer.findFile("https://www.nationalgallery.org.uk/paintings/example", function () {});
    }, /Invalid National Gallery image metadata/);
  }),

  test("open defaults to zoom level zero when resolution number is missing", function () {
    var harness = loadIIPImageHarness({
      getFile: function (_url, _params, callback) {
        callback("Max-size:1000 800\nTile-size:256 256", {});
      },
    });

    harness.dezoomer.open("https://example.com/iipsrv.fcgi?FIF=/img.jp2");
    assert.strictEqual(harness.readyCalls.length, 1);
    assert.strictEqual(harness.readyCalls[0].maxZoomLevel, 0);
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
