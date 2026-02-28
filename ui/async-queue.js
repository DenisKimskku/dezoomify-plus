(function () {
  "use strict";

  var DEFAULT_STORAGE_KEY = "dezoomify:async-tracked-jobs:v1";
  var DEFAULT_MAX_ITEMS = 120;
  var DEFAULT_SUBMIT_ENDPOINT = "/api/submit";
  var DEFAULT_STATUS_ENDPOINT = "/api/status";
  var DEFAULT_DOWNLOAD_ENDPOINT = "/api/download";
  var DEFAULT_LIST_ENDPOINT = "/api/list";
  var DEFAULT_RETRY_ENDPOINT = "/api/retry";
  var DEFAULT_RETRY_BULK_ENDPOINT = "/api/retry-bulk";
  var DEFAULT_REMOVE_BULK_ENDPOINT = "/api/remove-bulk";
  var DEFAULT_CANCEL_ENDPOINT = "/api/cancel";
  var DEFAULT_PAGE_SIZE = 60;
  var SEARCH_DEBOUNCE_MS = 180;
  var RETENTION_STORAGE_KEY = "dezoomify:retention:v1";

  function loadArrayState(storageKey) {
    var storage = window.dezoomifyStorageUtils || {};
    if (typeof storage.readJSON === "function") {
      var loaded = storage.readJSON(storageKey, []);
      return Array.isArray(loaded) ? loaded : [];
    }
    try {
      var raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveArrayState(storageKey, value) {
    var storage = window.dezoomifyStorageUtils || {};
    if (typeof storage.writeJSON === "function") {
      storage.writeJSON(storageKey, value);
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (_) { }
  }

  function formatDate(ts, formatter) {
    if (!ts) return "n/a";
    if (typeof formatter === "function") {
      try {
        return formatter(ts);
      } catch (_) { }
    }
    return new Date(ts).toLocaleString();
  }

  function normalizeStatus(status) {
    var value = String(status || "").toLowerCase();
    if (
      value === "queued" ||
      value === "running" ||
      value === "completed" ||
      value === "error" ||
      value === "expired" ||
      value === "canceled" ||
      value === "missing"
    ) {
      return value;
    }
    return "queued";
  }

  function parseIntOr(value, fallbackValue) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : fallbackValue;
  }

  function toNumberOr(value, fallbackValue) {
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : fallbackValue;
  }

  function sanitizeTrackedEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    var id = String(entry.id || "").trim();
    if (!id) return null;
    return {
      id: id,
      url: String(entry.url || ""),
      owner: String(entry.owner || ""),
      status: normalizeStatus(entry.status),
      createdAt: parseIntOr(entry.createdAt, Date.now()),
      updatedAt: parseIntOr(entry.updatedAt, Date.now()),
      startedAt: parseIntOr(entry.startedAt, null),
      finishedAt: parseIntOr(entry.finishedAt, null),
      expiresAt: parseIntOr(entry.expiresAt, null),
      error: String(entry.error || ""),
      artifactAvailable: !!entry.artifactAvailable,
      artifact: entry.artifact && typeof entry.artifact === "object" ? entry.artifact : null,
    };
  }

  function parseJSONSafe(response) {
    return response.json().catch(function () {
      return null;
    });
  }

  function extractErrorMessage(payload, fallbackMessage) {
    if (payload && typeof payload.error === "string" && payload.error) return payload.error;
    if (payload && typeof payload.message === "string" && payload.message) return payload.message;
    return fallbackMessage || "Request failed.";
  }

  function createAsyncQueueController(options) {
    var opts = options || {};
    var storageKey = String(opts.storageKey || DEFAULT_STORAGE_KEY);
    var maxItems = Math.max(parseIntOr(opts.maxItems, DEFAULT_MAX_ITEMS), 1);
    var submitEndpoint = String(opts.submitEndpoint || DEFAULT_SUBMIT_ENDPOINT);
    var statusEndpoint = String(opts.statusEndpoint || DEFAULT_STATUS_ENDPOINT);
    var downloadEndpoint = String(opts.downloadEndpoint || DEFAULT_DOWNLOAD_ENDPOINT);
    var listEndpoint = String(opts.listEndpoint || DEFAULT_LIST_ENDPOINT);
    var retryEndpoint = String(opts.retryEndpoint || DEFAULT_RETRY_ENDPOINT);
    var retryBulkEndpoint = String(opts.retryBulkEndpoint || DEFAULT_RETRY_BULK_ENDPOINT);
    var removeBulkEndpoint = String(opts.removeBulkEndpoint || DEFAULT_REMOVE_BULK_ENDPOINT);
    var cancelEndpoint = String(opts.cancelEndpoint || DEFAULT_CANCEL_ENDPOINT);
    var pageSize = Math.max(parseIntOr(opts.pageSize, DEFAULT_PAGE_SIZE), 10);

    var refs = {
      form: document.getElementById("async-form"),
      urlInput: document.getElementById("async-url"),
      useCurrentButton: document.getElementById("async-use-current"),
      processNowCheckbox: document.getElementById("async-process-now"),
      filterStatus: document.getElementById("async-filter-status"),
      filterQuery: document.getElementById("async-filter-query"),
      filterApplyButton: document.getElementById("async-filter-apply"),
      filterResetButton: document.getElementById("async-filter-reset"),
      bulkRetryFailedButton: document.getElementById("async-bulk-retry-failed"),
      bulkRemoveFinishedButton: document.getElementById("async-bulk-remove-finished"),
      refreshButton: document.getElementById("async-refresh"),
      clearLocalButton: document.getElementById("async-clear-local"),
      autoRefreshCheckbox: document.getElementById("async-auto-refresh"),
      status: document.getElementById("async-status"),
      empty: document.getElementById("async-empty"),
      list: document.getElementById("async-list"),
      loadMoreButton: document.getElementById("async-load-more"),
    };

    var trackedJobs = loadArrayState(storageKey)
      .map(sanitizeTrackedEntry)
      .filter(Boolean)
      .slice(0, maxItems);
    var refreshBusy = false;
    var initialized = false;
    var remoteListEnabled = true;
    var remoteRetryEnabled = true;
    var remoteRetryBulkEnabled = true;
    var remoteRemoveBulkEnabled = true;
    var remoteCancelEnabled = true;
    var visibleLimit = pageSize;
    var searchDebounceTimer = null;
    var rowById = Object.create(null);
    var retryBlockedUntilMs = 0;
    var retryCountdownTimer = null;

    function getFinishedRetentionMs() {
      var storage = window.dezoomifyStorageUtils || {};
      var days = 7;
      if (typeof storage.readJSON === "function") {
        var settings = storage.readJSON(RETENTION_STORAGE_KEY, { asyncFinishedDays: 7 });
        days = parseIntOr(settings && settings.asyncFinishedDays, 7);
      } else {
        try {
          var raw = localStorage.getItem(RETENTION_STORAGE_KEY);
          var parsed = raw ? JSON.parse(raw) : null;
          days = parseIntOr(parsed && parsed.asyncFinishedDays, 7);
        } catch (_) {
          days = 7;
        }
      }
      days = Math.max(days, 1);
      return days * 24 * 60 * 60 * 1000;
    }

    function pruneTrackedJobsByRetention() {
      var cutoffTs = Date.now() - getFinishedRetentionMs();
      trackedJobs = trackedJobs.filter(function (item) {
        if (!item || typeof item !== "object") return false;
        var status = normalizeStatus(item.status);
        if (status === "queued" || status === "running") return true;
        var ts = parseIntOr(item.finishedAt, parseIntOr(item.updatedAt, 0));
        if (!isFinite(ts) || ts <= 0) return true;
        return ts >= cutoffTs;
      });
    }

    function getFilterStatus() {
      if (!refs.filterStatus) return "";
      var value = normalizeStatus(refs.filterStatus.value || "");
      if (
        value === "queued" ||
        value === "running" ||
        value === "completed" ||
        value === "error" ||
        value === "expired" ||
        value === "canceled" ||
        value === "missing"
      ) {
        return refs.filterStatus.value === "" ? "" : value;
      }
      return "";
    }

    function getFilterQuery() {
      if (!refs.filterQuery) return "";
      return String(refs.filterQuery.value || "").trim().toLowerCase();
    }

    function matchesFilters(job) {
      if (!job || typeof job !== "object") return false;
      var statusFilter = getFilterStatus();
      if (statusFilter && normalizeStatus(job.status) !== statusFilter) return false;
      var query = getFilterQuery();
      if (!query) return true;
      var haystack = [
        String(job.id || ""),
        String(job.url || ""),
        String(job.status || ""),
        String(job.error || "")
      ].join("\n").toLowerCase();
      return haystack.indexOf(query) >= 0;
    }

    function getVisibleJobs() {
      return trackedJobs.filter(matchesFilters);
    }

    function getAPIKey() {
      if (typeof opts.getAPIKey !== "function") return "";
      return String(opts.getAPIKey() || "").trim();
    }

    function getCurrentURL() {
      if (typeof opts.getCurrentURL !== "function") return "";
      return String(opts.getCurrentURL() || "").trim();
    }

    function getHttpClient() {
      return window.dezoomifyHttpClient || {};
    }

    function getStartingURL() {
      if (typeof opts.getStartingURL !== "function") return "";
      return String(opts.getStartingURL() || "").trim();
    }

    function setStatus(text) {
      if (!refs.status) return;
      refs.status.textContent = text || "";
    }

    function saveTrackedJobs() {
      pruneTrackedJobsByRetention();
      saveArrayState(storageKey, trackedJobs);
    }

    function setRetryBlock(seconds, context) {
      var retrySeconds = Math.max(parseIntOr(seconds, 0), 0);
      if (retrySeconds <= 0) return;
      retryBlockedUntilMs = Math.max(retryBlockedUntilMs, Date.now() + retrySeconds * 1000);
      var label = context ? String(context) : "Requests";
      setStatus(label + " rate-limited. Retry in " + retrySeconds + "s.");
      updateControlsDisabledState();
      if (!retryCountdownTimer) {
        retryCountdownTimer = setInterval(function () {
          if (!isRetryBlocked()) {
            clearInterval(retryCountdownTimer);
            retryCountdownTimer = null;
            updateControlsDisabledState();
            render();
            return;
          }
          var remaining = Math.max(Math.ceil((retryBlockedUntilMs - Date.now()) / 1000), 0);
          setStatus("Rate-limited. Retry in " + remaining + "s.");
          updateControlsDisabledState();
        }, 1000);
      }
    }

    function isRetryBlocked() {
      return retryBlockedUntilMs > Date.now();
    }

    function updateControlsDisabledState() {
      var blocked = isRetryBlocked();
      var controls = [
        refs.form,
        refs.refreshButton,
        refs.filterApplyButton,
        refs.filterResetButton,
        refs.bulkRetryFailedButton,
        refs.bulkRemoveFinishedButton,
      ];
      for (var i = 0; i < controls.length; i++) {
        if (!controls[i]) continue;
        if (typeof controls[i].querySelectorAll === "function") {
          Array.prototype.forEach.call(controls[i].querySelectorAll("button,input,select"), function (el) {
            if (!el) return;
            if (blocked && !el.hasAttribute("data-async-disabled")) {
              el.setAttribute("data-async-disabled", "1");
              el.disabled = true;
              return;
            }
            if (!blocked && el.getAttribute("data-async-disabled") === "1") {
              el.removeAttribute("data-async-disabled");
              el.disabled = false;
            }
          });
        } else if (typeof controls[i].disabled !== "undefined") {
          controls[i].disabled = blocked;
        }
      }
      if (!blocked && retryBlockedUntilMs > 0) {
        retryBlockedUntilMs = 0;
      }
    }

    function buildAuthedURL(basePath, queryPairs) {
      var pairs = Array.isArray(queryPairs) ? queryPairs.slice() : [];
      var apiKey = getAPIKey();
      var http = getHttpClient();
      if (typeof http.buildAuthedURL === "function") {
        return http.buildAuthedURL(basePath, pairs, apiKey);
      }
      if (apiKey) pairs.push(["api_key", apiKey]);
      if (!pairs.length) return basePath;
      var encoded = pairs.map(function (pair) {
        return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
      }).join("&");
      return basePath + "?" + encoded;
    }

    function buildSubmitURL(processNow) {
      var pairs = [];
      if (processNow) pairs.push(["process_now", "1"]);
      return buildAuthedURL(submitEndpoint, pairs);
    }

    function buildStatusURL(jobId) {
      return buildAuthedURL(statusEndpoint, [["id", String(jobId || "")]]);
    }

    function buildDownloadURL(jobId) {
      return buildAuthedURL(downloadEndpoint, [["id", String(jobId || "")]]);
    }

    function buildListURL(limit) {
      var pairs = [];
      if (isFinite(limit) && limit > 0) {
        pairs.push(["limit", String(Math.max(parseInt(limit, 10), 1))]);
      }
      var statusFilter = getFilterStatus();
      if (statusFilter && statusFilter !== "missing") {
        pairs.push(["status", statusFilter]);
      }
      var query = getFilterQuery();
      if (query) {
        pairs.push(["q", query]);
      }
      return buildAuthedURL(listEndpoint, pairs);
    }

    function buildRetryURL(processNow) {
      var pairs = [];
      if (processNow) pairs.push(["process_now", "1"]);
      return buildAuthedURL(retryEndpoint, pairs);
    }

    function buildRetryBulkURL(processNow) {
      var pairs = [];
      if (processNow) pairs.push(["process_now", "1"]);
      return buildAuthedURL(retryBulkEndpoint, pairs);
    }

    function buildRemoveBulkURL() {
      return buildAuthedURL(removeBulkEndpoint, []);
    }

    function buildCancelURL() {
      return buildAuthedURL(cancelEndpoint, []);
    }

    function findTrackedIndex(jobId) {
      for (var i = 0; i < trackedJobs.length; i++) {
        if (trackedJobs[i].id === jobId) return i;
      }
      return -1;
    }

    function getPillClass(status) {
      var normalized = normalizeStatus(status);
      if (normalized === "completed") return "success";
      if (normalized === "queued") return "queued";
      if (normalized === "running") return "running";
      if (normalized === "error") return "error";
      if (normalized === "expired") return "expired";
      if (normalized === "canceled") return "canceled";
      if (normalized === "missing") return "missing";
      return "running";
    }

    function updateSummaryText(items) {
      var jobs = Array.isArray(items) ? items : trackedJobs;
      if (!trackedJobs.length) return "No async jobs submitted yet.";
      if (!jobs.length) {
        return "No jobs match current filters. Tracked total: " + trackedJobs.length + ".";
      }
      var queued = 0;
      var running = 0;
      var completed = 0;
      var errored = 0;
      var expired = 0;
      var canceled = 0;
      var missing = 0;
      for (var i = 0; i < jobs.length; i++) {
        var status = normalizeStatus(jobs[i].status);
        if (status === "queued") queued += 1;
        else if (status === "running") running += 1;
        else if (status === "completed") completed += 1;
        else if (status === "error") errored += 1;
        else if (status === "expired") expired += 1;
        else if (status === "canceled") canceled += 1;
        else if (status === "missing") missing += 1;
      }
      return (
        "Showing " + jobs.length + " of " + trackedJobs.length + " tracked" +
        " • queued " + queued +
        " • running " + running +
        " • completed " + completed +
        " • error " + errored +
        (expired ? (" • expired " + expired) : "") +
        (canceled ? (" • canceled " + canceled) : "") +
        (missing ? (" • missing " + missing) : "")
      );
    }

    function upsertTrackedJob(publicJob, fallbackURL, options) {
      if (!publicJob || typeof publicJob !== "object") return null;
      var jobId = String(publicJob.id || "").trim();
      if (!jobId) return null;

      var index = findTrackedIndex(jobId);
      var existing = index >= 0 ? trackedJobs[index] : null;
      var nextJob = {
        id: jobId,
        url: String(publicJob.targetURL || (existing && existing.url) || fallbackURL || ""),
        owner: String(publicJob.owner || (existing && existing.owner) || ""),
        status: normalizeStatus(publicJob.status || (existing && existing.status) || "queued"),
        createdAt: parseIntOr(publicJob.createdAt, (existing && existing.createdAt) || Date.now()),
        updatedAt: parseIntOr(publicJob.updatedAt, Date.now()),
        startedAt: parseIntOr(publicJob.startedAt, (existing && existing.startedAt) || null),
        finishedAt: parseIntOr(publicJob.finishedAt, (existing && existing.finishedAt) || null),
        expiresAt: parseIntOr(publicJob.expiresAt, (existing && existing.expiresAt) || null),
        error: String(publicJob.error || ""),
        artifactAvailable: !!publicJob.artifactAvailable,
        artifact: publicJob.artifact && typeof publicJob.artifact === "object"
          ? publicJob.artifact
          : ((existing && existing.artifact) || null),
      };

      if (index >= 0) {
        trackedJobs[index] = nextJob;
      } else {
        trackedJobs.unshift(nextJob);
      }
      if (trackedJobs.length > maxItems) {
        trackedJobs = trackedJobs.slice(0, maxItems);
      }
      if (!(options && options.skipPersist)) {
        saveTrackedJobs();
      }
      if (!(options && options.skipRender)) {
        if (!(options && options.partialRender && renderJobPatch(nextJob.id))) {
          render();
        }
      }
      return nextJob;
    }

    function upsertTrackedJobs(publicJobs) {
      var jobs = Array.isArray(publicJobs) ? publicJobs : [];
      if (!jobs.length) return false;
      var changed = false;
      for (var i = 0; i < jobs.length; i++) {
        var next = upsertTrackedJob(jobs[i], "", {
          skipPersist: true,
          skipRender: true,
        });
        if (next) changed = true;
      }
      if (changed) {
        saveTrackedJobs();
        render();
      }
      return changed;
    }

    function removeTrackedJob(jobId) {
      trackedJobs = trackedJobs.filter(function (item) {
        return item.id !== jobId;
      });
      saveTrackedJobs();
      render();
    }

    function removeTrackedJobsByIDs(jobIds) {
      var ids = Array.isArray(jobIds) ? jobIds : [];
      if (!ids.length) return 0;
      var idMap = Object.create(null);
      for (var i = 0; i < ids.length; i++) {
        var id = String(ids[i] || "").trim();
        if (!id) continue;
        idMap[id] = true;
      }
      var before = trackedJobs.length;
      trackedJobs = trackedJobs.filter(function (item) {
        return !idMap[item.id];
      });
      var removedCount = Math.max(before - trackedJobs.length, 0);
      if (removedCount > 0) {
        saveTrackedJobs();
        render();
      }
      return removedCount;
    }

    function createJobRow(job) {
      var row = document.createElement("div");
      row.className = "ops-item";
      row.setAttribute("data-job-id", job.id);

      var head = document.createElement("div");
      head.className = "ops-item-head";

      var title = document.createElement("span");
      title.textContent = "Submitted " + formatDate(job.createdAt, opts.formatDate);
      head.appendChild(title);

      var pill = document.createElement("span");
      pill.className = "job-pill " + getPillClass(job.status);
      pill.textContent = normalizeStatus(job.status).toUpperCase();
      head.appendChild(pill);
      row.appendChild(head);

      var urlLine = document.createElement("p");
      urlLine.className = "ops-item-url";
      urlLine.textContent = job.url || "";
      row.appendChild(urlLine);

      var meta = document.createElement("div");
      meta.className = "ops-item-meta";
      meta.textContent = "Updated: " + formatDate(job.updatedAt, opts.formatDate) + " • Job: " + job.id;
      row.appendChild(meta);

      if (job.artifactAvailable && job.artifact) {
        var artifactMeta = document.createElement("div");
        artifactMeta.className = "ops-item-meta";
        artifactMeta.textContent =
          "Artifact: " +
          (job.artifact.filename || "artifact.bin") +
          " • " + toNumberOr(job.artifact.size, 0) + " bytes" +
          " • " + (job.artifact.storage || "inline");
        row.appendChild(artifactMeta);
      }

      if (job.error) {
        var messageMeta = document.createElement("div");
        messageMeta.className = "ops-item-meta";
        messageMeta.textContent = "Message: " + job.error;
        row.appendChild(messageMeta);
      }

      var actions = document.createElement("div");
      actions.className = "mini-actions";

      var refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = "secondary-action";
      refreshButton.textContent = "Refresh";
      refreshButton.addEventListener("click", function () {
        refreshJob(job.id);
      });
      actions.appendChild(refreshButton);

      var retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "secondary-action";
      retryButton.textContent = "Retry";
      retryButton.disabled = (
        normalizeStatus(job.status) === "queued" ||
        normalizeStatus(job.status) === "running"
      );
      retryButton.addEventListener("click", function () {
        retryJob(
          job.id,
          !!(refs.processNowCheckbox && refs.processNowCheckbox.checked),
          job.url || ""
        );
      });
      actions.appendChild(retryButton);

      var cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "secondary-action";
      cancelButton.textContent = "Cancel";
      cancelButton.disabled = normalizeStatus(job.status) !== "queued";
      cancelButton.addEventListener("click", function () {
        cancelJob(job.id);
      });
      actions.appendChild(cancelButton);

      var downloadButton = document.createElement("button");
      downloadButton.type = "button";
      downloadButton.className = "secondary-action";
      downloadButton.textContent = "Download";
      downloadButton.disabled = !job.artifactAvailable;
      downloadButton.addEventListener("click", function () {
        var link = document.createElement("a");
        link.href = buildDownloadURL(job.id);
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        if (job.artifact && job.artifact.filename) {
          link.download = job.artifact.filename;
        }
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
      actions.appendChild(downloadButton);

      var removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary-action";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", function () {
        removeTrackedJob(job.id);
      });
      actions.appendChild(removeButton);

      row.appendChild(actions);
      rowById[job.id] = row;
      return row;
    }

    function updateLoadMoreVisibility(visibleCount) {
      if (!refs.loadMoreButton) return;
      if (!visibleCount || visibleLimit >= visibleCount) {
        refs.loadMoreButton.style.display = "none";
        refs.loadMoreButton.textContent = "Load More";
        return;
      }
      refs.loadMoreButton.style.display = "";
      refs.loadMoreButton.textContent = "Load More (" + (visibleCount - visibleLimit) + ")";
    }

    function renderJobPatch(jobId) {
      if (!refs.list || !refs.empty) return false;
      var visibleJobs = getVisibleJobs();
      var maxVisible = Math.min(visibleJobs.length, visibleLimit);
      var isVisible = false;
      for (var i = 0; i < maxVisible; i++) {
        if (visibleJobs[i].id === jobId) {
          isVisible = true;
          break;
        }
      }
      if (!isVisible) return false;
      var existing = rowById[jobId];
      if (!existing || !existing.parentNode) return false;
      var job = null;
      for (var j = 0; j < trackedJobs.length; j++) {
        if (trackedJobs[j].id === jobId) {
          job = trackedJobs[j];
          break;
        }
      }
      if (!job) return false;
      var replacement = createJobRow(job);
      existing.parentNode.replaceChild(replacement, existing);
      return true;
    }

    function render() {
      if (!refs.list || !refs.empty) return;
      refs.list.innerHTML = "";
      rowById = Object.create(null);
      if (!trackedJobs.length) {
        refs.empty.style.display = "";
        refs.empty.textContent = "No tracked async jobs.";
        setStatus("No async jobs submitted yet.");
        updateLoadMoreVisibility(0);
        return;
      }
      var visibleJobs = getVisibleJobs();
      if (!visibleJobs.length) {
        refs.empty.style.display = "";
        refs.empty.textContent = "No jobs match current filters.";
        setStatus(updateSummaryText(visibleJobs));
        updateLoadMoreVisibility(0);
        return;
      }
      refs.empty.style.display = "none";
      setStatus(updateSummaryText(visibleJobs));

      var maxVisible = Math.min(visibleJobs.length, visibleLimit);
      for (var i = 0; i < maxVisible; i++) {
        refs.list.appendChild(createJobRow(visibleJobs[i]));
      }
      updateLoadMoreVisibility(visibleJobs.length);
      updateControlsDisabledState();
    }

    async function submit(url, processNow) {
      var targetURL = String(url || "").trim();
      if (!targetURL || !window.fetch) return false;
      if (isRetryBlocked()) {
        setStatus("Async actions are temporarily rate-limited.");
        updateControlsDisabledState();
        return false;
      }
      setStatus("Submitting async job...");

      try {
        var http = getHttpClient();
        var result;
        if (typeof http.postJSON === "function") {
          result = await http.postJSON(buildSubmitURL(processNow), { url: targetURL });
        } else {
          var response = await fetch(buildSubmitURL(processNow), {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              url: targetURL
            })
          });
          var payloadFallback = await parseJSONSafe(response);
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: payloadFallback,
            category: "",
            retryAfterSeconds: 0,
            message: extractErrorMessage(payloadFallback, "Async submit failed (" + response.status + ")"),
          };
        }

        if (!result.ok || !result.payload || !result.payload.job) {
          if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
            setRetryBlock(result.retryAfterSeconds, "Submit");
            return false;
          }
          setStatus(result.message || ("Async submit failed (" + result.status + ")"));
          return false;
        }

        upsertTrackedJob(result.payload.job, targetURL);
        setStatus(
          "Async job queued: " + result.payload.job.id +
          (result.payload.job.status && result.payload.job.status !== "queued" ? (" (" + result.payload.job.status + ")") : "")
        );
        if (refs.urlInput) refs.urlInput.value = targetURL;
        return true;
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error));
        return false;
      }
    }

    async function pullRemoteJobs(force) {
      if (!window.fetch || !remoteListEnabled) return false;

      try {
        var http = getHttpClient();
        var result;
        if (typeof http.getJSON === "function") {
          result = await http.getJSON(buildListURL(force ? maxItems : Math.min(maxItems, 40)));
        } else {
          var response = await fetch(buildListURL(force ? maxItems : Math.min(maxItems, 40)), {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
          });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: await parseJSONSafe(response),
            category: response.status === 404 || response.status === 405 ? "unavailable" : "",
            retryAfterSeconds: 0,
          };
        }
        if (result.category === "unavailable" || result.category === "not_found") {
          remoteListEnabled = false;
          return false;
        }
        if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
          setRetryBlock(result.retryAfterSeconds, "List");
          return false;
        }
        if (!result.ok || !result.payload || !Array.isArray(result.payload.jobs)) {
          return false;
        }
        return upsertTrackedJobs(result.payload.jobs);
      } catch (_) {
        return false;
      }
    }

    async function retryJob(jobId, processNow, fallbackURL) {
      if (!window.fetch || !jobId) return false;
      if (!remoteRetryEnabled) {
        return submit(fallbackURL || "", !!processNow);
      }
      if (isRetryBlocked()) {
        setStatus("Retry is temporarily rate-limited.");
        updateControlsDisabledState();
        return false;
      }
      setStatus("Retrying async job...");

      try {
        var http = getHttpClient();
        var result;
        if (typeof http.postJSON === "function") {
          result = await http.postJSON(buildRetryURL(processNow), {
            id: String(jobId || "")
          });
        } else {
          var response = await fetch(buildRetryURL(processNow), {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              id: String(jobId || "")
            })
          });
          var payloadFallback = await parseJSONSafe(response);
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: payloadFallback,
            category: response.status === 404 || response.status === 405 ? "unavailable" : "",
            retryAfterSeconds: 0,
            message: extractErrorMessage(payloadFallback, "Retry failed (" + response.status + ")"),
          };
        }
        if (result.category === "unavailable" || result.category === "not_found") {
          remoteRetryEnabled = false;
          return submit(fallbackURL || "", !!processNow);
        }
        if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
          setRetryBlock(result.retryAfterSeconds, "Retry");
          return false;
        }
        if (!result.ok || !result.payload || !result.payload.job) {
          setStatus(result.message || ("Retry failed (" + result.status + ")"));
          return false;
        }
        upsertTrackedJob(result.payload.job, fallbackURL || "");
        setStatus(
          "Retry queued: " + result.payload.job.id +
          (result.payload.job.status && result.payload.job.status !== "queued" ? (" (" + result.payload.job.status + ")") : "")
        );
        return true;
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error));
        return false;
      }
    }

    async function cancelJob(jobId) {
      if (!window.fetch || !jobId || !remoteCancelEnabled) return false;
      if (isRetryBlocked()) {
        setStatus("Cancel is temporarily rate-limited.");
        updateControlsDisabledState();
        return false;
      }
      setStatus("Canceling async job...");

      try {
        var http = getHttpClient();
        var result;
        if (typeof http.postJSON === "function") {
          result = await http.postJSON(buildCancelURL(), { id: String(jobId || "") });
        } else {
          var response = await fetch(buildCancelURL(), {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              id: String(jobId || "")
            })
          });
          var payloadFallback = await parseJSONSafe(response);
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: payloadFallback,
            category: response.status === 404 || response.status === 405 ? "unavailable" : "",
            retryAfterSeconds: 0,
            message: extractErrorMessage(payloadFallback, "Cancel failed (" + response.status + ")"),
          };
        }

        if (result.category === "unavailable" || result.category === "not_found") {
          remoteCancelEnabled = false;
          setStatus("Cancel API unavailable on this deployment.");
          return false;
        }
        if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
          setRetryBlock(result.retryAfterSeconds, "Cancel");
          return false;
        }
        if (!result.ok || !result.payload || !result.payload.job) {
          setStatus(result.message || ("Cancel failed (" + result.status + ")"));
          return false;
        }

        upsertTrackedJob(result.payload.job, "", { partialRender: true });
        setStatus("Canceled job: " + result.payload.job.id);
        return true;
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error));
        return false;
      }
    }

    async function retryJobsBulk(jobIDs, processNow) {
      if (!window.fetch || !remoteRetryBulkEnabled) return null;
      var ids = Array.isArray(jobIDs) ? jobIDs : [];
      if (!ids.length) return null;

      try {
        var http = getHttpClient();
        var result;
        if (typeof http.postJSON === "function") {
          result = await http.postJSON(buildRetryBulkURL(processNow), { ids: ids });
        } else {
          var response = await fetch(buildRetryBulkURL(processNow), {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              ids: ids
            })
          });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: await parseJSONSafe(response),
            category: response.status === 404 || response.status === 405 ? "unavailable" : "",
            retryAfterSeconds: 0,
            message: "",
          };
        }
        if (result.category === "unavailable" || result.category === "not_found") {
          remoteRetryBulkEnabled = false;
          return null;
        }
        if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
          setRetryBlock(result.retryAfterSeconds, "Bulk retry");
          return {
            ok: false,
            message: "Bulk retry is rate-limited.",
            payload: result.payload,
          };
        }
        var payload = result.payload;
        if (!result.ok || !payload || !Array.isArray(payload.results)) {
          return {
            ok: false,
            message: extractErrorMessage(payload, "Bulk retry failed (" + result.status + ")"),
            payload: payload,
          };
        }
        return {
          ok: true,
          payload: payload,
        };
      } catch (error) {
        return {
          ok: false,
          message: error && error.message ? error.message : String(error),
          payload: null,
        };
      }
    }

    async function removeJobsBulk(jobIDs) {
      if (!window.fetch || !remoteRemoveBulkEnabled) return null;
      var ids = Array.isArray(jobIDs) ? jobIDs : [];
      if (!ids.length) return null;

      try {
        var http = getHttpClient();
        var result;
        if (typeof http.postJSON === "function") {
          result = await http.postJSON(buildRemoveBulkURL(), { ids: ids });
        } else {
          var response = await fetch(buildRemoveBulkURL(), {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              ids: ids
            })
          });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: await parseJSONSafe(response),
            category: response.status === 404 || response.status === 405 ? "unavailable" : "",
            retryAfterSeconds: 0,
          };
        }
        if (result.category === "unavailable" || result.category === "not_found") {
          remoteRemoveBulkEnabled = false;
          return null;
        }
        if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
          setRetryBlock(result.retryAfterSeconds, "Bulk remove");
          return {
            ok: false,
            message: "Bulk remove is rate-limited.",
            payload: result.payload,
          };
        }
        var payload = result.payload;
        if (!result.ok || !payload) {
          return {
            ok: false,
            message: extractErrorMessage(payload, "Bulk remove failed (" + result.status + ")"),
            payload: payload,
          };
        }
        return {
          ok: true,
          payload: payload,
        };
      } catch (error) {
        return {
          ok: false,
          message: error && error.message ? error.message : String(error),
          payload: null,
        };
      }
    }

    async function bulkRetryVisibleFailed() {
      var visibleJobs = getVisibleJobs();
      var candidates = visibleJobs.filter(function (job) {
        var status = normalizeStatus(job.status);
        return status === "error" || status === "expired" || status === "missing" || status === "canceled";
      });
      if (!candidates.length) {
        setStatus("No failed jobs in the current view.");
        return false;
      }

      var processNow = !!(refs.processNowCheckbox && refs.processNowCheckbox.checked);
      var retryLimit = Math.min(candidates.length, 40);
      var candidateIds = candidates.slice(0, retryLimit).map(function (job) {
        return job.id;
      });

      var bulkResult = await retryJobsBulk(candidateIds, processNow);
      if (bulkResult && !bulkResult.ok) {
        setStatus(bulkResult.message || "Bulk retry failed.");
        return false;
      }
      if (bulkResult && bulkResult.ok) {
        var results = bulkResult.payload.results || [];
        var changed = false;
        for (var i = 0; i < results.length; i++) {
          var item = results[i];
          if (item && item.job) {
            upsertTrackedJob(item.job, "", {
              skipPersist: true,
              skipRender: true,
            });
            changed = true;
          }
        }
        if (changed) {
          saveTrackedJobs();
          render();
        }
        var bulkSuccess = parseIntOr(bulkResult.payload.successCount, 0);
        setStatus("Retried " + bulkSuccess + "/" + retryLimit + " failed jobs.");
        return bulkSuccess > 0;
      }

      var successCount = 0;
      for (var j = 0; j < retryLimit; j++) {
        var candidate = candidates[j];
        var ok = await retryJob(candidate.id, processNow, candidate.url || "");
        if (ok) successCount += 1;
      }

      setStatus("Retried " + successCount + "/" + retryLimit + " failed jobs.");
      return successCount > 0;
    }

    async function bulkRemoveFinishedVisible() {
      var visibleJobs = getVisibleJobs();
      var removableMap = Object.create(null);
      for (var i = 0; i < visibleJobs.length; i++) {
        var status = normalizeStatus(visibleJobs[i].status);
        if (status === "queued" || status === "running") continue;
        removableMap[visibleJobs[i].id] = true;
      }

      var removableIDs = Object.keys(removableMap);
      if (!removableIDs.length) {
        setStatus("No finished jobs in the current view.");
        return false;
      }

      var removalLimit = Math.min(removableIDs.length, 80);
      var targetIDs = removableIDs.slice(0, removalLimit);
      var bulkRemoved = await removeJobsBulk(targetIDs);
      if (bulkRemoved && !bulkRemoved.ok) {
        setStatus(bulkRemoved.message || "Bulk remove failed.");
        return false;
      }
      if (bulkRemoved && bulkRemoved.ok) {
        var removedIDs = Array.isArray(bulkRemoved.payload.removedIds)
          ? bulkRemoved.payload.removedIds
          : [];
        var removedCount = removeTrackedJobsByIDs(removedIDs);
        var serverRemoved = parseIntOr(bulkRemoved.payload.removed, removedCount);
        setStatus("Removed " + Math.max(removedCount, serverRemoved) + " finished jobs.");
        return Math.max(removedCount, serverRemoved) > 0;
      }

      var localRemovedCount = removeTrackedJobsByIDs(targetIDs);
      setStatus("Removed " + localRemovedCount + " finished jobs.");
      return localRemovedCount > 0;
    }

    async function refreshJob(jobId) {
      if (!window.fetch) return false;
      var initialIndex = findTrackedIndex(jobId);
      if (initialIndex < 0) return false;
      var fallbackURL = trackedJobs[initialIndex] ? trackedJobs[initialIndex].url : "";

      try {
        var http = getHttpClient();
        var result;
        if (typeof http.getJSON === "function") {
          result = await http.getJSON(buildStatusURL(jobId), {
            credentials: "same-origin",
            cache: "no-store",
          });
        } else {
          var response = await fetch(buildStatusURL(jobId), {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
          });
          result = {
            ok: !!response.ok,
            status: response.status,
            payload: await parseJSONSafe(response),
            category: response.status === 404 ? "not_found" : "",
            retryAfterSeconds: 0,
          };
        }

        if (result.category === "rate_limited" && result.retryAfterSeconds > 0) {
          setRetryBlock(result.retryAfterSeconds, "Status");
          return false;
        }
        var payload = result.payload;
        if (result.status === 404 || result.category === "not_found") {
          var missingIndex = findTrackedIndex(jobId);
          if (missingIndex < 0) return false;
          trackedJobs[missingIndex].status = "missing";
          trackedJobs[missingIndex].error = "Job not found for this identity.";
          trackedJobs[missingIndex].updatedAt = Date.now();
          saveTrackedJobs();
          if (!renderJobPatch(jobId)) render();
          return false;
        }
        if (!result.ok || !payload || !payload.job) {
          var errorIndex = findTrackedIndex(jobId);
          if (errorIndex < 0) return false;
          trackedJobs[errorIndex].error = extractErrorMessage(payload, "Status fetch failed (" + result.status + ")");
          trackedJobs[errorIndex].updatedAt = Date.now();
          saveTrackedJobs();
          if (!renderJobPatch(jobId)) render();
          return false;
        }

        upsertTrackedJob(payload.job, fallbackURL, { partialRender: true });
        return true;
      } catch (error) {
        var catchIndex = findTrackedIndex(jobId);
        if (catchIndex < 0) return false;
        trackedJobs[catchIndex].error = error && error.message ? error.message : String(error);
        trackedJobs[catchIndex].updatedAt = Date.now();
        saveTrackedJobs();
        if (!renderJobPatch(jobId)) render();
        return false;
      }
    }

    async function refresh(force) {
      if (!window.fetch || refreshBusy) return false;
      if (!refs.list || !refs.empty) return false;
      if (!force && refs.autoRefreshCheckbox && !refs.autoRefreshCheckbox.checked) return false;
      if (isRetryBlocked() && !force) {
        updateControlsDisabledState();
        return false;
      }

      refreshBusy = true;
      setStatus("Refreshing async jobs...");
      try {
        var refreshed = false;
        var pulled = await pullRemoteJobs(force);
        if (pulled) refreshed = true;

        var idsToRefresh = [];
        for (var i = 0; i < trackedJobs.length; i++) {
          var job = trackedJobs[i];
          if (!force) {
            var status = normalizeStatus(job.status);
            if (status !== "queued" && status !== "running") continue;
          }
          idsToRefresh.push(job.id);
          if (!force && idsToRefresh.length >= 25) break;
          if (force && idsToRefresh.length >= 40) break;
        }

        for (var j = 0; j < idsToRefresh.length; j++) {
          var refreshedJob = await refreshJob(idsToRefresh[j]);
          if (refreshedJob) refreshed = true;
        }
        if (!trackedJobs.length) {
          setStatus("No async jobs submitted yet.");
          return false;
        }
        if (!refreshed && !idsToRefresh.length) {
          setStatus(updateSummaryText());
          return false;
        }
        setStatus("Async jobs refreshed at " + formatDate(Date.now(), opts.formatDate));
        updateControlsDisabledState();
        return true;
      } finally {
        refreshBusy = false;
      }
    }

    function initialize() {
      if (initialized) return true;
      if (!refs.form || !refs.urlInput) return false;
      initialized = true;

      var startURL = getStartingURL();
      pruneTrackedJobsByRetention();
      if (startURL && !refs.urlInput.value) {
        refs.urlInput.value = startURL;
      }

      refs.form.addEventListener("submit", function (evt) {
        evt.preventDefault();
        submit(refs.urlInput.value, !!(refs.processNowCheckbox && refs.processNowCheckbox.checked));
      });

      if (refs.useCurrentButton) {
        refs.useCurrentButton.addEventListener("click", function () {
          refs.urlInput.value = getCurrentURL();
          refs.urlInput.focus();
        });
      }

      if (refs.filterApplyButton) {
        refs.filterApplyButton.addEventListener("click", function () {
          visibleLimit = pageSize;
          refresh(true);
        });
      }
      if (refs.filterResetButton) {
        refs.filterResetButton.addEventListener("click", function () {
          if (refs.filterStatus) refs.filterStatus.value = "";
          if (refs.filterQuery) refs.filterQuery.value = "";
          visibleLimit = pageSize;
          refresh(true);
        });
      }
      if (refs.filterStatus) {
        refs.filterStatus.addEventListener("change", function () {
          visibleLimit = pageSize;
          refresh(true);
        });
      }
      if (refs.filterQuery) {
        refs.filterQuery.addEventListener("input", function () {
          if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = null;
          }
          searchDebounceTimer = setTimeout(function () {
            visibleLimit = pageSize;
            refresh(true);
          }, SEARCH_DEBOUNCE_MS);
        });
        refs.filterQuery.addEventListener("keydown", function (evt) {
          if (evt.key !== "Enter") return;
          evt.preventDefault();
          if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = null;
          }
          visibleLimit = pageSize;
          refresh(true);
        });
      }

      if (refs.bulkRetryFailedButton) {
        refs.bulkRetryFailedButton.addEventListener("click", function () {
          bulkRetryVisibleFailed();
        });
      }
      if (refs.bulkRemoveFinishedButton) {
        refs.bulkRemoveFinishedButton.addEventListener("click", function () {
          bulkRemoveFinishedVisible();
        });
      }

      if (refs.refreshButton) {
        refs.refreshButton.addEventListener("click", function () {
          refresh(true);
        });
      }

      if (refs.loadMoreButton) {
        refs.loadMoreButton.addEventListener("click", function () {
          visibleLimit += pageSize;
          render();
        });
      }

      if (refs.autoRefreshCheckbox) {
        refs.autoRefreshCheckbox.addEventListener("change", function () {
          if (refs.autoRefreshCheckbox.checked) {
            refresh(true);
          }
        });
      }

      if (refs.clearLocalButton) {
        refs.clearLocalButton.addEventListener("click", function () {
          trackedJobs = [];
          saveTrackedJobs();
          render();
        });
      }

      render();
      refresh(true);
      return true;
    }

    return {
      initialize: initialize,
      refresh: refresh,
      submit: submit,
      getActivitySummary: function () {
        var pending = 0;
        for (var i = 0; i < trackedJobs.length; i++) {
          var status = normalizeStatus(trackedJobs[i].status);
          if (status === "queued" || status === "running") pending += 1;
        }
        return {
          total: trackedJobs.length,
          pending: pending,
          retryBlockedUntilMs: retryBlockedUntilMs,
        };
      },
    };
  }

  window.createAsyncQueueController = createAsyncQueueController;
})();
