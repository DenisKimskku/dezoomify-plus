(function () {
  "use strict";

  var memoryFallback = Object.create(null);

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function cloneValue(value) {
    if (Array.isArray(value)) return value.slice();
    if (!value || typeof value !== "object") return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function readRaw(key) {
    var storageKey = String(key || "");
    if (!storageKey) return null;
    try {
      var raw = localStorage.getItem(storageKey);
      if (raw !== null && typeof raw !== "undefined") return String(raw);
    } catch (_) { }
    if (hasOwn(memoryFallback, storageKey)) {
      return String(memoryFallback[storageKey] || "");
    }
    return null;
  }

  function writeRaw(key, value) {
    var storageKey = String(key || "");
    if (!storageKey) return false;
    var stringValue = String(value || "");
    memoryFallback[storageKey] = stringValue;
    try {
      localStorage.setItem(storageKey, stringValue);
    } catch (_) { }
    return true;
  }

  function readString(key, fallbackValue) {
    var raw = readRaw(key);
    if (raw === null || typeof raw === "undefined") {
      return String(fallbackValue || "");
    }
    return raw;
  }

  function writeString(key, value) {
    return writeRaw(key, String(value || ""));
  }

  function readJSON(key, fallbackValue) {
    var raw = readRaw(key);
    if (!raw) return cloneValue(fallbackValue);
    try {
      return JSON.parse(raw);
    } catch (_) {
      return cloneValue(fallbackValue);
    }
  }

  function writeJSON(key, value) {
    var encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (_) {
      return false;
    }
    return writeRaw(key, encoded);
  }

  function remove(key) {
    var storageKey = String(key || "");
    if (!storageKey) return false;
    delete memoryFallback[storageKey];
    try {
      localStorage.removeItem(storageKey);
    } catch (_) { }
    return true;
  }

  window.dezoomifyStorageUtils = {
    readJSON: readJSON,
    writeJSON: writeJSON,
    readString: readString,
    writeString: writeString,
    remove: remove,
  };
})();
