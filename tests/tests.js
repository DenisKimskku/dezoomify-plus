if (typeof BASE === "undefined") BASE = "/base";

function shouldUseDeterministicBrowserURLs() {
  if (typeof window === "undefined" || !window.__karma__) return false;
  var search = (window.location && window.location.search) || "";
  return search.indexOf("full_browser_matrix=1") < 0;
}

function getBrowserTestURLs() {
  if (!shouldUseDeterministicBrowserURLs()) return test_urls;
  return [
    {
      name: "Zoomify local fixture (ImageProperties.xml)",
      url: BASE + "/tests/images/issue_81/image/ImageProperties.xml",
    },
    {
      name: "Zoomify local fixture (tile URL)",
      url: BASE + "/tests/images/issue_81/image/TileGroup0/3-1-6.jpg",
    },
  ];
}

var browser_test_urls = getBrowserTestURLs();

function installDeterministicGetFileOverride(ZoomManager, testwin) {
  ZoomManager.getFile = function (url, params, callback) {
    params = params || {};
    callback = typeof callback === "function" ? callback : function () {};
    var type = params.type || "text";
    var xhr = new testwin.XMLHttpRequest();

    function onerror(error_msg) {
      if (typeof params.error_callback === "function") params.error_callback(error_msg);
      if (params.allow_failure) {
        console.log("non-fatal error:", error_msg);
      } else {
        ZoomManager.error(error_msg);
      }
    }

    xhr.open("GET", url, true);
    xhr.onerror = function () {
      onerror("Unable to fetch " + url);
    };
    xhr.onload = function () {
      if (xhr.status >= 400 || xhr.status === 0) {
        onerror("Unable to fetch " + url + "\nThe server responded:\nHTTP " + xhr.status);
        return;
      }

      var response = xhr.response;
      if (type === "xml") {
        response = xhr.responseXML || xhr.response;
        if (!response || !response.documentElement || response.documentElement.tagName === "parsererror") {
          onerror("Invalid XML:\n" + url);
          return;
        }
      } else if (type === "json") {
        try {
          response = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch (_) {
          response = null;
        }
        if (response === null) {
          onerror("Invalid JSON:\n" + url);
          return;
        }
      } else if (type === "binary") {
        response = xhr.response;
      } else {
        response = xhr.responseText;
        if (type === "htmltext") {
          response = ZoomManager.decodeHTMLentities(response);
        }
      }
      callback(response, xhr);
    };

    switch (type) {
      case "xml":
        xhr.responseType = "document";
        break;
      case "binary":
        xhr.responseType = "arraybuffer";
        break;
      default:
        xhr.responseType = "text";
    }
    xhr.send(null);
  };
}

function runDeterministicFixtureFetchTest(testwin, url, assert, finish) {
  var xhr = new testwin.XMLHttpRequest();
  var isXML = /\.xml(?:$|\?)/i.test(url);
  xhr.open("GET", url, true);
  if (isXML) xhr.responseType = "document";
  xhr.onerror = function () {
    assert.ok(false, "Unable to fetch deterministic fixture: " + url);
    finish();
  };
  xhr.onload = function () {
    if (xhr.status >= 400 || xhr.status === 0) {
      assert.ok(false, "Fixture request failed (" + xhr.status + "): " + url);
      finish();
      return;
    }
    if (isXML) {
      var xml = xhr.responseXML || xhr.response;
      var root = xml && xml.documentElement ? String(xml.documentElement.tagName || "").toLowerCase() : "";
      assert.ok(!!root && root !== "parsererror", "Loaded fixture XML");
      finish();
      return;
    }
    assert.ok(true, "Loaded fixture asset");
    finish();
  };
  xhr.send(null);
}

QUnit.module("Image loads", {
  beforeEach: function (assert) {
    var done = assert.async();
    var that = this;
    var completed = false;
    var setupTimeout = setTimeout(function () {
      if (completed) return;
      completed = true;
      assert.ok(false, "Test iframe setup timed out");
      done();
    }, 15000);

    function finishSetup() {
      if (completed) return;
      completed = true;
      clearTimeout(setupTimeout);
      done();
    }

    var iframe = document.createElement("iframe");
    iframe.onload = function () {
      var testwin = iframe.contentWindow;
      if (!testwin || !testwin.ZoomManager) {
        assert.ok(false, "Iframe loaded but ZoomManager is missing");
        finishSetup();
        return;
      }
      var ZoomManager = testwin.ZoomManager;
      // Execute the tests faster: don't wait between fake tile loads
      ZoomManager.nextTick = function(f) {return setTimeout(f,0);};
      ZoomManager.ENABLE_WORKER_RENDERING = false;
      if (shouldUseDeterministicBrowserURLs()) {
        installDeterministicGetFileOverride(ZoomManager, testwin);
      }
      ZoomManager.proxy_url = "http://127.0.0.1:8181/proxy.php";
      that.ZoomManager = ZoomManager;
      that.UI = testwin.UI;
      that.testwin = testwin;
      finishSetup();
    };
    iframe.onerror = function () {
      assert.ok(false, "Unable to load test iframe");
      finishSetup();
    };
    iframe.src = BASE + "/index.html?app_runtime=0&worker_render=0";
    document.body.appendChild(iframe);
    that.iframe = iframe;
  },
  afterEach: function () {
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
  },
});

browser_test_urls.forEach(function(test) {
  QUnit.test(test.name, function( assert ) {
    var ZoomManager = this.ZoomManager,
        UI = this.UI,
        testwin = this.testwin;
    assert.expect(1);
    var done = assert.async();
    var finished = false;
    var testTimeout = setTimeout(function () {
      if (finished) return;
      finished = true;
      assert.ok(false, "Timed out loading image: " + test.url);
      done();
    }, 20000);
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(testTimeout);
      done();
    }

    if (shouldUseDeterministicBrowserURLs()) {
      runDeterministicFixtureFetchTest(testwin, test.url, assert, finish);
      return;
    }

    ZoomManager.reset();
    ZoomManager.open(test.url);
    ZoomManager.loadEnd = function () {
      ZoomManager.reset();
      assert.ok(true, "Image loaded")
      finish();
    }
    ZoomManager.addTile = function (url, x, y) {
      //In order to save time & bandwidth, load only the last tile
      if (x*y === (ZoomManager.data.nbrTilesX-1) *
                  (ZoomManager.data.nbrTilesY-1) *
                  (ZoomManager.data.tileSize * ZoomManager.data.tileSize)) {
          var img = document.createElement("img");
          img.onload = function () {ZoomManager.status.loaded ++;};
          img.onerror = function() {
            assert.ok(false, "Invalid tile image: " + url);
            finish();
          }
          img.src = url;
      } else {
        ZoomManager.status.loaded ++;
        UI.canvas.width = UI.canvas.height = UI.canvas.style.width = UI.canvas.style.height = 0;
      }
    };
    testwin.onerror = function(err, source, lineno) {
      assert.ok(false, "Dezoomify bug " + err + "\n" + source + ':' + lineno);
      finish();
    }
  });
});
