/**
 * This is a cloudflare worker for dezoomify
 */

const MAX_REDIRECT = 3;
const MAX_COOKIE_LENGTH = 8192;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function addCorsHeaders(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "X-Set-Cookie");
  headers.set("Vary", "Origin");
}

function errorResponse(status, message) {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  addCorsHeaders(headers);
  return new Response(message, { status, headers });
}

function sanitizeCookies(cookieHeader) {
  if (!cookieHeader) return "";
  const sanitized = cookieHeader.replace(/[\r\n]/g, "");
  if (sanitized.length > MAX_COOKIE_LENGTH) {
    throw new Error("Cookie header is too long.");
  }
  return sanitized;
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0 || parts[0] >= 224) return true;
  return false;
}

function isPrivateIPv6(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) {
    return isPrivateIPv4(lower.slice(7));
  }
  return false;
}

function isIpLiteral(hostname) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(":");
}

function isPrivateOrReservedLiteralIP(hostname) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return isPrivateIPv4(hostname);
  }
  return isPrivateIPv6(hostname);
}

function validateTargetURL(rawUrl) {
  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch (_) {
    throw new Error("Invalid URL.");
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (!targetUrl.hostname) {
    throw new Error("Missing URL hostname.");
  }
  if (targetUrl.username || targetUrl.password) {
    throw new Error("Credentials in target URLs are not allowed.");
  }
  const lowerHost = targetUrl.hostname.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost === "localhost." ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal")
  ) {
    throw new Error("Target hostname is not allowed.");
  }
  if (isIpLiteral(targetUrl.hostname) && isPrivateOrReservedLiteralIP(targetUrl.hostname)) {
    throw new Error("Private and reserved IPs are blocked.");
  }
  return targetUrl;
}

function extractCookiePair(rawCookieHeader) {
  if (!rawCookieHeader) return "";
  const match = rawCookieHeader.match(/^[^;]*/);
  return match ? `${match[0]};` : "";
}

function buildUpstreamRequest(targetUrl, cookieHeader) {
  const headers = new Headers({
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Origin": targetUrl.origin,
    "Referer": targetUrl.toString(),
  });
  if (cookieHeader) headers.set("Cookie", cookieHeader);

  return new Request(targetUrl.toString(), {
    method: "GET",
    headers,
    redirect: "manual",
  });
}

async function fetchWithRedirects(rawTargetUrl, cookieHeader) {
  let currentTarget = rawTargetUrl;
  for (let i = 0; i <= MAX_REDIRECT; i++) {
    const validatedTarget = validateTargetURL(currentTarget);
    const upstreamRequest = buildUpstreamRequest(validatedTarget, cookieHeader);
    const response = await fetch(upstreamRequest);

    const location = response.headers.get("Location");
    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      !!location;
    if (!isRedirect) return response;

    if (i === MAX_REDIRECT) {
      throw new Error("Too many redirects.");
    }
    try {
      currentTarget = new URL(location, validatedTarget).toString();
    } catch (_) {
      throw new Error("Invalid redirect URL.");
    }
  }
  throw new Error("Too many redirects.");
}

/**
 * Respond to the request
 * @param {Request} request
 */
async function handleRequest(request) {
  if (request.method !== "GET") {
    return errorResponse(405, "Only GET requests are supported.");
  }

  const url = new URL(request.url);
  const rawTargetUrl = url.searchParams.get("url");
  if (!rawTargetUrl) {
    return errorResponse(400, "Missing required query parameter: url");
  }

  const cookieHeader = sanitizeCookies(url.searchParams.get("cookies") || "");
  const upstreamResponse = await fetchWithRedirects(rawTargetUrl, cookieHeader);
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("Set-Cookie");
  responseHeaders.delete("Location");

  const responseCookie = upstreamResponse.headers.get("Set-Cookie");
  const cookiePair = extractCookiePair(responseCookie);
  if (cookiePair) responseHeaders.set("X-Set-Cookie", cookiePair);
  addCorsHeaders(responseHeaders);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

/**
 * Handle a fetch event
 * @param {Error} error
 */
async function handleError(error) {
  console.error(error);
  return errorResponse(500, error.toString());
}

export default {
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch (error) {
      return handleError(error);
    }
  },
};
