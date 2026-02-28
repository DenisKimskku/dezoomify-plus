"use strict";

const {
  CRON_MAX_JOBS_PER_RUN,
  listOwnerIds,
  loadOwnerState,
  runDueSchedulesForState,
  saveOwnerState,
  sendErrorJSON,
  sendJSON,
  validateCronSecret,
} = require("../lib/jobs-service");
const authService = require("../lib/auth-service");
const {
  ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN,
  ASYNC_MAX_JOBS_PER_CRON_RUN,
  cleanupExpiredJobs,
  runPendingJobs,
} = require("../lib/async-service");
const { createRequestObserver } = require("../lib/observability");

module.exports = async function handler(req, res) {
  const finish = createRequestObserver("cron", req);

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    sendErrorJSON(res, 405, "Only GET and POST requests are supported.");
    finish(405, { reason: "method_not_allowed" });
    return;
  }

  const secretValidation = validateCronSecret(req);
  if (!secretValidation.ok) {
    sendErrorJSON(res, secretValidation.statusCode || 401, secretValidation.message || "Unauthorized.");
    finish(secretValidation.statusCode || 401, { reason: "invalid_cron_secret" });
    return;
  }

  const cronSecretConfigured = !!String(process.env.CRON_SECRET || "").trim();
  if (!cronSecretConfigured && authService.AUTH_ENFORCE_ADVANCED) {
    if (!authService.isStorageReadyForAuth()) {
      sendErrorJSON(res, 503, "Persistent storage is required for authenticated cron access.", {
        code: "STORAGE_UNAVAILABLE",
        message: "Persistent storage is required for authenticated cron access.",
      });
      finish(503, { reason: "storage_unavailable" });
      return;
    }
    const authResult = await authService.resolveRequestAuth(req);
    if (!authResult || !authResult.ok) {
      sendErrorJSON(
        res,
        (authResult && authResult.statusCode) || 401,
        (authResult && authResult.message) || "Unauthorized.",
        {
          code: (authResult && authResult.code) || "UNAUTHORIZED",
          message: (authResult && authResult.message) || "Unauthorized.",
        }
      );
      finish((authResult && authResult.statusCode) || 401, { reason: "unauthorized" });
      return;
    }
    if (!authResult.user || authResult.user.role !== "admin") {
      sendErrorJSON(res, 403, "Admin role is required for cron execution.", {
        code: "FORBIDDEN",
        message: "Admin role is required for cron execution.",
      });
      finish(403, { reason: "forbidden" });
      return;
    }
  }

  const startedAt = Date.now();
  const ownerList = await listOwnerIds();
  const owners = ownerList.owners || [];
  const nowTs = Date.now();
  let remainingJobs = CRON_MAX_JOBS_PER_RUN;
  let processedOwners = 0;
  let jobsRun = 0;
  let successCount = 0;
  let errorCount = 0;
  let skippedDuplicateCount = 0;
  let historyPurged = 0;

  for (let i = 0; i < owners.length; i += 1) {
    if (remainingJobs <= 0) break;
    const ownerId = owners[i];
    const loaded = await loadOwnerState(ownerId);
    const result = await runDueSchedulesForState(loaded.state, remainingJobs, nowTs);
    if (result.changed) {
      await saveOwnerState(ownerId, result.state);
    }
    processedOwners += 1;
    jobsRun += result.jobsRun;
    successCount += result.successCount;
    errorCount += result.errorCount;
    skippedDuplicateCount += result.skippedDuplicateCount || 0;
    historyPurged += result.historyPurged || 0;
    remainingJobs -= result.jobsRun;
  }

  const asyncResult = await runPendingJobs(ASYNC_MAX_JOBS_PER_CRON_RUN, nowTs);
  const asyncCleanup = await cleanupExpiredJobs(ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN, nowTs);

  sendJSON(res, 200, {
    ok: true,
    at: new Date(nowTs).toISOString(),
    ownersSeen: owners.length,
    ownersProcessed: processedOwners,
    jobsRun: jobsRun,
    skippedDuplicate: skippedDuplicateCount,
    historyPurged: historyPurged,
    success: successCount,
    error: errorCount,
    maxJobsPerRun: CRON_MAX_JOBS_PER_RUN,
    asyncJobsRun: asyncResult.jobsRun,
    asyncSuccess: asyncResult.successCount,
    asyncError: asyncResult.errorCount,
    asyncOwnersSeen: asyncResult.ownersSeen,
    asyncOwnersProcessed: asyncResult.ownersProcessed,
    asyncMaxJobsPerRun: ASYNC_MAX_JOBS_PER_CRON_RUN,
    asyncCleanupScanned: asyncCleanup.jobsScanned,
    asyncCleanupMarkedExpired: asyncCleanup.jobsMarkedExpired,
    asyncCleanupPurged: asyncCleanup.jobsPurged,
    asyncCleanupFinishedPurged: asyncCleanup.jobsFinishedPurged,
    asyncCleanupMissingRemoved: asyncCleanup.missingRemoved,
    asyncCleanupOwnersSeen: asyncCleanup.ownersSeen,
    asyncCleanupOwnersProcessed: asyncCleanup.ownersProcessed,
    asyncCleanupMaxJobsPerRun: ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN,
    asyncBackend: asyncResult.backend,
    durationMs: Date.now() - startedAt,
    backend: ownerList.backend,
  });
  finish(200, {
    ownersSeen: owners.length,
    ownersProcessed: processedOwners,
    jobsRun: jobsRun,
    skippedDuplicate: skippedDuplicateCount,
    historyPurged: historyPurged,
    success: successCount,
    error: errorCount,
    asyncJobsRun: asyncResult.jobsRun,
    asyncSuccess: asyncResult.successCount,
    asyncError: asyncResult.errorCount,
    asyncCleanupScanned: asyncCleanup.jobsScanned,
    asyncCleanupMarkedExpired: asyncCleanup.jobsMarkedExpired,
    asyncCleanupPurged: asyncCleanup.jobsPurged,
    asyncCleanupFinishedPurged: asyncCleanup.jobsFinishedPurged,
    asyncCleanupMissingRemoved: asyncCleanup.missingRemoved,
    backend: ownerList.backend,
  });
};
