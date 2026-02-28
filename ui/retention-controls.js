(function () {
  "use strict";

  var RETENTION_STORAGE_KEY = "dezoomify:retention:v1";

  function getStorageUtils() {
    return window.dezoomifyStorageUtils || {};
  }

  function parseIntOr(value, fallbackValue) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : fallbackValue;
  }

  function normalizeSettings(raw) {
    var input = raw && typeof raw === "object" ? raw : {};
    return {
      historyDays: Math.min(Math.max(parseIntOr(input.historyDays, 30), 1), 3650),
      asyncFinishedDays: Math.min(Math.max(parseIntOr(input.asyncFinishedDays, 7), 1), 3650),
    };
  }

  function createRetentionControls(options) {
    var opts = options || {};
    var storageKey = String(opts.storageKey || RETENTION_STORAGE_KEY);
    var refs = {
      historyDaysInput: document.getElementById("retention-history-days"),
      asyncDaysInput: document.getElementById("retention-async-days"),
      saveButton: document.getElementById("retention-save"),
      status: document.getElementById("retention-status"),
    };
    var settings = normalizeSettings(null);

    function setStatus(message) {
      if (!refs.status) return;
      refs.status.textContent = String(message || "");
    }

    function loadSettings() {
      var storage = getStorageUtils();
      if (typeof storage.readJSON === "function") {
        settings = normalizeSettings(storage.readJSON(storageKey, settings));
      } else {
        try {
          var raw = localStorage.getItem(storageKey);
          settings = normalizeSettings(raw ? JSON.parse(raw) : settings);
        } catch (_) {
          settings = normalizeSettings(settings);
        }
      }
      return settings;
    }

    function saveSettings(nextSettings) {
      settings = normalizeSettings(nextSettings || settings);
      var storage = getStorageUtils();
      if (typeof storage.writeJSON === "function") {
        storage.writeJSON(storageKey, settings);
      } else {
        try {
          localStorage.setItem(storageKey, JSON.stringify(settings));
        } catch (_) { }
      }
      return settings;
    }

    function applySettingsToInputs() {
      if (refs.historyDaysInput) refs.historyDaysInput.value = String(settings.historyDays);
      if (refs.asyncDaysInput) refs.asyncDaysInput.value = String(settings.asyncFinishedDays);
    }

    function readSettingsFromInputs() {
      return normalizeSettings({
        historyDays: refs.historyDaysInput ? refs.historyDaysInput.value : settings.historyDays,
        asyncFinishedDays: refs.asyncDaysInput ? refs.asyncDaysInput.value : settings.asyncFinishedDays,
      });
    }

    function initialize() {
      settings = loadSettings();
      applySettingsToInputs();
      setStatus("Retention settings loaded.");
      if (refs.saveButton) {
        refs.saveButton.addEventListener("click", function () {
          settings = saveSettings(readSettingsFromInputs());
          applySettingsToInputs();
          setStatus(
            "Saved. History " + settings.historyDays + "d • Async finished " + settings.asyncFinishedDays + "d."
          );
        });
      }
      return true;
    }

    return {
      initialize: initialize,
      getSettings: function () {
        return Object.assign({}, settings);
      },
    };
  }

  window.createRetentionControls = createRetentionControls;
})();
