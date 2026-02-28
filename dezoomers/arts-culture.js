import { compute_signed_path, decrypt_image } from './arts-culture-crypto.js';

function decodeEscapedMetadataText(text) {
	return text
		.replace(/\\u002f/gi, "/")
		.replace(/\\\//g, "/")
		.replace(/\\u003a/gi, ":")
		.replace(/\\u003d/gi, "=")
		.replace(/\\u0026/gi, "&");
}

function normalizeMetadataUrl(rawUrl) {
	let url = rawUrl || "";
	if (url.startsWith("//")) url = "https:" + url;
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(/^\/+/, "").replace(/=.*/, "");
		return {
			baseUrl: parsed.origin + "/" + path,
			path: path
		};
	} catch (_) {
		return null;
	}
}

function scoreMetadataCandidate(url, token) {
	let score = 0;
	if (/\/ci\//i.test(url)) score += 4;
	if (token) score += 3;
	if (/googleusercontent\.com|ggpht\.com/i.test(url)) score += 2;
	return score;
}

function findMetadata(text) {
	const variants = [text];
	const decoded = decodeEscapedMetadataText(text);
	if (decoded !== text) variants.push(decoded);

	const patterns = [
		/]\r?\n?,"(\/\/[a-zA-Z0-9./_\-]+)",(?:"([A-Za-z0-9._\-]+)"|null)/g,
		/"(\/\/(?:lh\d|geo\d)\.(?:googleusercontent\.com|ggpht\.com)\/[^"]+?)",(?:"([A-Za-z0-9._\-]+)"|null)/g
	];

	let best = null;
	for (const variant of variants) {
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			for (let match = pattern.exec(variant); match; match = pattern.exec(variant)) {
				const normalized = normalizeMetadataUrl(match[1]);
				if (!normalized) continue;
				const candidate = {
					url: normalized.baseUrl,
					path: normalized.path,
					token: match[2] || "",
					score: scoreMetadataCandidate(match[1], match[2]),
					index: match.index
				};
				if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.index < best.index)) {
					best = candidate;
				}
			}
		}
	}

	return best;
}

function findFile(baseUrl, callback) {
	ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
		let metadata = findMetadata(text);
		if (!metadata) throw new Error("Unable to find arts and culture image metadata URL");
		callback(metadata.url + "=g", { path: metadata.path, token: metadata.token });
	});
}

function open(url, gapdata) {
	ZoomManager.getFile(url, { type: "xml" }, function (xml, xhr) {
		let int = (e, a) => parseInt(e.getAttribute(a));
		let infos = xml.getElementsByTagName("TileInfo")[0];
		if (!infos) return ZoomManager.error("Invalid XML info file: " + url);
		let tile_w = int(infos, "tile_width");
		let tile_h = int(infos, "tile_height");
		let levels = Array.from(infos.children).map(function (level, level_num) {
			const xtiles = int(level, "num_tiles_x");
			const ytiles = int(level, "num_tiles_y");
			const empty_x = int(level, "empty_pels_x");
			const empty_y = int(level, "empty_pels_y");

			return {
				origin: url,
				width: xtiles * tile_w - empty_x,
				height: ytiles * tile_h - empty_y,
				tileSize: tile_w,
				numTiles: xtiles * ytiles,
				maxZoomLevel: level_num,
				gapdata: gapdata
			}
		}).filter(function (level) {
			return level.width * level.height < UI.MAX_CANVAS_AREA;
		});
		ZoomManager.readyToRender(levels[levels.length - 1]);
	});
}

async function getTileURL(
	x, y, z,
	{ gapdata: { path, token }, origin }
) {
	const tile_path = await compute_signed_path(path, token, x, y, z);
	const tile_url = ZoomManager.resolveRelative("/"+tile_path, origin);
	const buffer = await new Promise(accept =>
		ZoomManager.getFile(tile_url, { type: 'binary', is_tile: true }, accept)
	);
	const tile = await decrypt_image({ buffer });
	const blob = new Blob([tile], { type: "image/jpeg" });
	return URL.createObjectURL(blob);
}


ZoomManager.addDezoomer({
	"name": "Arts & Culture",
	"description": "Zoomable images from the Arts and Culture website",
	"urls": [
		/artsandculture\.google\.com/,
		/\/g.co\/arts\//
	],
	"contents": [],
	findFile, open, getTileURL
});
