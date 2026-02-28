var iipimage = (function(){
  return {
    "name" : "IIPImage",
    "description": "IIPImage image server",
    "urls" : [
      /^((?!topview).)*\?FIF=.*$/, // Topview uses FIF= but is not compatible with iipimage
      /nationalgallery\.org\.uk\/paintings/
    ],
    "contents" : [
      /\?FIF=/
    ],
    "findFile" : function getInfoFile (baseUrl, callback) {
      if (baseUrl.indexOf("?FIF=") > -1) {
        return callback(baseUrl);
      }
      ZoomManager.getFile(baseUrl, {type:"htmltext"}, function (text) {
          var fifMatch = text.match(/["']([^"']*?\?FIF=.*?)["']/);
          if (fifMatch) {
            var path = fifMatch[1];
            var url = ZoomManager.resolveRelative(path, baseUrl);
            return callback(url);
          }
          // Special support for nationalgallery.org.uk
          if (baseUrl.match(/nationalgallery\.org\.uk\/paintings/)){
            var iiifMatch = text.match(/["']([^"']*server\.iip\?IIIF=[^"']+?\.tif)/i);
            if (iiifMatch && iiifMatch[1]) {
              var infoUrl = ZoomManager.resolveRelative(iiifMatch[1] + "/info.json", baseUrl);
              return callback(infoUrl);
            }
            var imageMatch = text.match(/image\s*:\s*("[^"]*")/);
            if (!imageMatch || imageMatch.length < 2) {
              throw new Error("Unable to locate National Gallery image metadata.");
            }
            var image;
            try {
              image = JSON.parse(imageMatch[1]);
            } catch (_) {
              throw new Error("Invalid National Gallery image metadata.");
            }
            return callback('/server.iip/fcgi-bin/iipsrv.fcgi?FIF=' + image);
          }
          throw new Error("No IIPImage-related URL found.");
      });
    },
    "open" : function (url) {
      if (url.indexOf("?IIIF=") > -1 || url.match(/\/info\.json(\?.*)?$/)) {
        var iiifDezoomer = ZoomManager.dezoomersList && ZoomManager.dezoomersList["IIIF"];
        if (!iiifDezoomer) {
          throw new Error("IIIF dezoomer unavailable.");
        }
        ZoomManager.setDezoomer(iiifDezoomer);
        return ZoomManager.open(url);
      }
      var baseUrlMatch = url.match(/^.*\?FIF=[^&]*/);
      if (!baseUrlMatch || !baseUrlMatch[0]) {
        throw new Error("Invalid IIPImage URL.");
      }
      var baseUrl = baseUrlMatch[0];
      var infoUrl = baseUrl + "&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number";
      ZoomManager.getFile(infoUrl, {type:"text"}, function (text, xhr) {
        var sizeMatch = text.match(/Max-size:(\d+) (\d+)/);
        var tileSizeMatch = text.match(/Tile-size:(\d+) (\d+)/);
        var zoomMatch = text.match(/Resolution-number:(\d+)/);
        if (!sizeMatch || !tileSizeMatch ||
            sizeMatch.length !== 3 || tileSizeMatch.length !== 3) {
          throw new Error("Invalid IIPImage information file.");
        }
        var data = {
          "origin": baseUrl,
          "width" : parseInt(sizeMatch[1], 10),
          "height" : parseInt(sizeMatch[2], 10),
          "tileSize" : parseInt(tileSizeMatch[1], 10),
          "maxZoomLevel" : zoomMatch && zoomMatch[1] ? (parseInt(zoomMatch[1], 10) - 1) : 0
        };
        if (!isFinite(data.maxZoomLevel) || data.maxZoomLevel < 0) {
          data.maxZoomLevel = 0;
        }
        ZoomManager.readyToRender(data);
      });
    },
    "getTileURL" : function (x, y, zoom, data) {
      var index = x + y * data.nbrTilesX;
      return data.origin + "&JTL=" + zoom + "," + index;
    }
  };
})();
ZoomManager.addDezoomer(iipimage);
