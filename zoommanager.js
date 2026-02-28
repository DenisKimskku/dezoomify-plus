/**
@mainpage Helper classes from zoomifiers

Classes defined here:
 - @ref UI : User interface management, interaction with HTML. SHouldn't be used directly by dezoomers.
 - @ref ZoomManager : Helper to be used by dezoomers
*/

/**
User interface management, interaction with HTML
@class UI
*/
var UI = {};
UI.canvas = document.getElementById("rendering-canvas");
UI.dezoomers = document.getElementById("dezoomers");
UI.ratio = 1;
UI.MAX_CANVAS_AREA = 16384 * 16384; // See https://github.com/jhildenbiddle/canvas-size

/**
Adjusts the size of the image, so that is fits page width or page height
**/
UI.changeSize = function () {
	var width = UI.canvas.width, height = UI.canvas.height;
	switch (this.fit) {
		case "width":
			this.fit = "height";
			UI.canvas.style.height = window.innerHeight + "px";
			UI.canvas.style.width = window.innerHeight / height * width + "px";
			break;
		case "height":
			this.fit = "none";
			UI.canvas.style.width = width + "px";
			UI.canvas.style.height = height + "px";
			break;
		default:
			this.fit = "width";
			UI.canvas.style.width = window.innerWidth + "px";
			UI.canvas.style.height = window.innerWidth / width * height + "px";
	}
};

/**
Sets the width and height of the canvas

@param {Object} data : Image source information, containing width and height of the image.
**/
UI.setupRendering = function (data) {
	document.body.className = "loading";
	document.getElementById("error").setAttribute("hidden", true);
	var useWorkerRenderer =
		(typeof ZoomManager !== "undefined") &&
		ZoomManager.status &&
		ZoomManager.status.useWorkerRenderer;
	var area = data.width * data.height;
	for (var maxArea = UI.MAX_CANVAS_AREA; maxArea > 8; maxArea /= 2) {
		UI.ratio = Math.min(Math.sqrt(maxArea / area), 1);
		UI.canvas.width = data.width * UI.ratio;
		UI.canvas.height = data.height * UI.ratio;
		if (useWorkerRenderer) {
			UI.ctx = null;
			break;
		}
		UI.ctx = UI.canvas.getContext("2d");
		try {
			UI.ctx.getImageData(0, 0, 1, 1); // Tests whether the canvas was successfully allocated
			break;
		} catch (_) { }
	}
	UI.canvas.onclick = UI.changeSize;
	UI.changeSize();
};

/**
Draw a tile on the canvas, at the given position.

@param {Image} tile : The tile image
@param {Number} x position
@param {Number} y position
*/
UI.drawTile = function (tileImg, x, y) {
	if (!UI.ctx || typeof UI.ctx.drawImage !== "function") return;
	var r = UI.ratio, w = tileImg.width, h = tileImg.height;
	UI.ctx.drawImage(tileImg,
		Math.floor(x * r),
		Math.floor(y * r),
		Math.ceil(w * r),
		Math.ceil(h * r)
	);
};

/**
Display an error in the UI.

@param {String} errmsg The error message
*/
UI.error = function (errmsg) {
	document.getElementById("percent").textContent = "";
	document.getElementById("error").removeAttribute("hidden");
	var error_img = "error.svg?error=" + encodeURIComponent(errmsg);
	document.getElementById("error-img").src = error_img;
	if (errmsg) {
		document.getElementById("errormsg").textContent = errmsg;
		var urltxt = document.getElementById("url").value;
		try {
			var url = new URL(urltxt);
		} catch (e) { // not a valid URL
			var url = new URL("invalid://invalid?source=" + urltxt);
		}
		document.getElementById("gh-search").href =
			"https://github.com/lovasoa/dezoomify/issues?q=" +
			encodeURIComponent(url.host);
		document.getElementById("gh-open-issue").href =
			"https://github.com/lovasoa/dezoomify/issues/new" +
			"?labels=" + "new%20site%20support" +
			"&title=" + encodeURIComponent(url.host) +
			"&body=" + encodeURIComponent(
				"Hello everyone,\n\n I am having issues when trying to download " + url +
				"\n\nDezoomify reports:\n\n```\n" + errmsg + "\n```\n" +
				"I don't understand this message. Can someone please help me ?"
			);
	}
};

window.onerror = function (errmsg, source, lineno) {
	UI.error(errmsg + '\n\n(' + source + ':' + lineno + ')');
}

/**
Reset the UI to the initial state.
*/
UI.reset = function () {
	document.getElementById("error").setAttribute("hidden", "hidden");
	document.getElementById("status").className = "";
	UI.canvas.width = UI.canvas.height = 0;
};

/**
Update the state of the progress bar.

@param {Number} percentage (between 0 and 100)
@param {String} description current state description
*/
UI.updateProgress = function (percent, text) {
	if (!percent) {
		document.getElementById("percent").innerHTML = text;
		return;
	}
	percent = parseInt(percent);
	document.getElementById("percent").innerHTML = text + ' (' + percent + "%)";
	document.getElementById("progressbar").style.width = percent + "%";
	document.getElementById("progressbar").setAttribute("aria-valuenow", percent);
	document.title = "(" + percent + "%) Dezoomify";
};

/**
Update UI after the image has loaded.
*/
UI.loadEnd = function () {
	var status = document.getElementById("status");
	var a = document.createElement("a");
	a.download = "dezoomify-result.jpg";
	a.href = "#";
	a.textContent = "Converting image...";
	a.className = "button";

	function finishWithBlob(blob) {
		if (!(blob instanceof Blob)) {
			console.error("Unable to access the canvas image data, got an unexpected value", blob);
			status.className = "finished";
			return;
		}
		var url = URL.createObjectURL(blob);
		a.href = url;
		a.textContent = "Save image";
	}

	function exportUsingCanvas() {
		UI.canvas.toBlob(function (blob) {
			finishWithBlob(blob);
		}, "image/jpeg", 0.95);
	}

	try {
		// Try to export the image
		var exportedByWorker = false;
		if (
			typeof ZoomManager !== "undefined" &&
			typeof ZoomManager.requestRenderedBlob === "function" &&
			typeof ZoomManager.isWorkerRendererActive === "function" &&
			ZoomManager.isWorkerRendererActive()
		) {
			exportedByWorker = ZoomManager.requestRenderedBlob(
				"image/jpeg",
				0.95,
				function (blob) {
					if (blob instanceof Blob) {
						finishWithBlob(blob);
						return;
					}
					try {
						exportUsingCanvas();
					} catch (_) {
						status.className = "finished";
					}
				}
			);
		}
		if (!exportedByWorker) {
			exportUsingCanvas();
		}
		document.body.className = "download";
		status.appendChild(a);
	} catch (e) {
		status.className = "finished";
	}
};

/**
Add a new button for a new dezoomer.

@param {Object} dezoomer the dezoomer object
*/
UI.addDezoomer = function (dezoomer) {
	var label = document.createElement("label")
	var input = document.createElement("input");
	input.type = "radio"
	input.name = "dezoomer";
	input.id = "dezoomer-" + dezoomer.name;
	label.title = dezoomer.description;
	input.onclick = function () {
		ZoomManager.setDezoomer(dezoomer);
	}
	label.appendChild(input);
	label.appendChild(document.createTextNode(dezoomer.name));
	UI.dezoomers.appendChild(label);
};

/**
@brief Set the dezoomer that is currently used.

@param {String} dezoomerName name of the dezoomer
*/
UI.setDezoomer = function (dezoomerName) {
	document.getElementById("dezoomer-" + dezoomerName).checked = true;
}


/**
Contains helper functions for dezoomers
@class
*/
var ZoomManager = {};

/**
@brief Signal an error

@param {String} errmsg The error text
@throws {Error} err The given error
*/
ZoomManager.error = function (errmsg) {
	// Display only the first error, until the ZoomManager in reinitialized
	if (!ZoomManager.status.error) {
		ZoomManager.status.error = true;
		UI.error(errmsg);
		throw new Error(errmsg);
	}
};

ZoomManager.updateProgress = function (progress, msg) {
	UI.updateProgress(progress, msg);
};
ZoomManager.loadEnd = function () {
	UI.loadEnd();
}
ZoomManager.onRateLimitInfo = null;
ZoomManager.lastRateLimitInfo = null;

ZoomManager.setRateLimitInfo = function (info) {
	ZoomManager.lastRateLimitInfo = info;
	if (typeof ZoomManager.onRateLimitInfo === "function") {
		ZoomManager.onRateLimitInfo(info);
	}
};

ZoomManager.updateRateLimitFromXHR = function (xhr) {
	if (!xhr || typeof xhr.getResponseHeader !== "function") return;
	var limit = parseInt(xhr.getResponseHeader("X-RateLimit-Limit"), 10);
	var remaining = parseInt(xhr.getResponseHeader("X-RateLimit-Remaining"), 10);
	var reset = parseInt(xhr.getResponseHeader("X-RateLimit-Reset"), 10);
	var retryAfter = parseInt(xhr.getResponseHeader("Retry-After"), 10);
	var quotaMinuteLimit = parseInt(xhr.getResponseHeader("X-Quota-Minute-Limit"), 10);
	var quotaMinuteUsed = parseInt(xhr.getResponseHeader("X-Quota-Minute-Used"), 10);
	var quotaMinuteReset = parseInt(xhr.getResponseHeader("X-Quota-Minute-Reset"), 10);
	var quotaDailyLimit = parseInt(xhr.getResponseHeader("X-Quota-Daily-Limit"), 10);
	var quotaDailyUsed = parseInt(xhr.getResponseHeader("X-Quota-Daily-Used"), 10);
	var quotaDailyReset = parseInt(xhr.getResponseHeader("X-Quota-Daily-Reset"), 10);
	var quotaIdentity = xhr.getResponseHeader("X-Quota-Identity");
	var quotaBackend = xhr.getResponseHeader("X-Quota-Backend");

	if (
		!isFinite(limit) &&
		!isFinite(remaining) &&
		!isFinite(quotaMinuteLimit) &&
		!isFinite(quotaDailyLimit)
	) return;

	ZoomManager.setRateLimitInfo({
		limit: isFinite(limit) ? limit : null,
		remaining: isFinite(remaining) ? remaining : null,
		resetEpochSeconds: isFinite(reset) ? reset : null,
		retryAfterSeconds: isFinite(retryAfter) ? retryAfter : 0,
		quotaMinuteLimit: isFinite(quotaMinuteLimit) ? quotaMinuteLimit : null,
		quotaMinuteUsed: isFinite(quotaMinuteUsed) ? quotaMinuteUsed : null,
		quotaMinuteResetEpochSeconds: isFinite(quotaMinuteReset) ? quotaMinuteReset : null,
		quotaDailyLimit: isFinite(quotaDailyLimit) ? quotaDailyLimit : null,
		quotaDailyUsed: isFinite(quotaDailyUsed) ? quotaDailyUsed : null,
		quotaDailyResetEpochSeconds: isFinite(quotaDailyReset) ? quotaDailyReset : null,
		quotaIdentity: quotaIdentity || null,
		quotaBackend: quotaBackend || null
	});
};

ZoomManager.DEFAULT_TILE_CONCURRENCY = 12;
ZoomManager.MIN_TILE_CONCURRENCY = 2;
ZoomManager.MAX_TILE_CONCURRENCY = 20;
ZoomManager.TILE_RETRY_LIMIT = 5;
ZoomManager.BACKOFF_BASE_MS = 250;
ZoomManager.BACKOFF_CAP_MS = 5000;
ZoomManager.PREFER_DIRECT_TILE_FETCH = true;
ZoomManager.ENABLE_WORKER_RENDERING = true;
ZoomManager.WORKER_SCRIPT_URL = "render-worker.js";
ZoomManager.WORKER_TILE_TIMEOUT_MS = 25000;
ZoomManager.WORKER_READY_TIMEOUT_MS = 1500;
ZoomManager.workerRenderer = null;

ZoomManager.getWorkerRenderQueryOverride = function () {
	if (typeof window === "undefined" || !window.location) return null;
	var search = "";
	if (typeof window.location.search === "string" && window.location.search.length > 0) {
		search = window.location.search;
	} else if (typeof window.location.href === "string") {
		var queryStart = window.location.href.indexOf("?");
		if (queryStart >= 0) search = window.location.href.slice(queryStart);
	}
	if (!search || typeof URLSearchParams === "undefined") return null;
	try {
		var params = new URLSearchParams(search);
		var rawValue =
			params.get("worker_render") ||
			params.get("offscreen") ||
			params.get("worker");
		if (!rawValue) return null;
		rawValue = String(rawValue).toLowerCase().trim();
		if (rawValue === "0" || rawValue === "false" || rawValue === "no") return false;
		if (rawValue === "1" || rawValue === "true" || rawValue === "yes") return true;
	} catch (_) { }
	return null;
};

ZoomManager.supportsWorkerRendering = function () {
	if (!ZoomManager.ENABLE_WORKER_RENDERING) return false;
	if (typeof Worker === "undefined") return false;
	if (typeof OffscreenCanvas === "undefined") return false;
	if (typeof createImageBitmap === "undefined") return false;
	if (!UI.canvas || typeof UI.canvas.transferControlToOffscreen !== "function") return false;
	return true;
};

ZoomManager.shouldUseWorkerRendering = function () {
	var override = ZoomManager.getWorkerRenderQueryOverride();
	if (override === false) return false;
	if (!ZoomManager.supportsWorkerRendering()) return false;
	return true;
};

ZoomManager.ensureMainCanvasContext = function () {
	if (UI.ctx && typeof UI.ctx.drawImage === "function") return true;
	try {
		UI.ctx = UI.canvas.getContext("2d");
		if (!UI.ctx) return false;
		UI.ctx.getImageData(0, 0, 1, 1);
		return true;
	} catch (_) {
		return false;
	}
};

ZoomManager.terminateWorkerRenderer = function (silent) {
	var state = ZoomManager.workerRenderer;
	if (!state) return;

	if (state.pendingTiles) {
		Object.keys(state.pendingTiles).forEach(function (id) {
			var pending = state.pendingTiles[id];
			if (!pending) return;
			clearTimeout(pending.timer);
			if (!silent && typeof pending.done === "function") {
				pending.done(new Error("worker_renderer_terminated"));
			}
		});
	}

	if (state.pendingExports) {
		Object.keys(state.pendingExports).forEach(function (id) {
			var pending = state.pendingExports[id];
			if (!pending) return;
			clearTimeout(pending.timer);
			if (!silent && typeof pending.done === "function") {
				pending.done(null, new Error("worker_renderer_terminated"));
			}
		});
	}

	try {
		if (state.worker) state.worker.terminate();
	} catch (_) { }
	ZoomManager.workerRenderer = null;
};

ZoomManager.handleWorkerRendererFailure = function (errorMessage) {
	ZoomManager.terminateWorkerRenderer(true);
	if (ZoomManager.status) {
		ZoomManager.status.useWorkerRenderer = false;
	}
	if (ZoomManager.ensureMainCanvasContext()) return;
	var fallbackMessage = errorMessage ||
		"The off-main-thread renderer failed. Reload with ?worker_render=0 to disable worker mode.";
	ZoomManager.error(fallbackMessage);
};

ZoomManager.handleWorkerRendererMessage = function (event) {
	var msg = event && event.data ? event.data : {};
	var state = ZoomManager.workerRenderer;
	if (!state || !state.active) return;

	if (msg.type === "init") {
		if (msg.ok) {
			state.ready = true;
			return;
		}
		ZoomManager.handleWorkerRendererFailure(
			msg.error ||
			"The off-main-thread renderer failed to initialize. Reload with ?worker_render=0."
		);
		return;
	}

	if (msg.type === "tileResult") {
		var pendingTile = state.pendingTiles && state.pendingTiles[msg.id];
		if (!pendingTile) return;
		delete state.pendingTiles[msg.id];
		clearTimeout(pendingTile.timer);
		if (msg.ok) pendingTile.done(null);
		else pendingTile.done(new Error(msg.error || "tile_draw_failed"));
		return;
	}

	if (msg.type === "exportResult") {
		var pendingExport = state.pendingExports && state.pendingExports[msg.id];
		if (!pendingExport) return;
		delete state.pendingExports[msg.id];
		clearTimeout(pendingExport.timer);

		if (!msg.ok) {
			pendingExport.done(null, new Error(msg.error || "export_failed"));
			return;
		}
		if (typeof Blob === "undefined" || !msg.buffer) {
			pendingExport.done(null, new Error("blob_unavailable"));
			return;
		}
		try {
			var blob = new Blob([msg.buffer], { type: msg.mimeType || "image/jpeg" });
			pendingExport.done(blob, null);
		} catch (error) {
			pendingExport.done(null, error);
		}
	}
};

ZoomManager.initWorkerRenderer = function (data) {
	if (!ZoomManager.status || !ZoomManager.status.useWorkerRenderer) return false;
	ZoomManager.terminateWorkerRenderer(true);

	var worker = null;
	try {
		worker = new Worker(ZoomManager.WORKER_SCRIPT_URL);
	} catch (_) {
		ZoomManager.status.useWorkerRenderer = false;
		return false;
	}

	var offscreenCanvas = null;
	try {
		offscreenCanvas = UI.canvas.transferControlToOffscreen();
	} catch (_) {
		worker.terminate();
		ZoomManager.status.useWorkerRenderer = false;
		return false;
	}

	ZoomManager.workerRenderer = {
		worker: worker,
		active: true,
		ready: false,
		nextMessageId: 1,
		pendingTiles: {},
		pendingExports: {}
	};

	worker.onmessage = ZoomManager.handleWorkerRendererMessage;
	worker.onerror = function () {
		ZoomManager.handleWorkerRendererFailure(
			"The off-main-thread renderer crashed. Reload with ?worker_render=0."
		);
	};

	worker.postMessage(
		{
			type: "init",
			canvas: offscreenCanvas,
			ratio: UI.ratio,
			width: UI.canvas.width,
			height: UI.canvas.height
		},
		[offscreenCanvas]
	);
	return true;
};

ZoomManager.isWorkerRendererActive = function () {
	var state = ZoomManager.workerRenderer;
	return !!(state && state.active && ZoomManager.status && ZoomManager.status.useWorkerRenderer);
};

ZoomManager.renderTileViaWorker = function (requestUrl, x, y, done, waitedMs) {
	var state = ZoomManager.workerRenderer;
	if (!state || !state.active || !ZoomManager.status || !ZoomManager.status.useWorkerRenderer) {
		done(new Error("worker_renderer_unavailable"));
		return;
	}

	var waited = waitedMs || 0;
	if (!state.ready) {
		if (waited >= ZoomManager.WORKER_READY_TIMEOUT_MS) {
			done(new Error("worker_renderer_not_ready"));
			return;
		}
		setTimeout(function () {
			ZoomManager.renderTileViaWorker(requestUrl, x, y, done, waited + 25);
		}, 25);
		return;
	}

	var messageId = state.nextMessageId++;
	var timer = setTimeout(function () {
		if (!state.pendingTiles[messageId]) return;
		var pending = state.pendingTiles[messageId];
		delete state.pendingTiles[messageId];
		pending.done(new Error("worker_tile_timeout"));
	}, ZoomManager.WORKER_TILE_TIMEOUT_MS);

	state.pendingTiles[messageId] = {
		timer: timer,
		done: done
	};

	try {
		state.worker.postMessage({
			type: "draw",
			id: messageId,
			url: requestUrl,
			x: x,
			y: y
		});
	} catch (error) {
		clearTimeout(timer);
		delete state.pendingTiles[messageId];
		done(error);
	}
};

ZoomManager.requestRenderedBlob = function (mimeType, quality, callback) {
	var state = ZoomManager.workerRenderer;
	if (!state || !state.active || !state.ready) return false;

	var messageId = state.nextMessageId++;
	var timer = setTimeout(function () {
		if (!state.pendingExports[messageId]) return;
		var pending = state.pendingExports[messageId];
		delete state.pendingExports[messageId];
		pending.done(null, new Error("worker_export_timeout"));
	}, ZoomManager.WORKER_TILE_TIMEOUT_MS);

	state.pendingExports[messageId] = {
		timer: timer,
		done: callback
	};

	try {
		state.worker.postMessage({
			type: "export",
			id: messageId,
			mimeType: mimeType || "image/jpeg",
			quality: isFinite(quality) ? quality : 0.95
		});
		return true;
	} catch (_) {
		clearTimeout(timer);
		delete state.pendingExports[messageId];
		return false;
	}
};

ZoomManager.recordTileFailure = function () {
	var status = ZoomManager.status;
	status.tileConsecutiveSuccesses = 0;
	status.tileConsecutiveFailures++;
	if (status.dynamicConcurrency > ZoomManager.MIN_TILE_CONCURRENCY) {
		status.dynamicConcurrency--;
	}

	var failureExponent = Math.min(status.tileConsecutiveFailures - 1, 6);
	var delay = ZoomManager.BACKOFF_BASE_MS * Math.pow(2, failureExponent);
	delay = Math.min(delay, ZoomManager.BACKOFF_CAP_MS);
	// Add jitter so retries don't happen in lockstep.
	delay *= 0.75 + 0.5 * Math.random();
	status.backoffUntil = Math.max(status.backoffUntil, Date.now() + delay);
};

ZoomManager.recordTileSuccess = function () {
	var status = ZoomManager.status;
	status.tileConsecutiveFailures = 0;
	status.tileConsecutiveSuccesses++;
	if (
		status.tileConsecutiveSuccesses >= 20 &&
		status.dynamicConcurrency < ZoomManager.MAX_TILE_CONCURRENCY
	) {
		status.dynamicConcurrency++;
		status.tileConsecutiveSuccesses = 0;
	}
};

ZoomManager.getRetryDelay = function (ntries) {
	var retryDelay = Math.pow(2, ntries) * 100 * (0.75 + 0.5 * Math.random());
	var globalDelay = Math.max(0, ZoomManager.status.backoffUntil - Date.now());
	return Math.max(retryDelay, globalDelay);
};

ZoomManager.getProxyTileURL = function (url) {
	var proxied = ZoomManager.proxy_tiles + "?url=" + encodeURIComponent(url);
	if (ZoomManager.cookies.length > 0) {
		proxied += "&cookies=" + encodeURIComponent(ZoomManager.cookies);
	}
	if (ZoomManager.api_key) {
		proxied += "&api_key=" + encodeURIComponent(ZoomManager.api_key);
	}
	return proxied;
};

/**
Start listening for tile loads

@return {Number} The timer ID
*/
ZoomManager.startTimer = function () {
	var wasLoaded = 0; // Number of tiles that were loaded last time we watched
	var timer = setInterval(function () {
		/*Update the User Interface each 500ms, and not in addTile, because it would
		slow down the all process to update the UI too often.*/
		var loaded = ZoomManager.status.loaded, total = ZoomManager.status.totalTiles;
		if (loaded !== wasLoaded) {
			// Update progress if new tiles were loaded
			var inFlight = ZoomManager.status.activeTiles || 0;
			var parallelism = ZoomManager.status.dynamicConcurrency || 1;
			var elapsedMs = Date.now() - ZoomManager.status.startedAt;
			var elapsedSeconds = elapsedMs > 0 ? elapsedMs / 1000 : 0;
			var tilesPerSecond = elapsedSeconds > 0 ? (loaded / elapsedSeconds) : 0;
			var remainingTiles = Math.max(total - loaded, 0);
			var etaSeconds =
				tilesPerSecond > 0 ? Math.ceil(remainingTiles / tilesPerSecond) : 0;
			ZoomManager.updateProgress(
				100 * loaded / total,
				"Loading the tiles... (" + inFlight + "/" + parallelism + " active, " +
				tilesPerSecond.toFixed(1) + " tiles/s, ETA " + etaSeconds + "s)"
			);
			wasLoaded = loaded;
		}
		if (loaded >= total) {
			clearInterval(timer);
			ZoomManager.loadEnd();
		}
	}, 500);
	return timer;
};


/**
Tells that we are ready
*/
ZoomManager.readyToRender = function (data) {
	if (ZoomManager.data) {
		console.log("Only one dezoom can be active at a time", data);
		return;
	}

	data.nbrTilesX = data.nbrTilesX || Math.ceil(data.width / data.tileSize);
	data.nbrTilesY = data.nbrTilesY || Math.ceil(data.height / data.tileSize);
	data.totalTiles = data.totalTiles || data.nbrTilesX * data.nbrTilesY;
	data.zoomFactor = data.zoomFactor || 2;
	data.baseZoomLevel = data.baseZoomLevel || 0;
	data.overlap = data.overlap || 0;

	ZoomManager.status.totalTiles = data.totalTiles;
	ZoomManager.status.useWorkerRenderer = ZoomManager.shouldUseWorkerRendering();
	ZoomManager.data = data;
	UI.setupRendering(data);
	if (ZoomManager.status.useWorkerRenderer) {
		var workerReady = ZoomManager.initWorkerRenderer(data);
		if (!workerReady) {
			ZoomManager.status.useWorkerRenderer = false;
			ZoomManager.ensureMainCanvasContext();
		}
	}

	ZoomManager.updateProgress(0, "Preparing tiles load...");
	ZoomManager.startTimer();

	var render = ZoomManager.dezoomer.render || ZoomManager.defaultRender;
	setTimeout(render, 1, data); //Give time to refresh the UI, in case render would take a long time
};

ZoomManager.defaultRender = function (data) {
	var zoom = data.maxZoomLevel || ZoomManager.findMaxZoom(data);
	var x = 0, y = 0;
	var pumpTimer = null;

	function nextTileCoordinates() {
		if (y >= data.nbrTilesY) return null;
		var coords = { x: x, y: y };
		x++;
		if (x >= data.nbrTilesX) {
			x = 0;
			y++;
		}
		return coords;
	}

	function schedulePump(waitMs) {
		if (pumpTimer || ZoomManager.status.error) return;
		pumpTimer = setTimeout(function () {
			pumpTimer = null;
			pump();
		}, waitMs || 0);
	}

	function tileDone() {
		ZoomManager.status.activeTiles = Math.max(0, ZoomManager.status.activeTiles - 1);
		schedulePump(0);
	}

	function dispatchTile(coords) {
		ZoomManager.status.activeTiles++;

		function renderTile(resolvedUrl) {
			if (data.origin) resolvedUrl = ZoomManager.resolveRelative(resolvedUrl, data.origin);
			ZoomManager.addTile(
				resolvedUrl,
				coords.x * data.tileSize - data.overlap,
				coords.y * data.tileSize - data.overlap,
				0,
				tileDone,
				function () {
					tileDone();
				}
			);
		}

		var tileUrl = ZoomManager.dezoomer.getTileURL(coords.x, coords.y, zoom, data);
		if (typeof Promise !== "undefined") {
			Promise.resolve(tileUrl)
				.then(renderTile)
				.catch(function (error) {
					tileDone();
					ZoomManager.error(error);
				});
		} else {
			renderTile(tileUrl);
		}
	}

	function pump() {
		if (ZoomManager.status.error) return;

		var waitForBackoff = Math.max(0, ZoomManager.status.backoffUntil - Date.now());
		if (waitForBackoff > 0) {
			schedulePump(waitForBackoff);
			return;
		}

		var targetConcurrency = ZoomManager.status.dynamicConcurrency;
		while (ZoomManager.status.activeTiles < targetConcurrency) {
			var coords = nextTileCoordinates();
			if (!coords) break;
			dispatchTile(coords);
		}
	}

	pump();
};

ZoomManager.MAX_REQUESTS_PER_SECOND = 5;

/**
@function nextTick
Call a function, but not immediatly
@param {Function} f - the function to call
*/
ZoomManager.nextTick = function (f) {
	return setTimeout(f, 1000 / ZoomManager.MAX_REQUESTS_PER_SECOND);
};

/**
Request a tile from the server

@param {String} url - tile URL
@param {Number} x - position in px
@param {Number} y - position in px
@param {Number} [n=0] - Number of time the tile has already been requested
*/
ZoomManager.addTile = function addTile(url, x, y, ntries) {
	var onLoaded = arguments[4];
	var onFailed = arguments[5];
	var transportState = arguments[6] || {};
	var useProxy =
		!!ZoomManager.proxy_tiles &&
		(transportState.forceProxy || !ZoomManager.PREFER_DIRECT_TILE_FETCH);
	var requestUrl = useProxy ? ZoomManager.getProxyTileURL(url) : url;
	//Request a tile from the server and display it once it loaded
	ntries = ntries | 0; // Number of time the tile has already been requested

	function markSuccess() {
		ZoomManager.recordTileSuccess();
		ZoomManager.status.loaded++;
		if (typeof onLoaded === "function") onLoaded();
	}

	function markFailure(evt) {
		ZoomManager.recordTileFailure();
		if (
			ZoomManager.proxy_tiles &&
			!useProxy &&
			ZoomManager.PREFER_DIRECT_TILE_FETCH &&
			!transportState.proxyFallbackTried
		) {
			// If direct loading fails, retry through the proxy before consuming a retry attempt.
			var fallbackDelay = ZoomManager.getRetryDelay(ntries);
			setTimeout(
				addTile,
				fallbackDelay,
				url,
				x,
				y,
				ntries,
				onLoaded,
				onFailed,
				{ forceProxy: true, proxyFallbackTried: true }
			);
			return;
		}

		if (ntries < ZoomManager.TILE_RETRY_LIMIT) {
			// Maybe the server is just busy right now, or we are running on a bad connection
			var nextTime = ZoomManager.getRetryDelay(ntries);
			setTimeout(
				addTile,
				nextTime,
				url,
				x,
				y,
				ntries + 1,
				onLoaded,
				onFailed,
				useProxy ? { forceProxy: true, proxyFallbackTried: true } : transportState
			);
		} else {
			if (typeof onFailed === "function") onFailed(url);
			ZoomManager.error("Unable to load tile.\n" +
				"Check that your internet connection is working " +
				"and that you can access this url:\n" + url);
		}
	}

	if (ZoomManager.isWorkerRendererActive()) {
		ZoomManager.renderTileViaWorker(requestUrl, x, y, function (workerError) {
			if (workerError) {
				markFailure(workerError);
				return;
			}
			markSuccess();
		});
		return;
	}

	var img = new Image;
	img.addEventListener("load", function () {
		UI.drawTile(img, x, y);
		markSuccess();
	});
	img.addEventListener("error", function (evt) {
		markFailure(evt);
	});
	if (useProxy || (ZoomManager.proxy_tiles && ZoomManager.PREFER_DIRECT_TILE_FETCH)) {
		img.crossOrigin = "anonymous";
	}
	// Don't tell the tile host the request comes from dezoomify
	img.referrerPolicy = "no-referrer";
	img.src = requestUrl;
};

/**
Start the dezoomifying process
*/
ZoomManager.open = function (url) {
	ZoomManager.init();
	if (url.indexOf("http") !== 0) {
		throw new Error("You must provide a valid HTTP URL.");
	}
	if (typeof ZoomManager.dezoomer.findFile === "function") {
		ZoomManager.dezoomer.findFile(url, function foundFile(filePath, infos) {
			ZoomManager.updateProgress(0, "Found image. Trying to open it...");
			ZoomManager.dezoomer.open(ZoomManager.resolveRelative(filePath, url), infos);
		});
		ZoomManager.updateProgress(0, "The dezoomer is trying to locate the zoomable image...");
	} else {
		ZoomManager.dezoomer.open(url);
		ZoomManager.updateProgress(0, "Launched dezoomer...");
	}
};

/**
@callback fileCallback
@param {string|Document|Object} response
@param {XMLHttpRequest} request
*/

/**
Call callback with the contents of the page at url
@param {string} url
@param {{type:String, allow_failure?: boolean, error_callback: (err:string)=>any, is_tile?: boolean}} params
@param {fileCallback} callback - callback to call when the file is loaded
*/
ZoomManager.getFile = function (url, params, callback) {
	var PHPSCRIPT = ZoomManager.proxy_url;
	var type = params.type || "text";
	var xhr = new XMLHttpRequest();

	// The url we got MIGHT already have been encoded
	// The url we give to the server MUST be encoded
	if (url.match(/%[a-zA-Z0-9]{2}/) === null) url = encodeURI(url);
	// We pass the URL itself as a query parameter, so we have to re-encode it
	var codedurl = encodeURIComponent(url);
	var requesturl = PHPSCRIPT + "?url=" + codedurl;
	if (ZoomManager.cookies.length > 0) {
		requesturl += "&cookies=" + encodeURIComponent(ZoomManager.cookies);
	}
	if (ZoomManager.api_key) {
		requesturl += "&api_key=" + encodeURIComponent(ZoomManager.api_key);
	}

	function onerror(error_msg) {
		if (params.error_callback) params.error_callback(error_msg);
		if (params.allow_failure) console.log("non-fatal error: ", error_msg);
		else ZoomManager.error(error_msg);
	}

	xhr.open("GET", requesturl, true);

	xhr.onloadstart = function () {
		if (!params.is_tile)
			ZoomManager.updateProgress(0, "Sent a request in order to get information about the image...");
	};
	xhr.onerror = function (e) {
		onerror("Unable to connect to the proxy server " +
			"to get the required information.\n\nXHR error:\n" + e);
	};
	xhr.onload = function () {
		var response = xhr.response;
		ZoomManager.updateRateLimitFromXHR(xhr);
		var responseText =
			typeof response === "string" ? response :
				(response instanceof ArrayBuffer) ? new TextDecoder("utf-8").decode(response) :
					"";

		// Some Vercel deployments can serve proxy.php as static source.
		// When that happens, transparently retry with /api/proxy.
		if (
			xhr.status >= 200 &&
			xhr.status < 300 &&
			/(^|\/)proxy\.php$/i.test(PHPSCRIPT) &&
			!params._proxy_runtime_fallback_tried &&
			typeof responseText === "string" &&
			/^\s*<\?php\b/.test(responseText)
		) {
			ZoomManager.proxy_url = "/api/proxy";
			return ZoomManager.getFile(
				url,
				Object.assign({}, params, { _proxy_runtime_fallback_tried: true }),
				callback
			);
		}

		// Legacy self-hosted setups might not expose /api/proxy.
		// Retry once with proxy.php in that case.
		if (
			xhr.status === 404 &&
			/(^|\/)api\/proxy$/i.test(PHPSCRIPT) &&
			!params._proxy_runtime_fallback_tried
		) {
			ZoomManager.proxy_url = "proxy.php";
			return ZoomManager.getFile(
				url,
				Object.assign({}, params, { _proxy_runtime_fallback_tried: true }),
				callback
			);
		}

		/// If the proxy failed to make the request
		if (xhr.status === 500) {
			var msg = "Unable to fetch " + url;
			if (responseText) {
				msg += "\nThe server responded:\n" + responseText;
				if (responseText.match(/403 forbidden/i)) {
					msg += "\nSee dezoomify's wiki page about protected pages.";
				}
			}
			return onerror(msg);
		} else if (xhr.status === 429) {
			var retryAfter = xhr.getResponseHeader("Retry-After");
			var msg =
				(typeof response === "string" && response.trim().length > 0) ?
					response :
					"The proxy is rate-limited right now. Please wait and try again.";
			if (retryAfter) {
				msg += "\nRetry after " + retryAfter + " seconds.";
			}
			return onerror(msg);
		} else if (xhr.status >= 400) {
			var generic = "Unable to fetch " + url + "\nThe server responded:\nHTTP " + xhr.status;
			if (responseText) {
				var maxErrorLength = 2000;
				generic += "\n" + responseText.slice(0, maxErrorLength);
				if (responseText.length > maxErrorLength) {
					generic += "\n...";
				}
			}
			return onerror(generic);
		}

		var cookie = xhr.getResponseHeader("X-Set-Cookie");
		if (cookie) ZoomManager.cookies += cookie;
		// Custom error message on invalid XML
		if (type === "xml") {
			var hasParserError =
				(response === null) ||
				(response.documentElement && response.documentElement.tagName === "parsererror");
			if (hasParserError && typeof responseText === "string" && responseText.trim().length > 0) {
				try {
					var reparsed = new DOMParser().parseFromString(responseText, "application/xml");
					if (reparsed && reparsed.documentElement && reparsed.documentElement.tagName !== "parsererror") {
						response = reparsed;
						hasParserError = false;
					}
				} catch (_) { }
			}
			if (hasParserError) {
				return onerror("Invalid XML:\n" + url);
			}
		}
		// Custom error message on invalid JSON
		if (type === "json" && xhr.response === null) {
			return onerror("Invalid JSON:\n" + url);
		}
		// Decode html encoded entities
		if (type === "htmltext") {
			response = ZoomManager.decodeHTMLentities(response);
		}
		callback(response, xhr);
	};

	switch (type) {
		case "xml":
			xhr.responseType = "document";
			xhr.overrideMimeType("text/xml");
			break;
		case "json":
			xhr.responseType = "json";
			xhr.overrideMimeType("application/json");
			break;
		case "binary":
			xhr.responseType = "arraybuffer";
			break;
		default:
			xhr.responseType = "text";
			xhr.overrideMimeType("text/plain");
	}
	xhr.send(null);
};

/**
Decode HTML special characaters such as "&amp;", "&gt;", ...

@function ZoomManager.decodeHTMLentities
@param {string} str
@return {string} decoded
*/
ZoomManager.decodeHTMLentities = (function () {
	var dict = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": "\""
	};
	var regEx = /&(?:amp|lt|gt|quot|#(?:x[\da-f]+|\d+));/gi;
	function replacer(entity) {
		entity = entity.toLowerCase();
		return dict[entity] ||
			String.fromCharCode(parseInt('0' + entity.slice(2, -1)));
	}

	return function decodeHTMLentities(text) {
		return text.replace(regEx, replacer);
	};
})();

/**
Return the absolute path, given a relative path and a base

@param {string} path - the path, such as "path/to/other/file.jpg"
@param {string} base - the base URL, such as "http://test.com/path/to/first/file.html"
@return {string} resolved - the resolved path, such as "http://test.com/path/to/first/path/to/other/file.jpg"
*/
ZoomManager.resolveRelative = function resolveRelative(path, base) {
	// absolute URL
	if (path.match(/\w*:\/\//)) {
		return path;
	}
	// Protocol-relative URL
	if (path.indexOf("//") === 0) {
		var protocol = base.match(/\w+:/) || ["http:"];
		return protocol[0] + path;
	}
	// Upper directory
	if (path.indexOf("../") === 0) {
		return resolveRelative(path.slice(3), base.replace(/\/[^\/]*$/, ''));
	}
	// Relative to the root
	if (path[0] === '/') {
		var match = base.match(/(\w*:\/\/)?[^\/]*\//) || [base];
		return match[0] + path.slice(1);
	}
	//relative to the current directory
	return base.replace(/\/[^\/]*$/, "") + '/' + path;
};

/**
Returns the maximum zoom level, knowing the image size, the tile size, and the multiplying factor between two consecutive zoom levels
@param {{width:number, height:number}} metadata
@return {number} maxzoom - the maximal zoom level
**/
ZoomManager.findMaxZoom = function (data) {
	//For all zoom levels:
	//size / zoomFactor^(maxZoomLevel - zoomlevel) = numTilesAtThisZoomLevel * tileSize
	//For the baseZoomLevel (0 for zoomify), numTilesAtThisZoomLevel=1
	var size = Math.max(data.width, data.height);
	return Math.ceil(Math.log(size / data.tileSize) / Math.log(data.zoomFactor)) + (data.baseZoomLevel || 0);
};

ZoomManager.dezoomersList = {};
ZoomManager.addDezoomer = function (dezoomer) {
	ZoomManager.dezoomersList[dezoomer.name] = dezoomer;
	UI.addDezoomer(dezoomer);
}

/**
Set the active dezoomer
*/
ZoomManager.setDezoomer = function (dezoomer) {
	ZoomManager.dezoomer = dezoomer;
	UI.setDezoomer(dezoomer.name);
}

ZoomManager.reset = function () {
	// This variable will store cookies set by previous requests
	ZoomManager.setDezoomer(ZoomManager.dezoomersList["Select automatically"]);
};

/**
Initialize the ZoomManager
*/
ZoomManager.init = function () {
	// Called before open()
	ZoomManager.terminateWorkerRenderer(true);
	var preferredConcurrency = parseInt(ZoomManager.PREFERRED_TILE_CONCURRENCY, 10);
	if (!isFinite(preferredConcurrency)) {
		preferredConcurrency = ZoomManager.DEFAULT_TILE_CONCURRENCY;
	}
	preferredConcurrency = Math.max(
		ZoomManager.MIN_TILE_CONCURRENCY,
		Math.min(preferredConcurrency, ZoomManager.MAX_TILE_CONCURRENCY)
	);
	if (!ZoomManager.cookies) ZoomManager.cookies = "";
	if (typeof ZoomManager.api_key !== "string") ZoomManager.api_key = "";
	if (!ZoomManager.proxy_url) {
		var isFileProtocol = window.location && window.location.protocol === "file:";
		ZoomManager.proxy_url = isFileProtocol ? "proxy.php" : "/api/proxy";
	}
	ZoomManager.status = {
		"error": false,
		"loaded": 0,
		"totalTiles": 1,
		"activeTiles": 0,
		"dynamicConcurrency": preferredConcurrency,
		"tileConsecutiveFailures": 0,
		"tileConsecutiveSuccesses": 0,
		"backoffUntil": 0,
		"startedAt": Date.now(),
		"useWorkerRenderer": false
	};
	UI.reset();
};
