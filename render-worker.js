"use strict";

var state = {
	canvas: null,
	ctx: null,
	ratio: 1,
	ready: false
};

function safeErrorMessage(error, fallback) {
	if (!error) return fallback || "worker_error";
	if (typeof error === "string") return error;
	if (error && error.message) return String(error.message);
	try {
		return String(error);
	} catch (_) {
		return fallback || "worker_error";
	}
}

function toNumber(value, fallback) {
	var n = Number(value);
	return isFinite(n) ? n : fallback;
}

function drawCoordinates(x, y, width, height, ratio) {
	var r = toNumber(ratio, 1);
	return {
		x: Math.floor(toNumber(x, 0) * r),
		y: Math.floor(toNumber(y, 0) * r),
		w: Math.ceil(Math.max(toNumber(width, 0), 0) * r),
		h: Math.ceil(Math.max(toNumber(height, 0), 0) * r)
	};
}

async function handleInit(message) {
	try {
		if (!message || !message.canvas) {
			throw new Error("missing_canvas");
		}
		state.canvas = message.canvas;
		state.canvas.width = Math.max(toNumber(message.width, state.canvas.width || 0), 1);
		state.canvas.height = Math.max(toNumber(message.height, state.canvas.height || 0), 1);
		state.ratio = Math.max(toNumber(message.ratio, 1), 0.001);
		state.ctx = state.canvas.getContext("2d");
		if (!state.ctx) throw new Error("missing_2d_context");
		state.ready = true;
		self.postMessage({ type: "init", ok: true });
	} catch (error) {
		self.postMessage({
			type: "init",
			ok: false,
			error: safeErrorMessage(error, "worker_init_failed")
		});
	}
}

async function handleDraw(message) {
	var requestId = message && message.id;
	if (!state.ready || !state.ctx) {
		self.postMessage({
			type: "tileResult",
			id: requestId,
			ok: false,
			error: "worker_not_ready"
		});
		return;
	}

	try {
		var response = await fetch(String(message.url || ""), {
			method: "GET",
			redirect: "follow",
			cache: "force-cache"
		});
		if (!response.ok) {
			throw new Error("HTTP " + response.status);
		}
		var blob = await response.blob();
		var bitmap = await createImageBitmap(blob);
		var pos = drawCoordinates(
			message.x,
			message.y,
			bitmap.width,
			bitmap.height,
			state.ratio
		);
		state.ctx.drawImage(bitmap, pos.x, pos.y, pos.w, pos.h);
		if (typeof bitmap.close === "function") bitmap.close();
		self.postMessage({
			type: "tileResult",
			id: requestId,
			ok: true
		});
	} catch (error) {
		self.postMessage({
			type: "tileResult",
			id: requestId,
			ok: false,
			error: safeErrorMessage(error, "tile_draw_failed")
		});
	}
}

async function handleExport(message) {
	var requestId = message && message.id;
	if (!state.ready || !state.canvas || typeof state.canvas.convertToBlob !== "function") {
		self.postMessage({
			type: "exportResult",
			id: requestId,
			ok: false,
			error: "export_unavailable"
		});
		return;
	}

	try {
		var blob = await state.canvas.convertToBlob({
			type: String(message.mimeType || "image/jpeg"),
			quality: toNumber(message.quality, 0.95)
		});
		var buffer = await blob.arrayBuffer();
		self.postMessage(
			{
				type: "exportResult",
				id: requestId,
				ok: true,
				mimeType: blob.type || "image/jpeg",
				buffer: buffer
			},
			[buffer]
		);
	} catch (error) {
		self.postMessage({
			type: "exportResult",
			id: requestId,
			ok: false,
			error: safeErrorMessage(error, "export_failed")
		});
	}
}

self.onmessage = function (event) {
	var message = event && event.data ? event.data : {};
	if (message.type === "init") {
		handleInit(message);
		return;
	}
	if (message.type === "draw") {
		handleDraw(message);
		return;
	}
	if (message.type === "export") {
		handleExport(message);
	}
};
