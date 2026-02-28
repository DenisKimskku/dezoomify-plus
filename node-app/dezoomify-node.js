"use strict";
var jsdom = require("jsdom");
var Canvas = require("canvas");
var http = require("http");
var https = require("https");
var URL = require("url").URL;
var fs = require("fs");
var path = require("path");

var PROXY_PORT = 8181;
var proxy_server = require("./proxy.js").listen(PROXY_PORT);
var TILE_TIMEOUT_MS = 20000;
var MAX_TILE_REDIRECTS = 2;

var DEZOOMIFY_PATH = path.dirname(__dirname);

if (process.argv.length < 3) {
  console.error("Usage: %s URL [filename.jpg]", process.argv[1]);
  process.exit(1);
} else {
  var target_url = process.argv[2];
  var target_filename = process.argv[3] || 'dezoomed.jpg';
  console.log("Dezooming '%s' and saving it to '%s'...", target_url, target_filename);
}

var virtualConsole = new jsdom.VirtualConsole().sendTo(console);

function resolveRedirectURL(location, baseURL) {
  try {
    return new URL(location, baseURL).toString();
  } catch (_) {
    return null;
  }
}

function fetchTileBuffer(rawURL, redirectsLeft, callback) {
  var parsedURL;
  try {
    parsedURL = new URL(rawURL);
  } catch (err) {
    callback(err);
    return;
  }

  var client = parsedURL.protocol === "https:" ? https : http;
  var req = client.request(
    {
      protocol: parsedURL.protocol,
      hostname: parsedURL.hostname,
      port: parsedURL.port || (parsedURL.protocol === "https:" ? 443 : 80),
      path: parsedURL.pathname + parsedURL.search,
      method: "GET",
      timeout: TILE_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": rawURL,
      },
    },
    function onResponse(res) {
      var statusCode = res.statusCode || 0;
      var location = res.headers.location;
      var isRedirect =
        statusCode >= 300 &&
        statusCode < 400 &&
        typeof location === "string" &&
        location.length > 0;

      if (isRedirect) {
        res.resume();
        if (redirectsLeft <= 0) {
          callback(new Error("Too many redirects while loading tile: " + rawURL));
          return;
        }
        var redirectURL = resolveRedirectURL(location, rawURL);
        if (!redirectURL) {
          callback(new Error("Invalid redirect URL while loading tile: " + rawURL));
          return;
        }
        fetchTileBuffer(redirectURL, redirectsLeft - 1, callback);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        callback(new Error("Unexpected tile status code " + statusCode + " for " + rawURL));
        return;
      }

      var chunks = [];
      res.on("data", function (chunk) {
        chunks.push(chunk);
      });
      res.on("end", function () {
        callback(null, Buffer.concat(chunks));
      });
    }
  );

  req.on("timeout", function () {
    req.destroy(new Error("Tile request timed out: " + rawURL));
  });
  req.on("error", callback);
  req.end();
}

function onload(window) {
  var ZoomManager = window.ZoomManager, UI = window.UI;
  UI.error = function error(err) {
    console.error(err);
    proxy_server.close();
  }
  UI.loadEnd = function loadEnd() {
    var out = fs.createWriteStream(target_filename);
    UI.canvas.jpegStream().pipe(out);
    console.log("Saved the image to " + target_filename);
    proxy_server.close();
  }
  UI.updateProgress = function (progress, text) {
    console.log(parseInt(progress) + "% : " + text);
  }
  UI.setupRendering = function (data) {
    UI.canvas = new Canvas.Canvas(data.width, data.height);
    UI.ctx = UI.canvas.getContext("2d");
  };
  ZoomManager.addTile = function addTile(url, x, y, nTries) {
    var onLoaded = arguments[4];
    var onFailed = arguments[5];
    if (nTries === (void 0)) nTries = 0;
    //Request a tile from the server, and prints add it to the canvas when it's received
    fetchTileBuffer(url, MAX_TILE_REDIRECTS, function tileLoaded(err, buffer) {
      if (err) {
        if (nTries >= 10) {
          if (typeof onFailed === "function") onFailed(url);
          return ZoomManager.error("Error while loading tile: " + url + "\n" + err);
        } else {
          console.log("Request failed, retrying :" + nTries);
          return setTimeout(
            addTile,
            Math.pow(2, nTries) * 100,
            url,
            x,
            y,
            nTries + 1,
            onLoaded,
            onFailed
          );
        }
      }
      try {
        var img = new Canvas.Image;
        img.src = buffer;
        UI.drawTile(img, x, y);
        ZoomManager.status.loaded++;
        if (typeof onLoaded === "function") onLoaded();
      } catch (decodeError) {
        if (nTries >= 10) {
          if (typeof onFailed === "function") onFailed(url);
          return ZoomManager.error("Error while decoding tile: " + url + "\n" + decodeError);
        }
        return setTimeout(
          addTile,
          Math.pow(2, nTries) * 100,
          url,
          x,
          y,
          nTries + 1,
          onLoaded,
          onFailed
        );
      }
    });
  };
  ZoomManager.proxy_url = "http://127.0.0.1:" + PROXY_PORT;
  ZoomManager.open(target_url);
}

jsdom.JSDOM.fromFile(path.join(DEZOOMIFY_PATH, "index.html"), {
  virtualConsole,
  runScripts: "dangerously",
  resources: "usable",
}).then(function (dom) {
  dom.window.onload = onload.bind(null, dom.window)
});
