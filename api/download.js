"use strict";

const { createRequestObserver } = require("../lib/observability");
const { getArtifactForOwner, parseByteRange } = require("../lib/async-service");
const { resolveOwnerContext, sendErrorJSON } = require("../lib/jobs-service");

function toSingle(value) {
  return Array.isArray(value) ? value[0] : value;
}

function setDownloadHeaders(res, artifact) {
  const contentType = artifact && artifact.contentType ? artifact.contentType : "application/octet-stream";
  const filename = artifact && artifact.filename ? artifact.filename : "artifact.bin";
  const safeFileName = encodeURIComponent(filename);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + safeFileName);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Accept-Ranges", "bytes");
  if (artifact && artifact.sha256) {
    res.setHeader("ETag", "\"" + artifact.sha256 + "\"");
  }
}

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("download", req);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendErrorJSON(res, 405, "Only GET and HEAD requests are supported.");
    finish(405, { reason: "method_not_allowed" });
    return;
  }

  const owner = await resolveOwnerContext(req);
  if (owner.error) {
    sendErrorJSON(res, owner.statusCode || 400, owner.error, {
      code: owner.code || "REQUEST_FAILED",
      message: owner.error,
    });
    finish(owner.statusCode || 400, { reason: "owner_resolution_failed" });
    return;
  }

  const query = req.query || {};
  const jobID = toSingle(query.id || query.job_id || "");
  if (!jobID) {
    sendErrorJSON(res, 400, "Missing required query parameter: id.");
    finish(400, { reason: "missing_id" });
    return;
  }

  const artifactResult = await getArtifactForOwner(owner.ownerId, jobID);
  if (!artifactResult.ok) {
    sendErrorJSON(res, artifactResult.statusCode || 404, artifactResult.message || "Artifact unavailable.");
    finish(artifactResult.statusCode || 404, { reason: artifactResult.code || "artifact_unavailable" });
    return;
  }

  const buffer = artifactResult.buffer;
  const totalSize = buffer.length;
  setDownloadHeaders(res, artifactResult.artifact);

  const range = parseByteRange(req.headers.range || "", totalSize);
  if (range && !range.valid) {
    res.statusCode = 416;
    res.setHeader("Content-Range", "bytes */" + totalSize);
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end("Requested range not satisfiable.\n");
    }
    finish(416, { reason: "invalid_range" });
    return;
  }

  if (!range) {
    res.statusCode = 200;
    res.setHeader("Content-Length", String(totalSize));
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(buffer);
    }
    finish(200, { reason: "full_download", size: totalSize });
    return;
  }

  const start = range.start;
  const end = range.end;
  const chunk = buffer.slice(start, end + 1);
  res.statusCode = 206;
  res.setHeader("Content-Length", String(chunk.length));
  res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + totalSize);
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(chunk);
  }
  finish(206, { reason: "partial_download", size: chunk.length });
};
