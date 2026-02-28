(function () {
  "use strict";

  function toSingle(value) {
    return Array.isArray(value) ? value[0] : value;
  }

  function parseJSONSafe(response) {
    if (!response || typeof response.json !== "function") {
      return Promise.resolve(null);
    }
    return response.json().catch(function () {
      return null;
    });
  }

  function extractErrorMessage(payload, fallbackMessage) {
    if (payload && typeof payload.error === "string" && payload.error) return payload.error;
    if (payload && typeof payload.message === "string" && payload.message) return payload.message;
    return fallbackMessage || "Request failed.";
  }

  function classifyStatus(statusCode) {
    var status = parseInt(statusCode, 10) || 0;
    if (status === 401) return "unauthorized";
    if (status === 404) return "not_found";
    if (status === 405 || status === 503) return "unavailable";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "server_error";
    if (status >= 400) return "client_error";
    return "ok";
  }

  function parseRetryAfterHeader(value) {
    var raw = String(toSingle(value) || "").trim();
    if (!raw) return 0;
    var asSeconds = parseInt(raw, 10);
    if (isFinite(asSeconds) && asSeconds > 0) return asSeconds;
    var dateTs = Date.parse(raw);
    if (!isFinite(dateTs)) return 0;
    return Math.max(Math.ceil((dateTs - Date.now()) / 1000), 0);
  }

  function buildAuthedURL(basePath, queryPairs, apiKey) {
    var path = String(basePath || "");
    var pairs = Array.isArray(queryPairs) ? queryPairs.slice() : [];
    var key = String(apiKey || "").trim();
    if (key) {
      pairs.push(["api_key", key]);
    }
    if (!pairs.length) return path;
    var encoded = pairs.map(function (pair) {
      return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
    }).join("&");
    return path + "?" + encoded;
  }

  async function requestJSON(url, options) {
    var opts = options && typeof options === "object" ? options : {};
    var fetchOptions = {
      method: String(opts.method || "GET"),
      credentials: opts.credentials || "same-origin",
      cache: opts.cache || "no-store",
      headers: opts.headers && typeof opts.headers === "object" ? opts.headers : {},
    };
    if (Object.prototype.hasOwnProperty.call(opts, "body")) {
      fetchOptions.body = opts.body;
    }

    var response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        category: "network_error",
        payload: null,
        retryAfterSeconds: 0,
        message: error && error.message ? error.message : String(error),
        response: null,
      };
    }

    var payload = await parseJSONSafe(response);
    var retryAfterSeconds = parseRetryAfterHeader(
      response && response.headers && typeof response.headers.get === "function"
        ? response.headers.get("Retry-After")
        : ""
    );
    var category = classifyStatus(response.status);
    var ok = !!response.ok;
    var message = ok
      ? ""
      : extractErrorMessage(payload, "Request failed (" + response.status + ")");

    return {
      ok: ok,
      status: response.status,
      category: category,
      payload: payload,
      retryAfterSeconds: retryAfterSeconds,
      message: message,
      response: response,
    };
  }

  async function getJSON(url, options) {
    var opts = options && typeof options === "object" ? options : {};
    return requestJSON(url, {
      method: "GET",
      credentials: opts.credentials,
      cache: opts.cache,
      headers: opts.headers,
    });
  }

  async function postJSON(url, body, options) {
    var opts = options && typeof options === "object" ? options : {};
    var headers = Object.assign({}, opts.headers || {}, {
      "Content-Type": "application/json",
    });
    return requestJSON(url, {
      method: "POST",
      credentials: opts.credentials,
      cache: opts.cache,
      headers: headers,
      body: JSON.stringify(body || {}),
    });
  }

  window.dezoomifyHttpClient = {
    buildAuthedURL: buildAuthedURL,
    classifyStatus: classifyStatus,
    extractErrorMessage: extractErrorMessage,
    parseJSONSafe: parseJSONSafe,
    parseRetryAfterHeader: parseRetryAfterHeader,
    requestJSON: requestJSON,
    getJSON: getJSON,
    postJSON: postJSON,
  };
})();
