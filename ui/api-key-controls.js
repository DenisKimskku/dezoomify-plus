(function () {
  "use strict";

  var DEFAULT_STORAGE_KEY = "dezoomify:api-key:v1";

  function maybePromise(value) {
    return value && typeof value.then === "function";
  }

  function getStorageUtils() {
    return window.dezoomifyStorageUtils || {};
  }

  function createAPIKeyControls(options) {
    var opts = options || {};
    var storageKey = String(opts.storageKey || DEFAULT_STORAGE_KEY);
    var searchParams = opts.searchParams;
    var refs = {
      input: document.getElementById("api-key-input"),
      saveButton: document.getElementById("api-key-save"),
      clearButton: document.getElementById("api-key-clear"),
    };
    var initialized = false;

    function applyKey(apiKey) {
      var safeKey = String(apiKey || "").trim();
      if (refs.input) refs.input.value = safeKey;
      if (typeof opts.applyAPIKey === "function") {
        opts.applyAPIKey(safeKey);
      }
    }

    function readQueryKey() {
      if (!searchParams || typeof searchParams.get !== "function") return "";
      return searchParams.get("api_key") || searchParams.get("apiKey") || "";
    }

    function readStoredKey() {
      var storage = getStorageUtils();
      if (typeof storage.readString === "function") {
        return storage.readString(storageKey, "");
      }
      try {
        return localStorage.getItem(storageKey) || "";
      } catch (_) { }
      return "";
    }

    function saveStoredKey(value) {
      var storage = getStorageUtils();
      if (typeof storage.writeString === "function") {
        storage.writeString(storageKey, value);
        return;
      }
      try {
        localStorage.setItem(storageKey, value);
      } catch (_) { }
    }

    function clearStoredKey() {
      var storage = getStorageUtils();
      if (typeof storage.remove === "function") {
        storage.remove(storageKey);
        return;
      }
      try {
        localStorage.removeItem(storageKey);
      } catch (_) { }
    }

    function notifyIdentityChanged() {
      if (typeof opts.onIdentityChanged !== "function") return;
      var result = opts.onIdentityChanged();
      if (maybePromise(result)) {
        result.catch(function () { });
      }
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;

      var initialKey = readQueryKey();
      if (!initialKey) {
        initialKey = readStoredKey();
      }
      applyKey(initialKey);

      if (refs.saveButton) {
        refs.saveButton.addEventListener("click", function () {
          var key = refs.input ? refs.input.value.trim() : "";
          applyKey(key);
          saveStoredKey(key);
          notifyIdentityChanged();
        });
      }

      if (refs.clearButton) {
        refs.clearButton.addEventListener("click", function () {
          applyKey("");
          clearStoredKey();
          notifyIdentityChanged();
        });
      }

      return true;
    }

    return {
      initialize: initialize,
      applyKey: applyKey,
    };
  }

  window.createAPIKeyControls = createAPIKeyControls;
})();
