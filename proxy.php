<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Expose-Headers: X-Set-Cookie");
header("Vary: Origin");

const MAX_COOKIE_LENGTH = 8192;
const REQUEST_TIMEOUT_SECONDS = 20;
const MAX_REDIRECTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " .
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function fail_response($statusCode, $message) {
  http_response_code($statusCode);
  header("Content-Type: text/plain; charset=utf-8");
  echo $message;
  exit;
}

function str_ends_with_compat($haystack, $needle) {
  if ($needle === "") return true;
  return substr($haystack, -strlen($needle)) === $needle;
}

function sanitize_cookies($cookieHeader) {
  $cookieHeader = str_replace(array("\r", "\n"), "", $cookieHeader);
  if (strlen($cookieHeader) > MAX_COOKIE_LENGTH) {
    fail_response(400, "Cookie header is too long.");
  }
  return $cookieHeader;
}

function is_disallowed_hostname($hostname) {
  $hostname = strtolower($hostname);
  return $hostname === "localhost" ||
    $hostname === "localhost." ||
    str_ends_with_compat($hostname, ".local") ||
    str_ends_with_compat($hostname, ".internal");
}

function is_public_ip($ip) {
  return filter_var(
    $ip,
    FILTER_VALIDATE_IP,
    FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
  ) !== false;
}

function hostname_resolves_publicly($hostname) {
  if (filter_var($hostname, FILTER_VALIDATE_IP)) {
    return is_public_ip($hostname);
  }
  if (is_disallowed_hostname($hostname)) return false;

  $records = @dns_get_record($hostname, DNS_A + DNS_AAAA);
  if ($records === false || count($records) === 0) return false;
  foreach ($records as $record) {
    $ip = isset($record["ip"]) ? $record["ip"] :
      (isset($record["ipv6"]) ? $record["ipv6"] : null);
    if (!$ip || !is_public_ip($ip)) return false;
  }
  return true;
}

function parse_status_code($headers) {
  if (!is_array($headers) || !isset($headers[0])) return 0;
  if (preg_match("/\s(\d{3})(?:\s|$)/", $headers[0], $match)) {
    return intval($match[1]);
  }
  return 0;
}

function parse_location_header($headers) {
  if (!is_array($headers)) return null;
  foreach ($headers as $headerLine) {
    if (stripos($headerLine, "Location:") === 0) {
      return trim(substr($headerLine, 9));
    }
  }
  return null;
}

function resolve_redirect_url($location, $baseUrl) {
  if (preg_match("#^https?://#i", $location)) return $location;
  $base = parse_url($baseUrl);
  if ($base === false || !isset($base["host"])) return null;

  $scheme = isset($base["scheme"]) ? $base["scheme"] : "https";
  $authority = $scheme . "://" . $base["host"];
  if (isset($base["port"])) $authority .= ":" . $base["port"];

  if (strpos($location, "//") === 0) return $scheme . ":" . $location;
  if (strlen($location) > 0 && $location[0] === "/") return $authority . $location;

  $basePath = isset($base["path"]) ? $base["path"] : "/";
  $baseDir = preg_replace("#/[^/]*$#", "/", $basePath);
  return $authority . $baseDir . $location;
}

function open_url_stream($url, $cookieHeader) {
  $headers = array(
    "User-Agent: " . USER_AGENT,
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language: en-US,en;q=0.5",
    "Referer: " . $url
  );
  if ($cookieHeader !== "") {
    $headers[] = "Cookie: " . $cookieHeader;
  }

  $opts = array(
    "http" => array(
      "method" => "GET",
      "header" => implode("\r\n", $headers) . "\r\n",
      "timeout" => REQUEST_TIMEOUT_SECONDS,
      "ignore_errors" => true,
      "follow_location" => 0
    ),
    "ssl" => array(
      "verify_peer" => true,
      "verify_peer_name" => true
    )
  );
  $context = stream_context_create($opts);
  $last_error = null;

  set_error_handler(function($errno, $errstr, $errfile, $errline) use (&$last_error) {
    $last_error = new ErrorException($errstr, 0, $errno, $errfile, $errline);
  });
  $stream = fopen($url, "rb", false, $context);
  restore_error_handler();

  if ($stream === false) {
    $message = $last_error ? $last_error->getMessage() : "Unable to open target URL.";
    return array(null, null, $message);
  }

  $meta = stream_get_meta_data($stream);
  $wrapperData =
    (isset($meta["wrapper_data"]) && is_array($meta["wrapper_data"])) ?
      $meta["wrapper_data"] :
      array();
  return array($stream, $wrapperData, null);
}

function parse_cookie_pair($headerLine) {
  if (!preg_match("/^Set-Cookie:\s*([^;]+)/i", $headerLine, $match)) return null;
  return $match[1] . ";";
}

$targetUrl = isset($_GET["url"]) ? trim($_GET["url"]) : "";
if ($targetUrl === "") {
  fail_response(400, "Missing required query parameter: url");
}

$parsedTarget = parse_url($targetUrl);
if ($parsedTarget === false || !isset($parsedTarget["scheme"]) || !isset($parsedTarget["host"])) {
  fail_response(400, "Invalid URL. Only absolute http(s) URLs are supported.");
}
$targetScheme = strtolower($parsedTarget["scheme"]);
if ($targetScheme !== "http" && $targetScheme !== "https") {
  fail_response(400, "Only http(s) URLs are allowed.");
}
if (isset($parsedTarget["user"]) || isset($parsedTarget["pass"])) {
  fail_response(400, "Credentials in target URLs are not allowed.");
}
if (isset($parsedTarget["port"])) {
  $port = intval($parsedTarget["port"]);
  if ($port < 1 || $port > 65535) {
    fail_response(400, "Invalid target port.");
  }
}
if (!hostname_resolves_publicly($parsedTarget["host"])) {
  fail_response(403, "Target host is not allowed.");
}

$cookies = isset($_GET["cookies"]) ? sanitize_cookies($_GET["cookies"]) : "";
$currentUrl = $targetUrl;
$stream = null;
$wrapperHeaders = array();

for ($i = 0; $i <= MAX_REDIRECTS; $i++) {
  list($stream, $wrapperHeaders, $openError) = open_url_stream($currentUrl, $cookies);
  if ($stream === null) {
    fail_response(502, "Unable to fetch " . $currentUrl . "\n" . $openError);
  }

  $statusCode = parse_status_code($wrapperHeaders);
  $location = parse_location_header($wrapperHeaders);
  $isRedirect =
    $statusCode >= 300 &&
    $statusCode < 400 &&
    $location !== null &&
    $location !== "";

  if (!$isRedirect) break;

  fclose($stream);
  if ($i === MAX_REDIRECTS) {
    fail_response(502, "Too many redirects.");
  }

  $resolvedUrl = resolve_redirect_url($location, $currentUrl);
  if ($resolvedUrl === null) {
    fail_response(502, "Invalid redirect URL.");
  }

  $redirectParsed = parse_url($resolvedUrl);
  if ($redirectParsed === false || !isset($redirectParsed["scheme"]) || !isset($redirectParsed["host"])) {
    fail_response(502, "Invalid redirect target.");
  }
  $redirectScheme = strtolower($redirectParsed["scheme"]);
  if ($redirectScheme !== "http" && $redirectScheme !== "https") {
    fail_response(502, "Only http(s) redirect targets are allowed.");
  }
  if (!hostname_resolves_publicly($redirectParsed["host"])) {
    fail_response(403, "Redirect target host is not allowed.");
  }

  $currentUrl = $resolvedUrl;
}

$cookiesFromResponse = "";
$contentTypeSent = false;
foreach ($wrapperHeaders as $headerLine) {
  if (stripos($headerLine, "Set-Cookie:") === 0) {
    $cookie = parse_cookie_pair($headerLine);
    if ($cookie !== null) $cookiesFromResponse .= $cookie;
  } else if (stripos($headerLine, "Content-Type:") === 0) {
    header($headerLine);
    $contentTypeSent = true;
  }
}
if (!$contentTypeSent) {
  header("Content-Type: application/octet-stream");
}
if ($cookiesFromResponse !== "") {
  header("X-Set-Cookie: " . $cookiesFromResponse);
}

stream_copy_to_stream($stream, fopen("php://output", "wb"));
fclose($stream);
