(function () {
  "use strict";

  function getHttpClient() {
    return window.dezoomifyHttpClient || {};
  }

  function asText(value, fallbackValue) {
    var raw = String(value || "").trim();
    if (raw) return raw;
    return String(fallbackValue || "");
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function createOpsItem(title, meta, extra) {
    var item = document.createElement("article");
    item.className = "ops-item";

    var head = document.createElement("div");
    head.className = "ops-item-head";

    var heading = document.createElement("p");
    heading.className = "ops-item-url";
    heading.textContent = asText(title, "unknown");
    head.appendChild(heading);

    item.appendChild(head);

    var metaText = document.createElement("p");
    metaText.className = "ops-item-meta";
    metaText.textContent = asText(meta, "");
    item.appendChild(metaText);

    if (extra) {
      var extraText = document.createElement("p");
      extraText.className = "ops-item-meta";
      extraText.textContent = asText(extra, "");
      item.appendChild(extraText);
    }

    return item;
  }

  function createAdminConsoleController(options) {
    var opts = options || {};
    var endpoint = String(opts.endpoint || "/api/admin");

    var refs = {
      status: document.getElementById("admin-console-status"),
      refreshButton: document.getElementById("admin-console-refresh"),
      summary: document.getElementById("admin-console-summary"),
      usersList: document.getElementById("admin-users-list"),
      usersEmpty: document.getElementById("admin-users-empty"),
      ownersList: document.getElementById("admin-owners-list"),
      ownersEmpty: document.getElementById("admin-owners-empty"),
      tab: document.querySelector('.dashboard-tab[data-tab="admin"]'),
    };

    var state = {
      initialized: false,
      busy: false,
      isAdmin: false,
      payload: null,
    };

    function setStatus(message) {
      if (!refs.status) return;
      refs.status.textContent = asText(message, "");
    }

    function setSummary(text) {
      if (!refs.summary) return;
      refs.summary.textContent = asText(text, "No admin snapshot loaded.");
    }

    function setTabVisibility(visible) {
      if (!refs.tab) return;
      refs.tab.hidden = !visible;
      refs.tab.disabled = !visible;
      if (!visible && refs.tab.classList && refs.tab.classList.contains("active")) {
        var queueTab = document.querySelector('.dashboard-tab[data-tab="queue"]');
        if (queueTab && typeof queueTab.click === "function") {
          queueTab.click();
        }
      }
    }

    function renderUsers(items) {
      var users = Array.isArray(items) ? items : [];
      clearNode(refs.usersList);
      if (refs.usersEmpty) {
        refs.usersEmpty.hidden = users.length > 0;
      }
      for (var i = 0; i < users.length; i += 1) {
        var user = users[i] || {};
        var title = String(user.email || user.id || "unknown");
        var meta = "role: " + asText(user.role, "user") + " • status: " + asText(user.status, "active");
        var extra = "created: " + asText(user.createdAt ? new Date(user.createdAt).toLocaleString() : "", "n/a");
        refs.usersList.appendChild(createOpsItem(title, meta, extra));
      }
    }

    function renderOwners(items) {
      var owners = Array.isArray(items) ? items : [];
      clearNode(refs.ownersList);
      if (refs.ownersEmpty) {
        refs.ownersEmpty.hidden = owners.length > 0;
      }
      for (var i = 0; i < owners.length; i += 1) {
        var owner = owners[i] || {};
        var title = String(owner.ownerId || "unknown-owner");
        var meta =
          "schedules: " + Number(owner.schedules || 0) +
          " • active: " + Number(owner.scheduled || 0) +
          " • history: " + Number(owner.history || 0);
        var extra = "running: " + Number(owner.running || 0);
        refs.ownersList.appendChild(createOpsItem(title, meta, extra));
      }
    }

    function renderSnapshot(payload) {
      var users = payload && payload.users ? payload.users : {};
      var jobs = payload && payload.jobs ? payload.jobs : {};
      var asyncData = payload && payload.async ? payload.async : {};

      var lines = [];
      lines.push("snapshot: " + asText(payload && payload.at, new Date().toISOString()));
      lines.push("users: " + Number(users.total || 0) + " total (showing " + ((users.items && users.items.length) || 0) + ")");
      lines.push(
        "jobs: owners " +
          Number(jobs.ownersSeen || 0) +
          " (" +
          Number(jobs.ownersSampled || 0) +
          " sampled), active schedules " +
          Number(jobs.schedulesActive || 0) +
          ", history " +
          Number(jobs.historyTotal || 0)
      );
      lines.push(
        "async: owners " +
          Number(asyncData.ownersSeen || 0) +
          " (" +
          Number(asyncData.ownersSampled || 0) +
          " sampled), queued " +
          Number(asyncData.statusTotals && asyncData.statusTotals.queued || 0) +
          ", running " +
          Number(asyncData.statusTotals && asyncData.statusTotals.running || 0)
      );
      setSummary(lines.join("\n"));
      renderUsers(users.items);
      renderOwners(jobs.owners);
    }

    async function requestSnapshot() {
      var http = getHttpClient();
      if (typeof http.getJSON === "function") {
        return http.getJSON(endpoint, { credentials: "same-origin", cache: "no-store" });
      }
      var response = await fetch(endpoint, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      var payload = await response.json().catch(function () {
        return null;
      });
      return {
        ok: !!response.ok,
        status: response.status,
        payload: payload,
        category: response.status === 401 ? "unauthorized" : (response.status === 403 ? "forbidden" : "error"),
        message:
          payload && (payload.message || payload.error)
            ? (payload.message || payload.error)
            : ("Request failed (" + response.status + ")"),
      };
    }

    async function refresh(force) {
      if (!force && (!state.isAdmin || !refs.refreshButton || refs.refreshButton.disabled)) return false;
      if (state.busy) return false;
      if (!window.fetch) return false;
      state.busy = true;
      setStatus("Loading admin snapshot...");
      try {
        var result = await requestSnapshot();
        if (!result.ok || !result.payload || !result.payload.ok) {
          var message = result.message || "Admin snapshot unavailable.";
          setStatus(message);
          setSummary("Admin snapshot unavailable.");
          return false;
        }
        state.payload = result.payload;
        renderSnapshot(result.payload);
        setStatus("Admin snapshot updated.");
        return true;
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error));
        return false;
      } finally {
        state.busy = false;
      }
    }

    function handleAuthState(event) {
      var detail = event && event.detail ? event.detail : {};
      var authenticated = !!detail.authenticated;
      var user = detail.user || null;
      state.isAdmin = !!(authenticated && user && user.role === "admin");
      setTabVisibility(state.isAdmin);
      if (refs.refreshButton) {
        refs.refreshButton.disabled = !state.isAdmin;
      }
      if (!state.isAdmin) {
        setStatus(authenticated ? "Admin role required." : "Sign in as admin to access this console.");
        setSummary("Admin snapshot unavailable.");
        renderUsers([]);
        renderOwners([]);
        return;
      }
      refresh(true);
    }

    function wireEvents() {
      if (refs.refreshButton) {
        refs.refreshButton.addEventListener("click", function () {
          refresh(true);
        });
      }
      window.addEventListener("dezoomify-auth-state", handleAuthState);
    }

    function initialize() {
      if (state.initialized) return true;
      state.initialized = true;
      setTabVisibility(false);
      setStatus("Sign in as admin to access this console.");
      setSummary("Admin snapshot unavailable.");
      wireEvents();
      return true;
    }

    return {
      initialize: initialize,
      refresh: refresh,
      isAdmin: function () {
        return !!state.isAdmin;
      },
    };
  }

  window.createAdminConsoleController = createAdminConsoleController;
})();
