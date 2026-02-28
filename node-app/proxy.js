"use strict";
var http = require("http");
var https = require("https");
var dns = require("dns");
var net = require("net");
var URL = require("url").URL;

var REQUEST_TIMEOUT_MS = 20000;
var MAX_REDIRECTS = 3;
var MAX_COOKIE_LENGTH = 8192;
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
var HOP_BY_HOP_HEADERS = {
  "connection": true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  "te": true,
  "trailers": true,
  "transfer-encoding": true,
  "upgrade": true,
  "set-cookie": true,
  "set-cookie2": true,
  "access-control-allow-origin": true,
  "access-control-expose-headers": true,
  "content-length": true,
  "location": true
};
var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
var httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

function failRes(res, statusCode, message) {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message + "\n");
    return;
  }
  res.end(message + "\n");
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Set-Cookie");
  res.setHeader("Vary", "Origin");
}

function sanitizeCookies(cookieHeader) {
  if (!cookieHeader) return "";
  var sanitized = String(cookieHeader).replace(/[\r\n]/g, "");
  if (sanitized.length > MAX_COOKIE_LENGTH) {
    throw new Error("Cookie header is too long.");
  }
  return sanitized;
}

function isPrivateIPv4(ip) {
  var parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(function (x) { return x < 0 || x > 255; })) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0) return true;
  if (parts[0] >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  var lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.indexOf("fe80:") === 0) return true;
  if (lower.indexOf("fc") === 0 || lower.indexOf("fd") === 0) return true;
  if (lower.indexOf("::ffff:") === 0) {
    var v4 = lower.slice(7);
    if (net.isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  return false;
}

function isPublicIp(ip) {
  var family = net.isIP(ip);
  if (family === 4) return !isPrivateIPv4(ip);
  if (family === 6) return !isPrivateIPv6(ip);
  return false;
}

function isDisallowedHostname(hostname) {
  var lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "localhost." ||
    /\.local$/.test(lower) ||
    /\.internal$/.test(lower)
  );
}

function validateTargetURL(rawURL) {
  var parsed;
  try {
    parsed = new URL(rawURL);
  } catch (_) {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (!parsed.hostname) {
    throw new Error("Missing URL hostname.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials in target URLs are not allowed.");
  }
  if (parsed.port) {
    var port = Number(parsed.port);
    if (!port || port < 1 || port > 65535) {
      throw new Error("Invalid target port.");
    }
  }
  if (isDisallowedHostname(parsed.hostname)) {
    throw new Error("Target hostname is not allowed.");
  }
  return parsed;
}

function ensurePublicResolution(parsedURL) {
  return new Promise(function (resolve, reject) {
    var host = parsedURL.hostname;
    if (net.isIP(host)) {
      if (!isPublicIp(host)) return reject(new Error("Private and reserved IPs are blocked."));
      return resolve();
    }
    dns.lookup(host, { all: true, verbatim: true }, function (err, addresses) {
      if (err || !addresses || addresses.length === 0) {
        return reject(new Error("Unable to resolve target host."));
      }
      var invalid = addresses.some(function (entry) { return !isPublicIp(entry.address); });
      if (invalid) {
        return reject(new Error("Target host resolves to a private or reserved IP."));
      }
      resolve();
    });
  });
}

function extractCookiePairs(setCookie) {
  if (!setCookie) return "";
  var cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies
    .map(function (cookie) {
      var match = String(cookie).match(/^[^;]*/);
      return match ? match[0] + ";" : "";
    })
    .join("");
}

function copyResponseHeaders(upstreamHeaders, res) {
  Object.keys(upstreamHeaders).forEach(function (name) {
    var lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS[lower]) return;
    var value = upstreamHeaders[name];
    if (typeof value === "undefined") return;
    res.setHeader(name, value);
  });
}

function resolveRedirectURL(location, currentURL) {
  try {
    return new URL(location, currentURL).toString();
  } catch (_) {
    return null;
  }
}

function proxyRequest(rawURL, cookieHeader, res, redirectsLeft) {
  var parsedURL;
  try {
    parsedURL = validateTargetURL(rawURL);
  } catch (err) {
    failRes(res, 400, err.message);
    return;
  }

  ensurePublicResolution(parsedURL).then(function () {
    var client = parsedURL.protocol === "https:" ? https : http;
    var reqHeaders = {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Referer": parsedURL.toString(),
      "Origin": parsedURL.origin
    };
    if (cookieHeader) reqHeaders.Cookie = cookieHeader;

    var upstreamReq = client.request(
      {
        protocol: parsedURL.protocol,
        hostname: parsedURL.hostname,
        port: parsedURL.port || (parsedURL.protocol === "https:" ? 443 : 80),
        path: parsedURL.pathname + parsedURL.search,
        method: "GET",
        headers: reqHeaders,
        timeout: REQUEST_TIMEOUT_MS,
        agent: parsedURL.protocol === "https:" ? httpsAgent : httpAgent
      },
      function (upstreamRes) {
        var statusCode = upstreamRes.statusCode || 500;
        var location = upstreamRes.headers.location;
        var isRedirect =
          statusCode >= 300 &&
          statusCode < 400 &&
          typeof location === "string" &&
          location.length > 0;

        if (isRedirect) {
          upstreamRes.resume();
          if (redirectsLeft <= 0) {
            failRes(res, 502, "Too many redirects.");
            return;
          }
          var nextURL = resolveRedirectURL(location, parsedURL.toString());
          if (!nextURL) {
            failRes(res, 502, "Invalid redirect URL.");
            return;
          }
          proxyRequest(nextURL, cookieHeader, res, redirectsLeft - 1);
          return;
        }

        if (!res.headersSent) {
          res.statusCode = statusCode;
          copyResponseHeaders(upstreamRes.headers, res);
          var cookiePairs = extractCookiePairs(upstreamRes.headers["set-cookie"]);
          if (cookiePairs) res.setHeader("X-Set-Cookie", cookiePairs);
          setCorsHeaders(res);
        }
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on("timeout", function () {
      upstreamReq.destroy(new Error("Upstream request timed out."));
    });
    upstreamReq.on("error", function (err) {
      failRes(res, 502, err.message || String(err));
    });
    upstreamReq.end();
  }).catch(function (err) {
    failRes(res, 403, err.message || String(err));
  });
}

var server = new http.Server();
server.on("request", function(req, res) {
  setCorsHeaders(res);

  if (req.method !== "GET") {
    failRes(res, 405, "Only GET requests are supported.");
    return;
  }

  var parsedRequestURL;
  try {
    parsedRequestURL = new URL(req.url, "http://localhost");
  } catch (_) {
    failRes(res, 400, "Invalid request URL.");
    return;
  }

  var rawTargetURL = parsedRequestURL.searchParams.get("url");
  if (!rawTargetURL) {
    failRes(res, 400, "Missing required query parameter: url");
    return;
  }

  var cookieHeader;
  try {
    cookieHeader = sanitizeCookies(parsedRequestURL.searchParams.get("cookies") || "");
  } catch (err) {
    failRes(res, 400, err.message);
    return;
  }

  console.log("Requested: " + rawTargetURL);
  proxyRequest(rawTargetURL, cookieHeader, res, MAX_REDIRECTS);
});

module.exports = server;
// Start the server only if called as a standalone script
if (require.main === module) {
  server.listen(8181);
  console.log("listening on port 8181");
}
