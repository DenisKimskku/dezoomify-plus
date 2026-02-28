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
      url: "http://localhost:9876/base/tests/images/issue_81/image/ImageProperties.xml",
    },
    {
      name: "Zoomify local fixture (tile URL)",
      url: "http://localhost:9876/base/tests/images/issue_81/image/TileGroup0/3-1-6.jpg",
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

QUnit.module("Image loads", {
  beforeEach: function (assert) {
    var done = assert.async();
    var that = this;

    var iframe = document.createElement("iframe");
    iframe.src = BASE + "/index.html?app_runtime=0&worker_render=0";
    document.body.appendChild(iframe);
    that.iframe = iframe;

    var testwin = iframe.contentWindow;

    testwin.onload = function() {
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
      done();
    }
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
    ZoomManager.reset();
    ZoomManager.open(test.url);
    ZoomManager.loadEnd = function () {
      ZoomManager.reset();
      assert.ok(true, "Image loaded")
      done();
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
            done();
          }
          img.src = url;
      } else {
        ZoomManager.status.loaded ++;
        UI.canvas.width = UI.canvas.height = UI.canvas.style.width = UI.canvas.style.height = 0;
      }
    };
    testwin.onerror = function(err, source, lineno) {
      assert.ok(false, "Dezoomify bug " + err + "\n" + source + ':' + lineno);
      done();
    }
  });
});
