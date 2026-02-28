(function () {
  "use strict";

  function getRuntimeUtils() {
    return window.dezoomifyRuntimeUtils || {};
  }

  function formatDateFallback(ts) {
    if (!ts) return "n/a";
    return new Date(ts).toLocaleString();
  }

  function toLocalDateTimeInputFallback(ts) {
    var date = new Date(ts);
    var offsetMs = date.getTimezoneOffset() * 60000;
    return new Date(ts - offsetMs).toISOString().slice(0, 16);
  }

  function parseDateInputFallback(value) {
    var ts = Date.parse(value);
    return isFinite(ts) ? ts : null;
  }

  function createSchedulePanelController(options) {
    var opts = options || {};
    var refs = {
      form: document.getElementById("schedule-form"),
      urlInput: document.getElementById("schedule-url"),
      timeInput: document.getElementById("schedule-time"),
      repeatInput: document.getElementById("schedule-repeat"),
      status: document.getElementById("schedule-status"),
      empty: document.getElementById("schedule-empty"),
      list: document.getElementById("schedule-list"),
      useCurrentButton: document.getElementById("schedule-use-current"),
    };
    var initialized = false;

    function formatDate(ts) {
      if (typeof opts.formatDate === "function") return opts.formatDate(ts);
      var utils = getRuntimeUtils();
      if (typeof utils.formatDate === "function") return utils.formatDate(ts);
      return formatDateFallback(ts);
    }

    function createInputDate(ts) {
      if (typeof opts.toLocalDateTimeInput === "function") {
        return opts.toLocalDateTimeInput(ts);
      }
      var utils = getRuntimeUtils();
      if (typeof utils.toLocalDateTimeInput === "function") return utils.toLocalDateTimeInput(ts);
      return toLocalDateTimeInputFallback(ts);
    }

    function parseInputDate(value) {
      if (typeof opts.parseDateInput === "function") {
        return opts.parseDateInput(value);
      }
      var utils = getRuntimeUtils();
      if (typeof utils.parseDateInput === "function") return utils.parseDateInput(value);
      return parseDateInputFallback(value);
    }

    function computeNextRun(schedule, fromTs) {
      var repeat = schedule && schedule.repeat ? String(schedule.repeat) : "none";
      if (repeat === "hourly") return fromTs + 3600000;
      if (repeat === "daily") return fromTs + 86400000;
      return null;
    }

    function setStatus(message) {
      if (!refs.status) return;
      refs.status.textContent = String(message || "");
    }

    function prefillURL(url) {
      if (!refs.urlInput) return;
      if (refs.urlInput.value) return;
      refs.urlInput.value = String(url || "").trim();
    }

    function render(schedules) {
      if (!refs.list || !refs.empty) return;
      refs.list.innerHTML = "";
      var items = Array.isArray(schedules) ? schedules : [];
      if (!items.length) {
        refs.empty.style.display = "";
        return;
      }
      refs.empty.style.display = "none";

      items.forEach(function (schedule) {
        var row = document.createElement("div");
        row.className = "ops-item";

        var head = document.createElement("div");
        head.className = "ops-item-head";
        var label = document.createElement("span");
        label.textContent = schedule.repeat === "none" ? "One-time" : ("Repeats " + schedule.repeat);
        var pill = document.createElement("span");
        var pillStatus = (schedule && schedule.status) || "scheduled";
        pill.className = "job-pill " + (pillStatus === "scheduled" ? "scheduled" : pillStatus);
        pill.textContent = String(pillStatus).toUpperCase();
        head.appendChild(label);
        head.appendChild(pill);
        row.appendChild(head);

        var urlLine = document.createElement("p");
        urlLine.className = "ops-item-url";
        urlLine.textContent = (schedule && schedule.url) || "";
        row.appendChild(urlLine);

        var meta = document.createElement("div");
        meta.className = "ops-item-meta";
        var next = schedule && schedule.nextRunAt ? formatDate(schedule.nextRunAt) : "n/a";
        meta.textContent = "Next run: " + next;
        row.appendChild(meta);

        if (schedule && schedule.lastResult) {
          var result = document.createElement("div");
          result.className = "ops-item-meta";
          result.textContent = "Last result: " + schedule.lastResult;
          row.appendChild(result);
        }

        var actions = document.createElement("div");
        actions.className = "mini-actions";

        var runNowButton = document.createElement("button");
        runNowButton.type = "button";
        runNowButton.className = "secondary-action";
        runNowButton.textContent = "Run Now";
        runNowButton.disabled = schedule.status === "completed";
        runNowButton.addEventListener("click", function () {
          if (typeof opts.onRunNow === "function") {
            opts.onRunNow(schedule.id);
          }
        });

        var toggleButton = document.createElement("button");
        toggleButton.type = "button";
        toggleButton.className = "secondary-action";
        toggleButton.textContent = schedule.status === "paused" ? "Resume" : "Pause";
        toggleButton.disabled = schedule.status === "completed";
        toggleButton.addEventListener("click", function () {
          if (typeof opts.onToggle === "function") {
            opts.onToggle(schedule.id);
          }
        });

        var deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "secondary-action";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", function () {
          if (typeof opts.onDelete === "function") {
            opts.onDelete(schedule.id);
          }
        });

        actions.appendChild(runNowButton);
        actions.appendChild(toggleButton);
        actions.appendChild(deleteButton);
        row.appendChild(actions);

        refs.list.appendChild(row);
      });
    }

    function initialize() {
      if (initialized) return true;
      initialized = true;

      if (refs.timeInput) {
        refs.timeInput.value = createInputDate(Date.now() + 10 * 60000);
      }

      if (refs.form && refs.urlInput && refs.timeInput && refs.repeatInput) {
        refs.form.addEventListener("submit", function (evt) {
          evt.preventDefault();
          var url = refs.urlInput.value.trim();
          var runAt = parseInputDate(refs.timeInput.value);
          var repeat = refs.repeatInput.value || "none";
          if (!url || !runAt) return;

          var schedule = {
            id: "schedule-" + Date.now() + "-" + Math.random().toString(16).slice(2),
            url: url,
            nextRunAt: runAt,
            repeat: repeat,
            status: "scheduled",
            createdAt: Date.now(),
            lastRunAt: null,
            lastResult: "pending"
          };

          if (typeof opts.onCreate === "function") {
            var result = opts.onCreate(schedule);
            if (result && result.ok === false) {
              setStatus(result.message || "Unable to create schedule.");
              return;
            }
          }

          refs.form.reset();
          refs.repeatInput.value = "none";
          refs.timeInput.value = createInputDate(Date.now() + 10 * 60000);
          setStatus("Schedule created.");
        });
      }

      if (refs.useCurrentButton) {
        refs.useCurrentButton.addEventListener("click", function () {
          if (typeof opts.getCurrentURL !== "function") return;
          refs.urlInput.value = String(opts.getCurrentURL() || "").trim();
          refs.urlInput.focus();
        });
      }

      return true;
    }

    return {
      initialize: initialize,
      render: render,
      prefillURL: prefillURL,
      computeNextRun: computeNextRun,
    };
  }

  window.createSchedulePanelController = createSchedulePanelController;
})();
