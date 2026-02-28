(function () {
  "use strict";

  var DEFAULT_AUTH_SESSION_ENDPOINT = "/api/auth/session";
  var DEFAULT_AUTH_LOGIN_ENDPOINT = "/api/auth/login";
  var DEFAULT_AUTH_REGISTER_ENDPOINT = "/api/auth/register";
  var DEFAULT_AUTH_LOGOUT_ENDPOINT = "/api/auth/logout";
  var DEFAULT_AUTH_KEY_ENDPOINT = "/api/auth/key";
  var DEFAULT_AUTH_ROTATE_ENDPOINT = "/api/auth/key/rotate";
  var DEFAULT_STORAGE_HEALTH_ENDPOINT = "/api/storage-health";

  function getHttpClient() {
    return window.dezoomifyHttpClient || {};
  }

  function getRuntimeUtils() {
    return window.dezoomifyRuntimeUtils || {};
  }

  function formatDate(ts) {
    var utils = getRuntimeUtils();
    if (typeof utils.formatDate === "function") {
      return utils.formatDate(ts);
    }
    if (!ts) return "n/a";
    return new Date(ts).toLocaleString();
  }

  function asText(value, fallbackValue) {
    var raw = String(value || "").trim();
    if (raw) return raw;
    return String(fallbackValue || "");
  }

  function createAuthController(options) {
    var opts = options || {};
    var endpoints = {
      session: String(opts.sessionEndpoint || DEFAULT_AUTH_SESSION_ENDPOINT),
      login: String(opts.loginEndpoint || DEFAULT_AUTH_LOGIN_ENDPOINT),
      register: String(opts.registerEndpoint || DEFAULT_AUTH_REGISTER_ENDPOINT),
      logout: String(opts.logoutEndpoint || DEFAULT_AUTH_LOGOUT_ENDPOINT),
      key: String(opts.keyEndpoint || DEFAULT_AUTH_KEY_ENDPOINT),
      rotate: String(opts.rotateEndpoint || DEFAULT_AUTH_ROTATE_ENDPOINT),
      storageHealth: String(opts.storageHealthEndpoint || DEFAULT_STORAGE_HEALTH_ENDPOINT),
    };

    var refs = {
      emailInput: document.getElementById("auth-email"),
      passwordInput: document.getElementById("auth-password"),
      loginButton: document.getElementById("auth-login"),
      registerButton: document.getElementById("auth-register"),
      logoutButton: document.getElementById("auth-logout"),
      status: document.getElementById("auth-status"),
      user: document.getElementById("auth-user"),
      keyPreview: document.getElementById("auth-key-preview"),
      keyRefreshButton: document.getElementById("auth-key-refresh"),
      keyRotateButton: document.getElementById("auth-key-rotate"),
      dashboardGate: document.getElementById("dashboard-gate"),
      storageStatus: document.getElementById("storage-health-status"),
      storageRefreshButton: document.getElementById("storage-health-refresh"),
      scheduleRepeat: document.getElementById("schedule-repeat"),
      scheduleStatus: document.getElementById("schedule-status"),
      metricsTab: document.querySelector('.dashboard-tab[data-tab=\"metrics\"]'),
    };

    var state = {
      authenticated: false,
      user: null,
      config: {
        authEnforced: false,
        openSignup: true,
        hobbyCronOnly: false,
      },
      loading: false,
      initialized: false,
    };

    function dispatchStateChange() {
      var detail = {
        authenticated: !!state.authenticated,
        user: state.user,
        config: state.config,
      };

      if (typeof window.CustomEvent === "function") {
        window.dispatchEvent(new window.CustomEvent("dezoomify-auth-state", { detail: detail }));
      } else {
        try {
          var event = document.createEvent("Event");
          event.initEvent("dezoomify-auth-state", true, true);
          event.detail = detail;
          window.dispatchEvent(event);
        } catch (_) { }
      }

      if (typeof opts.onChange === "function") {
        opts.onChange(detail);
      }
    }

    function setStatus(message) {
      if (!refs.status) return;
      refs.status.textContent = asText(message, "");
    }

    function getBodyPayload() {
      return {
        email: refs.emailInput ? refs.emailInput.value.trim() : "",
        password: refs.passwordInput ? refs.passwordInput.value : "",
      };
    }

    function setDashboardLocked(locked) {
      var shell = document.getElementById("dashboard-shell");
      if (!shell) return;
      shell.setAttribute("data-dashboard-locked", locked ? "1" : "0");

      var controls = shell.querySelectorAll("button,input,select,textarea");
      for (var i = 0; i < controls.length; i += 1) {
        var el = controls[i];
        if (!el) continue;
        if (locked && !el.disabled) {
          el.disabled = true;
          el.setAttribute("data-auth-locked", "1");
          continue;
        }
        if (!locked && el.getAttribute("data-auth-locked") === "1") {
          el.disabled = false;
          el.removeAttribute("data-auth-locked");
        }
      }
    }

    function applyHobbyCronRestriction() {
      if (!refs.scheduleRepeat) return;
      var hobbyOnly = !!(state.config && state.config.hobbyCronOnly);
      for (var i = 0; i < refs.scheduleRepeat.options.length; i += 1) {
        var option = refs.scheduleRepeat.options[i];
        if (!option || option.value !== "hourly") continue;
        option.disabled = hobbyOnly;
        if (hobbyOnly && refs.scheduleRepeat.value === "hourly") {
          refs.scheduleRepeat.value = "daily";
        }
      }
      if (hobbyOnly && refs.scheduleStatus) {
        refs.scheduleStatus.textContent = "Vercel Hobby: high-frequency cron is disabled. Use daily schedule or Process now.";
      }
    }

    function render() {
      var enforce = !!(state.config && state.config.authEnforced);
      var authenticated = !!state.authenticated;

      if (refs.user) {
        refs.user.textContent = authenticated && state.user
          ? ("Signed in as " + state.user.email + " (" + state.user.role + ")")
          : "Not signed in.";
      }

      if (refs.keyPreview) {
        var preview = state.user && state.user.keyPreview ? state.user.keyPreview : "unavailable";
        refs.keyPreview.textContent = "API key: " + preview;
      }

      if (refs.dashboardGate) {
        refs.dashboardGate.hidden = !(enforce && !authenticated);
      }

      if (refs.logoutButton) {
        refs.logoutButton.disabled = !authenticated;
      }
      if (refs.keyRefreshButton) {
        refs.keyRefreshButton.disabled = !authenticated;
      }
      if (refs.keyRotateButton) {
        refs.keyRotateButton.disabled = !authenticated;
      }

      if (refs.registerButton && state.config && state.config.openSignup === false) {
        refs.registerButton.disabled = true;
      }

      setDashboardLocked(enforce && !authenticated);

      if (refs.metricsTab) {
        if (enforce) {
          var isAdmin = authenticated && state.user && state.user.role === "admin";
          refs.metricsTab.disabled = !isAdmin;
          refs.metricsTab.setAttribute("title", isAdmin ? "" : "Admin role required for service metrics.");
        } else {
          refs.metricsTab.disabled = false;
          refs.metricsTab.setAttribute("title", "");
        }
      }
      applyHobbyCronRestriction();

      document.body.setAttribute("data-auth-enforced", enforce ? "1" : "0");
      document.body.setAttribute("data-authenticated", authenticated ? "1" : "0");
    }

    async function requestJSON(url, method, body) {
      var http = getHttpClient();
      if (method === "GET") {
        if (typeof http.getJSON === "function") {
          return http.getJSON(url, { credentials: "same-origin", cache: "no-store" });
        }
      } else {
        if (typeof http.postJSON === "function") {
          return http.postJSON(url, body || {}, { credentials: "same-origin", cache: "no-store" });
        }
      }

      var response = await fetch(url, {
        method: method,
        credentials: "same-origin",
        cache: "no-store",
        headers: method === "GET" ? {} : { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body || {}),
      });
      var payload = await response.json().catch(function () {
        return null;
      });
      return {
        ok: !!response.ok,
        status: response.status,
        payload: payload,
        category: response.status === 401 ? "unauthorized" : (response.status >= 500 ? "server_error" : "client_error"),
        message: payload && (payload.message || payload.error) ? (payload.message || payload.error) : ("Request failed (" + response.status + ")"),
      };
    }

    async function refreshSession() {
      state.loading = true;
      var result = await requestJSON(endpoints.session, "GET");
      state.loading = false;
      if (!result.ok || !result.payload) {
        setStatus("Session check failed.");
        return false;
      }

      var payload = result.payload;
      state.authenticated = !!payload.authenticated;
      state.user = payload.user || null;
      state.config = payload.config || state.config;

      if (!state.authenticated) {
        setStatus(state.config.authEnforced ? "Sign in required for advanced dashboard." : "Signed out. Public download remains available.");
      } else {
        setStatus("Session active.");
      }

      render();
      dispatchStateChange();
      if (state.authenticated) {
        await refreshKeyInfo();
      }
      return true;
    }

    async function refreshKeyInfo() {
      if (!state.authenticated) {
        if (refs.keyPreview) refs.keyPreview.textContent = "API key: unavailable";
        return false;
      }

      var result = await requestJSON(endpoints.key, "GET");
      if (!result.ok || !result.payload) {
        if (refs.keyPreview) refs.keyPreview.textContent = "API key: unavailable";
        return false;
      }

      var payload = result.payload;
      var preview = payload.keyPreview || "unavailable";
      if (refs.keyPreview) {
        refs.keyPreview.textContent = "API key: " + preview;
      }
      if (state.user) {
        state.user.keyPreview = preview;
      }
      return true;
    }

    async function submitAuth(url, actionLabel) {
      var payload = getBodyPayload();
      if (!payload.email || !payload.password) {
        setStatus("Email and password are required.");
        return false;
      }

      setStatus(actionLabel + "...");
      var result = await requestJSON(url, "POST", payload);
      if (!result.ok) {
        setStatus(result.message || (actionLabel + " failed."));
        return false;
      }

      if (refs.passwordInput) refs.passwordInput.value = "";
      await refreshSession();
      return true;
    }

    async function login() {
      return submitAuth(endpoints.login, "Signing in");
    }

    async function register() {
      return submitAuth(endpoints.register, "Creating account");
    }

    async function logout() {
      setStatus("Signing out...");
      var result = await requestJSON(endpoints.logout, "POST", {});
      if (!result.ok) {
        setStatus(result.message || "Unable to sign out.");
        return false;
      }
      await refreshSession();
      return true;
    }

    async function rotateKey() {
      if (!state.authenticated) {
        setStatus("Sign in required.");
        return false;
      }

      setStatus("Rotating API key...");
      var result = await requestJSON(endpoints.rotate, "POST", {});
      if (!result.ok || !result.payload) {
        setStatus(result.message || "Unable to rotate API key.");
        return false;
      }

      var payload = result.payload;
      if (refs.keyPreview) {
        refs.keyPreview.textContent = "API key: " + (payload.keyPreview || "available");
      }
      setStatus("API key rotated. Save the new key now: " + asText(payload.apiKey, "(not returned)"));
      await refreshSession();
      return true;
    }

    async function refreshStorageHealth() {
      if (!refs.storageStatus) return false;
      refs.storageStatus.textContent = "Checking storage backend...";
      var result = await requestJSON(endpoints.storageHealth, "GET");
      if (!result.ok || !result.payload) {
        refs.storageStatus.textContent = "Storage health unavailable: " + asText(result.message, "request failed");
        return false;
      }

      var payload = result.payload;
      if (!payload.ok || !payload.storage) {
        refs.storageStatus.textContent = "Storage health unavailable.";
        return false;
      }

      refs.storageStatus.textContent = "Storage: " + payload.storage.backend + " • persistent=" + (payload.storage.persistent ? "yes" : "no");
      return true;
    }

    function initializeTabs() {
      var tabs = document.querySelectorAll(".dashboard-tab");
      var panels = document.querySelectorAll(".dashboard-panel");
      if (!tabs.length || !panels.length) return;

      function activate(tabName) {
        for (var i = 0; i < tabs.length; i += 1) {
          var tab = tabs[i];
          var active = tab.getAttribute("data-tab") === tabName;
          tab.classList.toggle("active", active);
          tab.setAttribute("aria-selected", active ? "true" : "false");
        }
        for (var j = 0; j < panels.length; j += 1) {
          var panel = panels[j];
          panel.classList.toggle("active", panel.getAttribute("data-panel") === tabName);
        }
      }

      for (var k = 0; k < tabs.length; k += 1) {
        tabs[k].addEventListener("click", function () {
          activate(this.getAttribute("data-tab") || "queue");
        });
      }
      activate("queue");
    }

    function wireEvents() {
      if (refs.loginButton) {
        refs.loginButton.addEventListener("click", function () {
          login();
        });
      }
      if (refs.registerButton) {
        refs.registerButton.addEventListener("click", function () {
          register();
        });
      }
      if (refs.logoutButton) {
        refs.logoutButton.addEventListener("click", function () {
          logout();
        });
      }
      if (refs.keyRefreshButton) {
        refs.keyRefreshButton.addEventListener("click", function () {
          refreshKeyInfo();
        });
      }
      if (refs.keyRotateButton) {
        refs.keyRotateButton.addEventListener("click", function () {
          rotateKey();
        });
      }
      if (refs.storageRefreshButton) {
        refs.storageRefreshButton.addEventListener("click", function () {
          refreshStorageHealth();
        });
      }
    }

    async function initialize() {
      if (state.initialized) return true;
      state.initialized = true;
      initializeTabs();
      wireEvents();
      await refreshSession();
      await refreshStorageHealth();
      return true;
    }

    return {
      initialize: initialize,
      refreshSession: refreshSession,
      refreshKeyInfo: refreshKeyInfo,
      isAuthenticated: function () { return !!state.authenticated; },
      isAuthEnforced: function () { return !!(state.config && state.config.authEnforced); },
      getUser: function () { return state.user || null; },
      getConfig: function () { return state.config || {}; },
    };
  }

  window.createAuthController = createAuthController;
})();
