"use strict";

var assert = require("assert");
var dnsPromises = require("dns").promises;

function test(name, fn) {
  return { name: name, fn: fn };
}

function createReq(options) {
  var opts = options || {};
  return {
    method: opts.method || "GET",
    query: opts.query || {},
    headers: opts.headers || {},
    socket: { remoteAddress: opts.remoteAddress || "203.0.113.1" },
  };
}

function createRes() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    setHeader: function (name, value) {
      this.headers[name] = value;
    },
    end: function (value) {
      if (typeof value === "undefined" || value === null) {
        this.body = Buffer.alloc(0);
        return;
      }
      if (Buffer.isBuffer(value)) {
        this.body = value;
        return;
      }
      this.body = Buffer.from(String(value));
    },
  };
}

function getBodyText(res) {
  return Buffer.isBuffer(res.body) ? res.body.toString("utf8") : String(res.body || "");
}

function makeHeaders(map) {
  var store = {};
  Object.keys(map || {}).forEach(function (key) {
    store[String(key).toLowerCase()] = String(map[key]);
  });
  return {
    get: function (name) {
      var key = String(name || "").toLowerCase();
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    forEach: function (callback) {
      Object.keys(store).forEach(function (key) {
        callback(store[key], key);
      });
    },
    getSetCookie: function () {
      var value = this.get("set-cookie");
      return value ? [value] : [];
    },
  };
}

function restoreGlobalFetch(previousFetch) {
  if (typeof previousFetch === "undefined") {
    try {
      delete global.fetch;
    } catch (_) {
      global.fetch = undefined;
    }
    return;
  }
  global.fetch = previousFetch;
}

async function withProxyHandler(envPatch, runFn) {
  var mergedPatch = Object.assign({ OBSERVABILITY_ENABLED: "false" }, envPatch || {});
  var previous = {};
  Object.keys(mergedPatch).forEach(function (key) {
    previous[key] = process.env[key];
    if (mergedPatch[key] === null) delete process.env[key];
    else process.env[key] = String(mergedPatch[key]);
  });

  var proxyPath = require.resolve("../api/proxy");
  delete require.cache[proxyPath];
  var handler = require(proxyPath);

  try {
    return await runFn(handler);
  } finally {
    Object.keys(mergedPatch).forEach(function (key) {
      if (typeof previous[key] === "undefined") delete process.env[key];
      else process.env[key] = previous[key];
    });
    delete require.cache[proxyPath];
  }
}

var tests = [
  test("rejects non-GET methods", async function () {
    await withProxyHandler({}, async function (handler) {
      var req = createReq({ method: "POST" });
      var res = createRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 405);
      assert.ok(/Only GET requests/.test(getBodyText(res)));
    });
  }),

  test("returns 400 on missing url", async function () {
    await withProxyHandler({}, async function (handler) {
      var req = createReq({ method: "GET", query: {} });
      var res = createRes();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.ok(/Missing required query parameter: url/.test(getBodyText(res)));
    });
  }),

  test("enforces API auth when required", async function () {
    await withProxyHandler(
      {
        API_AUTH_REQUIRED: "true",
        API_DISABLE_ANON: null,
        API_KEY_CONFIG_JSON: null,
      },
      async function (handler) {
        var req = createReq({
          method: "GET",
          query: { url: "https://example.com/image" },
        });
        var res = createRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 401);
        assert.ok(/Missing API key/.test(getBodyText(res)));
      }
    );
  }),

  test("rejects invalid API key", async function () {
    await withProxyHandler(
      {
        API_AUTH_REQUIRED: "false",
        API_KEY_CONFIG_JSON: JSON.stringify({
          valid_key_1: { label: "plan-1", minuteQuota: 100, dailyQuota: 1000 },
        }),
      },
      async function (handler) {
        var req = createReq({
          method: "GET",
          query: { url: "https://example.com/image", api_key: "bad_key" },
        });
        var res = createRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 401);
        assert.ok(/Invalid API key/.test(getBodyText(res)));
      }
    );
  }),

  test("blocks private literal target URLs", async function () {
    var originalFetch = global.fetch;
    try {
      global.fetch = async function () {
        throw new Error("fetch should not be called");
      };
      await withProxyHandler({}, async function (handler) {
        var req = createReq({
          method: "GET",
          query: { url: "http://127.0.0.1/internal" },
        });
        var res = createRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 502);
        assert.ok(/Private and reserved IPs are blocked/.test(getBodyText(res)));
      });
    } finally {
      restoreGlobalFetch(originalFetch);
    }
  }),

  test("passes through valid upstream response and emits limit headers", async function () {
    var previousLookup = dnsPromises.lookup;
    var previousFetch = global.fetch;
    try {
      dnsPromises.lookup = async function () {
        return [{ address: "93.184.216.34", family: 4 }];
      };
      global.fetch = async function () {
        return {
          status: 200,
          headers: makeHeaders({
            "content-type": "text/plain",
            "set-cookie": "sess=abc123; Path=/; HttpOnly",
          }),
          arrayBuffer: async function () {
            return Buffer.from("ok");
          },
        };
      };

      await withProxyHandler({}, async function (handler) {
        var req = createReq({
          method: "GET",
          query: { url: "https://example.com/resource" },
          remoteAddress: "198.51.100.22",
        });
        var res = createRes();
        await handler(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(getBodyText(res), "ok");
        assert.strictEqual(res.headers["X-Set-Cookie"], "sess=abc123;");
        assert.ok(res.headers["X-RateLimit-Limit"]);
        assert.ok(res.headers["X-Quota-Minute-Limit"]);
        assert.ok(res.headers["X-Quota-Daily-Limit"]);
      });
    } finally {
      dnsPromises.lookup = previousLookup;
      restoreGlobalFetch(previousFetch);
    }
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
