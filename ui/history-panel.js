(function () {
  "use strict";

  var DEFAULT_HISTORY_ENDPOINT = "/api/history";
  var DEFAULT_PAGE_SIZE = 20;

  function getRuntimeUtils() {
    return window.dezoomifyRuntimeUtils || {};
  }

  function getHttpClient() {
    return window.dezoomifyHttpClient || {};
  }

  function formatDateFallback(ts) {
    if (!ts) return "n/a";
    return new Date(ts).toLocaleString();
  }

  function formatDurationFallback(ms) {
    if (!isFinite(ms) || ms <= 0) return "0s";
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    var minutes = Math.floor(ms / 60000);
    var seconds = Math.round((ms % 60000) / 1000);
    return minutes + "m " + seconds + "s";
  }

  function parseIntOr(value, fallbackValue) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : fallbackValue;
  }

  function normalizeStatus(value) {
    var status = String(value || "").toLowerCase();
    if (status === "success" || status === "error" || status === "running") {
      return status;
    }
    return "";
  }

  function createHistoryPanelController(options) {
    var opts = options || {};
    var endpoint = String(opts.endpoint || DEFAULT_HISTORY_ENDPOINT);
    var pageSize = Math.max(parseIntOr(opts.pageSize, DEFAULT_PAGE_SIZE), 5);
    var refs = {
      empty: document.getElementById("history-empty"),
      list: document.getElementById("history-list"),
      clearButton: document.getElementById("clear-history"),
      status: document.getElementById("history-status"),
      filterStatus: document.getElementById("history-filter-status"),
      filterQuery: document.getElementById("history-filter-query"),
      filterApplyButton: document.getElementById("history-filter-apply"),
      filterResetButton: document.getElementById("history-filter-reset"),
      prevButton: document.getElementById("history-page-prev"),
      nextButton: document.getElementById("history-page-next"),
      pageInfo: document.getElementById("history-page-info"),
    };
    var initialized = false;
    var serverHistoryEnabled = true;
    var historyFetchBusy = false;
    var localHistory = [];
    var localCursor = 0;
    var remoteCursor = 0;
    var remoteNextCursor = null;
    var remoteTotal = 0;
    var remoteItems = [];
    var usingRemote = false;
    var lastRetryAfterMs = 0;

    function formatDate(ts) {
      if (typeof opts.formatDate === "function") return opts.formatDate(ts);
      var utils = getRuntimeUtils();
      if (typeof utils.formatDate === "function") return utils.formatDate(ts);
      return formatDateFallback(ts);
    }

    function formatDuration(ms) {
      if (typeof opts.formatDuration === "function") return opts.formatDuration(ms);
      var utils = getRuntimeUtils();
      if (typeof utils.formatDuration === "function") return utils.formatDuration(ms);
      return formatDurationFallback(ms);
    }

    function setStatus(text) {
      if (!refs.status) return;
      refs.status.textContent = String(text || "");
    }

    function getAPIKey() {
      if (typeof opts.getAPIKey !== "function") return "";
      return String(opts.getAPIKey() || "").trim();
    }

    function getFilterStatus() {
      if (!refs.filterStatus) return "";
      return normalizeStatus(refs.filterStatus.value || "");
    }

    function getFilterQuery() {
      if (!refs.filterQuery) return "";
      return String(refs.filterQuery.value || "").trim().toLowerCase();
    }

    function matchesLocalFilters(item) {
      if (!item || typeof item !== "object") return false;
      var status = getFilterStatus();
      if (status && String(item.status || "").toLowerCase() !== status) return false;
      var query = getFilterQuery();
      if (!query) return true;
      var haystack = [
        String(item.id || ""),
        String(item.url || ""),
        String(item.message || ""),
        String(item.source || ""),
        String(item.status || ""),
      ].join("\n").toLowerCase();
      return haystack.indexOf(query) >= 0;
    }

    function getLocalPage() {
      var filtered = localHistory.filter(matchesLocalFilters);
      var start = Math.max(localCursor, 0);
      var items = filtered.slice(start, start + pageSize);
      var nextCursor = (start + pageSize) < filtered.length ? String(start + pageSize) : null;
      return {
        items: items,
        total: filtered.length,
        cursor: start,
        nextCursor: nextCursor,
      };
    }

    function buildHistoryURL(cursor) {
      var pairs = [
        ["limit", String(pageSize)],
        ["cursor", String(Math.max(parseIntOr(cursor, 0), 0))],
      ];
      var status = getFilterStatus();
      if (status) pairs.push(["status", status]);
      var query = getFilterQuery();
      if (query) pairs.push(["q", query]);

      var http = getHttpClient();
      if (typeof http.buildAuthedURL === "function") {
        return http.buildAuthedURL(endpoint, pairs, getAPIKey());
      }

      var key = getAPIKey();
      if (key) pairs.push(["api_key", key]);
      var encoded = pairs.map(function (pair) {
        return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
      }).join("&");
      return endpoint + "?" + encoded;
    }

    function setPaginationInfo(cursor, total, nextCursor) {
      if (refs.prevButton) refs.prevButton.disabled = cursor <= 0;
      if (refs.nextButton) refs.nextButton.disabled = !nextCursor;
      if (refs.pageInfo) {
        var page = Math.floor(cursor / pageSize) + 1;
        refs.pageInfo.textContent = "Page " + page + " • total " + total;
      }
    }

    function renderRows(items) {
      if (!refs.list || !refs.empty) return;
      refs.list.innerHTML = "";
      var rows = Array.isArray(items) ? items : [];
      if (!rows.length) {
        refs.empty.style.display = "";
        refs.empty.textContent = "No jobs match current history filters.";
        return;
      }
      refs.empty.style.display = "none";

      rows.forEach(function (job) {
        var row = document.createElement("div");
        row.className = "ops-item";

        var head = document.createElement("div");
        head.className = "ops-item-head";

        var title = document.createElement("span");
        title.textContent = formatDate(job && job.startedAt);

        var pill = document.createElement("span");
        var status = String((job && job.status) || "running").toLowerCase();
        pill.className = "job-pill " + status;
        pill.textContent = status.toUpperCase();

        head.appendChild(title);
        head.appendChild(pill);
        row.appendChild(head);

        var urlLine = document.createElement("p");
        urlLine.className = "ops-item-url";
        urlLine.textContent = (job && job.url) || "";
        row.appendChild(urlLine);

        var meta = document.createElement("div");
        meta.className = "ops-item-meta";
        var source = (job && job.source) || "manual";
        var duration = (job && job.durationMs) ? formatDuration(job.durationMs) : "-";
        meta.textContent = "Source: " + source + " • Duration: " + duration;
        row.appendChild(meta);

        if (job && job.message) {
          var message = document.createElement("div");
          message.className = "ops-item-meta";
          message.textContent = "Message: " + job.message;
          row.appendChild(message);
        }

        var actions = document.createElement("div");
        actions.className = "mini-actions";
        var rerunButton = document.createElement("button");
        rerunButton.type = "button";
        rerunButton.className = "secondary-action";
        rerunButton.textContent = "Run Again";
        rerunButton.addEventListener("click", function () {
          if (typeof opts.onRunAgain === "function") {
            opts.onRunAgain((job && job.url) || "");
          }
        });
        actions.appendChild(rerunButton);
        row.appendChild(actions);

        refs.list.appendChild(row);
      });
    }

    function renderLocalPage() {
      usingRemote = false;
      var localPage = getLocalPage();
      renderRows(localPage.items);
      setPaginationInfo(localPage.cursor, localPage.total, localPage.nextCursor);
      setStatus("History source: browser local");
      return true;
    }

    function parseRetryAfterSeconds(result) {
      if (!result || !isFinite(result.retryAfterSeconds)) return 0;
      return Math.max(parseIntOr(result.retryAfterSeconds, 0), 0);
    }

    async function fetchRemotePage(cursor, force) {
      if (!window.fetch || !serverHistoryEnabled || historyFetchBusy) return false;
      if (!force && lastRetryAfterMs > Date.now()) return false;
      historyFetchBusy = true;
      try {
        var url = buildHistoryURL(cursor);
        var http = getHttpClient();
        var result;
        if (typeof http.getJSON === "function") {
          result = await http.getJSON(url, { credentials: "same-origin", cache: "no-store" });
        } else {
          var response = await fetch(url, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
          });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: await response.json().catch(function () { return null; }),
            category: response.status === 401 ? "unauthorized" : (response.status === 404 || response.status === 405 ? "unavailable" : ""),
            retryAfterSeconds: 0,
          };
        }

        if (!result.ok) {
          if (result.category === "unavailable" || result.category === "not_found") {
            serverHistoryEnabled = false;
            setStatus("History API unavailable. Using local history.");
            renderLocalPage();
            return false;
          }
          if (result.category === "unauthorized") {
            setStatus("History API requires API key. Showing local history.");
            renderLocalPage();
            return false;
          }
          if (result.category === "rate_limited") {
            var retryAfterSeconds = parseRetryAfterSeconds(result);
            if (retryAfterSeconds > 0) {
              lastRetryAfterMs = Date.now() + retryAfterSeconds * 1000;
              setStatus("History rate-limited. Retry in " + retryAfterSeconds + "s.");
              return false;
            }
          }
          setStatus("History API error (" + result.status + "). Showing local history.");
          renderLocalPage();
          return false;
        }

        var payload = result.payload;
        if (!payload || !Array.isArray(payload.items)) {
          setStatus("Invalid history response. Showing local history.");
          renderLocalPage();
          return false;
        }
        remoteItems = payload.items;
        remoteTotal = parseIntOr(payload.total, payload.items.length);
        remoteCursor = parseIntOr(payload.cursor, 0);
        remoteNextCursor = payload.nextCursor;
        usingRemote = true;
        renderRows(remoteItems);
        setPaginationInfo(remoteCursor, remoteTotal, remoteNextCursor);
        setStatus("History source: server");
        return true;
      } catch (_) {
        setStatus("History request failed. Showing local history.");
        renderLocalPage();
        return false;
      } finally {
        historyFetchBusy = false;
      }
    }

    async function refresh(force) {
      var shouldForce = !!force;
      if (!serverHistoryEnabled) {
        renderLocalPage();
        return false;
      }
      return fetchRemotePage(remoteCursor, shouldForce);
    }

    function resetFilters() {
      if (refs.filterStatus) refs.filterStatus.value = "";
      if (refs.filterQuery) refs.filterQuery.value = "";
      localCursor = 0;
      remoteCursor = 0;
      remoteNextCursor = null;
    }

    function render(history) {
      localHistory = Array.isArray(history) ? history.slice() : [];
      if (!serverHistoryEnabled) {
        renderLocalPage();
        return;
      }
      if (!usingRemote) {
        fetchRemotePage(0, true);
      }
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;

      if (refs.clearButton) {
        refs.clearButton.addEventListener("click", function () {
          if (typeof opts.onClear === "function") {
            opts.onClear();
          }
          localCursor = 0;
          remoteCursor = 0;
          remoteNextCursor = null;
          refresh(true);
        });
      }

      if (refs.filterApplyButton) {
        refs.filterApplyButton.addEventListener("click", function () {
          localCursor = 0;
          remoteCursor = 0;
          remoteNextCursor = null;
          refresh(true);
        });
      }
      if (refs.filterResetButton) {
        refs.filterResetButton.addEventListener("click", function () {
          resetFilters();
          refresh(true);
        });
      }
      if (refs.filterStatus) {
        refs.filterStatus.addEventListener("change", function () {
          localCursor = 0;
          remoteCursor = 0;
          remoteNextCursor = null;
          refresh(true);
        });
      }
      if (refs.filterQuery) {
        refs.filterQuery.addEventListener("keydown", function (evt) {
          if (evt.key !== "Enter") return;
          evt.preventDefault();
          localCursor = 0;
          remoteCursor = 0;
          remoteNextCursor = null;
          refresh(true);
        });
      }
      if (refs.prevButton) {
        refs.prevButton.addEventListener("click", function () {
          if (serverHistoryEnabled && usingRemote) {
            remoteCursor = Math.max(remoteCursor - pageSize, 0);
            fetchRemotePage(remoteCursor, true);
            return;
          }
          localCursor = Math.max(localCursor - pageSize, 0);
          renderLocalPage();
        });
      }
      if (refs.nextButton) {
        refs.nextButton.addEventListener("click", function () {
          if (serverHistoryEnabled && usingRemote) {
            if (!remoteNextCursor) return;
            remoteCursor = parseIntOr(remoteNextCursor, remoteCursor + pageSize);
            fetchRemotePage(remoteCursor, true);
            return;
          }
          var localPage = getLocalPage();
          if (!localPage.nextCursor) return;
          localCursor = parseIntOr(localPage.nextCursor, localCursor + pageSize);
          renderLocalPage();
        });
      }

      setStatus("History view ready.");
      setPaginationInfo(0, 0, null);
      return true;
    }

    return {
      initialize: initialize,
      render: render,
      refresh: refresh,
    };
  }

  window.createHistoryPanelController = createHistoryPanelController;
})();
