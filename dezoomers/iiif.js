// IIIF Image API 2.1
var iiif = (function () {
  var urlReg = new RegExp( // IIIF API image URL
    "(https?://[^\"'\\s]+)" + // base
    "(?:/info\\.json|" +
    "/\\^?(?:full|square|(?:pct:)?\\d+,\\d+,\\d+,\\d+)" + // region
    "/\\^?(?:full|max|\\d+,|,\\d+|pct:\\d+|!?\\d+,\\d+)" + // size
    "/!?[1-3]?[0-9]?[0-9]" + // rotation
    "/(?:color|gray|bitonal|default|native)" + // quality
    "\\.(?:jpe?g|tiff?|png|gif|jp2|pdf|webp)" + // format
    ")"
  );
  var gallicaReg = /https?:\/\/gallica\.bnf\.fr\/ark:\/(\w+\/\w+)(?:\/(f\w+))?/
  var polonaReg = /https?:\/\/polona\.pl\/item\/(\d+)(?:\/(\d+))?/i;
  var manifestParamReg = /[?&#]manifest=([^&#]+)/i;
  var blManifestReg = /https?:\/\/bl\.digirati\.io\/(?:iiif|manifests)\/ark:\/[^"'\\\s<>]+/i;
  var genericManifestReg = /https?:\/\/[^"'\\\s<>]+manifest(?:\.json)?(?:\?[^"'\\\s<>]*)?/i;
  function extractUrl(text) {
    var match = text.match(urlReg);
    if (!match) return null;
    var result = match[1] + "/info.json";
    // Van Gogh Museum has hash-protected URLs on micrio.* but not micrio-cdn.* 
    result = result.replace('micrio.vangoghmuseum.nl/iiif', 'micrio-cdn.vangoghmuseum.nl');
    return result;
  }
  function sanitizeURLMatch(raw) {
    if (!raw) return "";
    return String(raw).replace(/[\\\])}>.,;:!?]+$/, "");
  }
  function extractManifestURL(text) {
    if (!text) return null;
    var manifestParamMatch = String(text).match(manifestParamReg);
    if (manifestParamMatch && manifestParamMatch[1]) {
      try {
        return decodeURIComponent(manifestParamMatch[1]);
      } catch (_) {
        return manifestParamMatch[1];
      }
    }
    var blMatch = String(text).match(blManifestReg);
    if (blMatch && blMatch[0]) return sanitizeURLMatch(blMatch[0]);
    var genericMatch = String(text).match(genericManifestReg);
    if (genericMatch && genericMatch[0]) return sanitizeURLMatch(genericMatch[0]);
    return null;
  }
  function looksLikePresentationManifestURL(url) {
    if (!url) return false;
    var lower = String(url).toLowerCase();
    if (lower.indexOf("/info.json") >= 0) return false;
    if (manifestParamReg.test(lower)) return true;
    if (lower.indexOf("/iiif/ark:/") >= 0) return true;
    return /manifest(?:\.json)?(?:$|[?#])/.test(lower);
  }
  return {
    "name": "IIIF",
    "description": "International Image Interoperability Framework",
    "urls": [urlReg, gallicaReg, polonaReg],
    "contents": [urlReg],
    "findFile": function getInfoFile(baseUrl, callback) {

      var gallicaMatch = baseUrl.match(gallicaReg);
      if (gallicaMatch) {
        baseUrl = 'https://gallica.bnf.fr/iiif/ark:/' +
          gallicaMatch[1] + '/' +
          (gallicaMatch[2] || 'f1') +
          '/info.json';
      }

      var polonaMatch = baseUrl.match(polonaReg);
      if (polonaMatch) {
        var polonaItemId = polonaMatch[1];
        var polonaPageIndex = parseInt(polonaMatch[2], 10);
        if (!isFinite(polonaPageIndex) || polonaPageIndex < 0) {
          polonaPageIndex = 0;
        }
        return resolvePolonaManifest(polonaItemId, polonaPageIndex, callback);
      }

      var url = extractUrl(baseUrl);
      if (url) return callback(url);
      var manifestURL = extractManifestURL(baseUrl);
      if (manifestURL || looksLikePresentationManifestURL(baseUrl)) {
        return resolveManifestToInfo(manifestURL || baseUrl, callback);
      }

      ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text) {
        var url = extractUrl(text);
        if (url) return callback(url);
        var manifestURL = extractManifestURL(text);
        if (manifestURL) return resolveManifestToInfo(manifestURL, callback);
        throw new Error("No IIIF URL found.");
      });
    },
    "open": function (url) {
      ZoomManager.getFile(url, { type: "json" }, function (data, xhr) {
        function min(array) { return Math.min.apply(null, array) }
        function searchWithDefault(array, search, defaultValue) {
          // Return the searched value if it's in the array.
          // Else, return the first value of the array, or defaultValue if the array is empty or invalid
          var array = (array && array.length) ? array : [defaultValue];
          return ~array.indexOf(search) ? search : array[0];
        }

        var tiles;
        if (data.tiles && data.tiles.length) {
          tiles = data.tiles.reduce(function (red, val) {
            return min(red.scaleFactors) < min(val.scaleFactors) ? red : val;
          });
        } else {
          // map-view.nls.uk contains invalid tile widths (see dezoomify-rs#92)
          tiles = {
            "width":
              (data.tile_width < data.width)
                ? data.tile_width
                : 512,
            "scaleFactors": [1]
          }
        }

        try {
          if (!data["@id"]) throw new Error("missing iiif @id");
          // See https://github.com/lovasoa/dezoomify/issues/582
          data["@id"] = data["@id"].replace(/^https?, (https?:\/\/)/, '$1');
          var origin = new URL(data["@id"], url);
          if (origin.hostname === "localhost" || origin.hostname === "example.com") {
            throw new Error("probably a test host");
          }
        } catch (e) {
          console.log("Rewriting the @id from the manifest: " + e);
          var origin = url.replace(/\/info\.json(\?.*)?$/, '');
        }
        var returned_data = {
          "origin": origin.toString(),
          "width": parseInt(data.width),
          "height": parseInt(data.height),
          "tileSize": tiles.width,
          "maxZoomLevel": Math.min.apply(null, tiles.scaleFactors),
          "quality": searchWithDefault(data.qualities, "native", "default"),
          "format": searchWithDefault(data.formats, "png", "jpg")
        };
        if (isReliableTileMetadata(data, tiles, returned_data)) {
          // Modern IIIF manifests usually provide valid tile metadata.
          // Skip probing the first tile to reduce one startup network request.
          ZoomManager.readyToRender(returned_data);
          return;
        }
        var img = new Image; // Load a tile to find out the real tile size
        img.src = getTileURL(0, 0, returned_data.maxZoomLevel, returned_data);
        img.addEventListener("load", function () {
          returned_data.tileSize = Math.max(img.width, img.height);
          ZoomManager.readyToRender(returned_data);
        });
        img.addEventListener("error", function () {
          ZoomManager.readyToRender(returned_data); // Try rendering anyway
          ZoomManager.error("Unable to load first tile: " + img.src);
        });
      });
    },
    "getTileURL": getTileURL
  };

  function getTileURL(x, y, zoom, data) {
    var s = data.tileSize,
      pxX = x * s, pxY = y * s;
    //The image size is adjusted for edges
    //width
    if (pxX + s > data.width) {
      sx = data.width - pxX;
    } else {
      sx = s;
    }
    //height
    if (pxY + s > data.height) {
      sy = data.height - pxY;
    } else {
      sy = s;
    }
    return data.origin + "/" +
      pxX + "," + // source image X
      pxY + "," + // source image Y
      sx + "," + // source image width
      sy + "/" + // source image height
      sx + "," + // returned image width
      "" + "/" + // returned image height
      "0" + "/" + //rotation
      data.quality + "." + //quality
      data.format; //format
  }

  function resolvePolonaManifest(itemId, pageIndex, callback) {
    var idUrl = "https://polona.pl/api/library-object-query/digital-objects/new-id/" + encodeURIComponent(itemId);
    ZoomManager.getFile(idUrl, { type: "json" }, function (newId) {
      if (!newId || typeof newId !== "string") {
        throw new Error("Unable to resolve Polona object id.");
      }
      var contentsUrl =
        "https://polona.pl/api/library-object-query/digital-objects/" +
        encodeURIComponent(newId) +
        "/contents";
      ZoomManager.getFile(contentsUrl, { type: "json" }, function (contents) {
        var pages = (contents && contents.pages) || [];
        var page = pages[pageIndex] || pages[0] || null;
        var contentItems = (page && page.content) || [];
        var firstItem = contentItems[0] || null;
        var manifest = firstItem && firstItem.iiifImageAPIManifest;
        if (!manifest) {
          throw new Error("Unable to locate Polona IIIF manifest.");
        }
        callback(manifest);
      });
    });
  }

  function resolveManifestToInfo(manifestURL, callback) {
    ZoomManager.getFile(manifestURL, { type: "json" }, function (manifest) {
      var imageService = findImageServiceFromManifest(manifest);
      if (!imageService) {
        throw new Error("Unable to locate IIIF image service in manifest.");
      }
      imageService = String(imageService).replace(/\/+$/, "");
      callback(imageService + "/info.json");
    });
  }

  function findImageServiceFromManifest(manifest) {
    // IIIF v3 canonical path
    var canvas = manifest && manifest.items && manifest.items[0];
    var annoPage = canvas && canvas.items && canvas.items[0];
    var anno = annoPage && annoPage.items && annoPage.items[0];
    var body = anno && anno.body;
    var service = readServiceID(body && body.service);
    if (service) return service;

    // IIIF v2 canonical path
    var sequence = manifest && manifest.sequences && manifest.sequences[0];
    var v2Canvas = sequence && sequence.canvases && sequence.canvases[0];
    var image = v2Canvas && v2Canvas.images && v2Canvas.images[0];
    var resource = image && image.resource;
    service = readServiceID(resource && resource.service);
    if (service) return service;

    // Fallback for non-canonical manifests.
    return findNestedService(manifest, 0);
  }

  function readServiceID(serviceNode) {
    if (!serviceNode) return null;
    if (typeof serviceNode === "string") return serviceNode;
    if (Array.isArray(serviceNode)) {
      for (var i = 0; i < serviceNode.length; i++) {
        var nested = readServiceID(serviceNode[i]);
        if (nested) return nested;
      }
      return null;
    }
    return serviceNode["@id"] || serviceNode.id || null;
  }

  function findNestedService(node, depth) {
    if (!node || depth > 8) return null;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var nested = findNestedService(node[i], depth + 1);
        if (nested) return nested;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    var direct = readServiceID(node.service);
    if (direct) return direct;
    for (var key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      var nested = findNestedService(node[key], depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  function isReliableTileMetadata(rawData, tiles, parsedData) {
    if (!rawData || !tiles || !parsedData) return false;
    if (!rawData.tiles || !rawData.tiles.length) return false;

    var tileWidth = parseInt(tiles.width, 10);
    var maxDimension = Math.max(parsedData.width || 0, parsedData.height || 0);
    if (!isFinite(tileWidth) || tileWidth <= 0 || tileWidth > maxDimension) {
      return false;
    }

    if (!tiles.scaleFactors || !tiles.scaleFactors.length) return false;
    for (var i = 0; i < tiles.scaleFactors.length; i++) {
      var sf = parseInt(tiles.scaleFactors[i], 10);
      if (!isFinite(sf) || sf <= 0) return false;
    }
    return true;
  }
})();
ZoomManager.addDezoomer(iiif);
