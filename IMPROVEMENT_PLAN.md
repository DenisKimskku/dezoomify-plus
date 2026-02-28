# Dezoomify Improvement Plan (13 Steps)

Status legend: `DONE`, `NEXT`, `PLANNED`

1. `DONE` Proxy hardening (SSRF, host/IP blocklist, TLS verification, stricter CORS)
2. `DONE` API auth + rate limiting + quotas
3. `DONE` Replace deprecated runtime dependencies (`request`, legacy wrangler/node assumptions)
4. `DONE` Deterministic test suite with fixtures/replays (reduce external live URL flakiness)
5. `DONE` CI modernization (Node LTS matrix + browser test stability + scheduled canaries)
6. `DONE` Modularize architecture (`core`, `dezoomers`, `ui`, `service`)
7. `DONE` Observability (structured logs, failure buckets, basic metrics)
8. `DONE` Bounded tile concurrency queue in renderer
9. `DONE` Adaptive global backoff + dynamic concurrency tuning
10. `DONE` Direct tile fetch first; proxy fallback only when required
11. `DONE` IIIF optimization: avoid probe tile when manifest metadata is reliable
12. `DONE` Move rendering/decode off main thread (Web Worker + OffscreenCanvas path)
13. `DONE` Async service API (`submit/status/download`) + resumable outputs

## Current Execution Slice

- Implemented step 8 in `zoommanager.js` by replacing serial dispatch with a bounded in-flight queue.
- Implemented step 9 in `zoommanager.js` with global jittered backoff and automatic concurrency adjustment.
- Implemented step 1 by hardening `proxy.php`, `node-app/proxy.js`, and cloudflare worker proxies.
- Implemented step 10 with direct tile fetch first and automatic proxy fallback in `zoommanager.js`.
- Replaced deprecated `request` usage in `node-app/proxy.js` and `node-app/dezoomify-node.js` with native HTTP clients.
- Added real-time tiles/sec and ETA display to observe queue/backoff performance in production runs.
- Added Vercel deployment path with `/api/proxy` + `/proxy.php` rewrite and embedding URL parameters (`url`, `autostart`, `concurrency`).
- Added per-IP proxy rate limiting headers and a polished operations UI with service limits, scheduling, and job history panels.
- Added API-key based auth with persistent quota tracking support (Vercel KV REST), plus client-side API key controls.
- Added server-backed job state API (`/api/jobs`) and always-on scheduler executor (`/api/cron`) with Vercel cron wiring.
- Added cron-safe schedule probes with SSRF protections, owner isolation, KV persistence, and browser local fallback mode.
- Added deterministic, zero-network unit tests for jobs state/scheduler transitions (`tests/jobs-service.test.js`).
- Added baseline jobs-state benchmark harness (`tests/bench-jobs-state.js`) and npm scripts in `tests/package.json`.
- Modernized CI workflow to run Node 18/20 syntax + deterministic jobs tests, plus browser integration tests.
- Updated node runtime requirements for `node-app` docs/package metadata to Node 18+.
- Added deterministic proxy handler regression tests (`tests/proxy-handler.test.js`) for auth, SSRF block, and header behavior.
- Added benchmark guardrail thresholds in CI (`BENCH_MAX_PER_JOB_MS`, `BENCH_MAX_DURATION_MS`).
- Modernized Cloudflare worker package/config to Wrangler v3 module-worker flow.
- Added deterministic zoommanager queue/backoff tests (`tests/zoommanager-queue.test.js`).
- Added benchmark artifact publishing and summary output in CI for trend tracking.
- Added structured API request logs + in-memory metrics buckets with optional `/api/metrics` access token.
- Added deterministic IIIF fast-path/fallback tests (`tests/iiif-fastpath.test.js`).
- Added deterministic `/api/metrics` handler tests (`tests/metrics-handler.test.js`).
- Added a Service Metrics operations panel in the frontend with token + auto-refresh support.
- Added rolling per-minute observability buckets and alert thresholds for 5xx ratio and quota/rate-limit spikes.
- Added richer metrics UX with KPI cards, active alert badges, and sparkline charts.
- Added long-lived benchmark trend persistence (`/api/benchmarks`) with optional token auth.
- Added deterministic benchmark API coverage (`tests/benchmarks-handler.test.js`) and observability alert tests (`tests/observability-alerts.test.js`).
- Added optional CI publish hook (`tests/publish-bench-trend.js`) to push benchmark results to deployed `/api/benchmarks`.
- Added off-main-thread tile fetch/decode/render path via `render-worker.js` + `OffscreenCanvas`, with fallback and worker export support.
- Added deterministic worker-render fallback coverage in `tests/zoommanager-queue.test.js`.
- Added async service library (`lib/async-service.js`) with persistent submit/status/download jobs and artifact TTL controls.
- Added `/api/submit`, `/api/status`, and `/api/download` handlers with owner isolation and byte-range downloads.
- Extended `/api/cron` to process queued async jobs and emit async run counters.
- Added deterministic coverage for async core/handlers/cron (`tests/async-service.test.js`, `tests/async-handlers.test.js`, `tests/cron-handler.test.js`).
- Added async artifact storage modes (`auto`/`inline`/`chunked`) with chunk key persistence and cleanup-on-expiry in `lib/async-service.js`.
- Added deterministic chunked artifact coverage in `tests/async-service.test.js`.
- Added an Async Queue frontend operations panel (submit, poll, retry, download, tracked-job lifecycle controls) in `index.html`, `browser-init.js`, and `style.css`.
- Started step 6 modularization by extracting async queue runtime from `browser-init.js` into `ui/async-queue.js` with a controller bridge.
- Wired the new UI module in `index.html` and added CI syntax coverage for `ui/async-queue.js`.
- Continued step 6 modularization by extracting history panel runtime into `ui/history-panel.js`.
- Continued step 6 modularization by extracting schedule panel runtime into `ui/schedule-panel.js`, with controller hooks for create/run/toggle/delete and schedule interval math.
- Updated `browser-init.js` to use thin bridges for history/schedule panels while preserving server-sync behavior.
- Added CI syntax coverage for `ui/history-panel.js` and `ui/schedule-panel.js`.
- Continued step 6 modularization by extracting Service Limits panel runtime into `ui/limits-panel.js`.
- Continued step 6 modularization by extracting Service Metrics panel runtime into `ui/metrics-panel.js` (token controls, trend charts, KPI/alert rendering, endpoint polling).
- Updated `browser-init.js` to delegate limits/metrics handling through controller bridges and reduced metrics-specific inline logic.
- Added CI syntax coverage for `ui/limits-panel.js` and `ui/metrics-panel.js`.
- Continued step 6 modularization by extracting server jobs sync state machine into `ui/jobs-sync-controller.js` (endpoint auth wiring, debounce push, bootstrap pull/push, retry cooldown, storage-mode state emission).
- Continued step 6 modularization by extracting API key UI runtime into `ui/api-key-controls.js` (query/local bootstrap + save/clear identity reload hooks).
- Updated `browser-init.js` to delegate API key + jobs sync behavior through thin controller bridges while preserving scheduler/history state ownership.
- Added script wiring in `index.html` and CI syntax coverage for `ui/jobs-sync-controller.js` and `ui/api-key-controls.js`.
- Added async admin APIs for cross-device operations: `/api/list` (owner-scoped listing/filtering/pagination) and `/api/retry` (controlled retries with owner isolation).
- Extended `lib/async-service.js` with `listJobsForOwner`, `retryJobForOwner`, and `runJobNowForOwner`; updated `api/submit.js` process-now path to target submitted job deterministically.
- Upgraded `ui/async-queue.js` to pull remote jobs from `/api/list` and use `/api/retry` for server-side retries (fallback to submit when retry API is unavailable).
- Expanded deterministic coverage for new async list/retry behavior in `tests/async-service.test.js` and `tests/async-handlers.test.js`.
- Improved Async Queue UX with status/query filters and visible-scope bulk actions (`Retry Visible Failed`, `Remove Visible Finished`) using server-backed list/retry APIs.
- Updated docs for async API surface (`/api/list`, `/api/retry`) and `ASYNC_LIST_MAX_LIMIT`, aligned to Vercel deployment workflows.
- Added Vercel-KV async housekeeping via cron: owner-scoped expired-job scanning/marking/purging with configurable cleanup caps and grace windows.
- Extended `/api/cron` response telemetry with async cleanup counters and added deterministic cleanup coverage in `tests/async-service.test.js` + `tests/cron-handler.test.js`.
- Added owner-scoped server-side bulk async operations endpoints: `/api/retry-bulk` and `/api/remove-bulk`, backed by `retryJobsForOwner`/`removeJobsForOwner` in `lib/async-service.js`.
- Updated async queue bulk controls to use bulk APIs first with automatic fallback to per-job operations if bulk endpoints are unavailable.
- Expanded deterministic coverage for bulk service/handler behavior in `tests/async-service.test.js` and `tests/async-handlers.test.js`.
- Continued step 6 modularization by extracting bootstrap/form/timer orchestration from `browser-init.js` into `ui/bootstrap-runtime.js` (concurrency controls, quick actions, start URL/autostart, poll loops).
- Updated `browser-init.js` to keep thin runtime wiring callbacks and removed duplicated bootstrap logic inline.
- Continued step 6 modularization by extracting jobs/history/schedule lifecycle orchestration into `ui/jobs-orchestrator.js` (local persistence, active-job lifecycle, schedule trigger/tick orchestration, server-state apply).
- Updated `browser-init.js` to delegate job run/finalize, schedule actions, history clear/rerun, and local state formatting through the new orchestrator bridge.
- Added deterministic frontend smoke coverage (`tests/frontend-smoke.test.js`) for UI factory exports, browser-init wiring boot, and `index.html` script-order validation.
- Added CI + npm wiring for frontend smoke checks (`tests/package.json`, `.github/workflows/node.js.yml`).
- Continued step 6 modularization by extracting API-key + server jobs-sync orchestration into `ui/service-sync-runtime.js` (identity wiring, storage-state bridging, server sync delegation).
- Updated `browser-init.js` to delegate API key identity handling and jobs sync bootstrap/polling through `serviceSyncRuntime`.
- Expanded frontend smoke checks for the new runtime module and script-order requirements.
- Continued step 6 modularization by extracting limits/metrics/async panel glue into `ui/operations-runtime.js` (panel initialization and refresh/summary bridges).
- Continued step 6 modularization by extracting bootstrap runtime bridge wiring into `ui/bootstrap-bridge.js`.
- Updated `browser-init.js` to delegate panel refresh/state hooks through `operationsRuntime` and bootstrap lifecycle through `bootstrapBridge`.
- Expanded deterministic frontend smoke coverage for new runtime exports and boot wiring expectations.
- Continued step 6 modularization by extracting history/schedule panel wiring into `ui/jobs-panels-runtime.js`.
- Continued step 6 modularization by extracting startup sequence orchestration into `ui/startup-sequencer.js`.
- Updated `browser-init.js` to delegate history/schedule panel setup through `jobsPanelsRuntime` and boot order through `startupSequencer`.
- Expanded frontend smoke coverage for `jobsPanelsRuntime` and `startupSequencer` exports and startup calls.
- Continued step 6 modularization by extracting the remaining app orchestration into `ui/app-runtime.js`.
- Reduced `browser-init.js` to a thin composition root that only injects config/DOM dependencies into `createAppRuntime`.
- Expanded frontend smoke coverage to validate both `app-runtime` boot wiring and `browser-init` delegation.
- Added shared helper module `ui/runtime-utils.js` for storage-state defaults/normalization and common date/time formatting/parsing helpers.
- Updated `ui/app-runtime.js`, `ui/jobs-orchestrator.js`, `ui/operations-runtime.js`, and `ui/service-sync-runtime.js` to consume shared helpers and reduce duplicated fallback logic.
- Added script + CI wiring for `ui/runtime-utils.js` and expanded smoke assertions for runtime-utils export/order.
- Continued low-risk helper convergence by wiring `ui/history-panel.js`, `ui/schedule-panel.js`, and `ui/metrics-panel.js` to prefer shared `runtime-utils` date/time formatters/parsers when controller overrides are not provided.
- Added shared storage utility module `ui/storage-utils.js` and shared HTTP utility module `ui/http-client.js`, wired into async/jobs/metrics flows to reduce duplicated localStorage and fetch/error code.
- Expanded frontend smoke coverage to include interaction-level checks for history filtering/pagination fallback and async queue windowed rendering/load-more behavior.
- Added async queue rendering/perf upgrades: windowed list rendering (`pageSize` + `Load More`), debounced search, partial row patching on status refresh, and panel-level Retry-After handling.
- Introduced adaptive polling cadence for server/metrics/async loops in `ui/bootstrap-runtime.js` with jitter and in-flight overlap guards, driven by runtime activity signals from `ui/app-runtime.js`.
- Added owner-scoped `GET /api/history` endpoint with filter/query/pagination and upgraded Job History UI with status/query filters, server-backed paging, and local fallback.
- Added schedule duplicate guardrails in `ui/jobs-orchestrator.js` and cron duplicate URL suppression with minimum spacing (`JOBS_MIN_URL_SPACING_MS`) in `lib/jobs-service.js`.
- Added async cancellation support end-to-end (`POST /api/cancel` + `canceled` status in service/UI/tests) including cancel action in Async Queue panel.
- Added retention controls UI (`ui/retention-controls.js`) with local persistence and startup pruning for history/async finished jobs; added server-side finished async retention (`ASYNC_FINISHED_RETENTION_MS`) and server history retention (`JOBS_HISTORY_RETENTION_MS`) with new cron counters.
- Enhanced metrics UI with latency bucket summary lines, alert history hints, and per-snapshot delta text ("what changed").
- Added new deterministic/perf checks (`tests/history-handler.test.js`, `tests/async-ui-perf.test.js`, `tests/bench-async-endpoints.js`) and CI guardrails for async UI rendering and async endpoint benchmarks.

## Next Execution Slice

1. Add deterministic API tests for `/api/cancel` conflict paths and `/api/history` auth/fallback edge cases to broaden negative-coverage.
2. Add pagination/window controls for Async Queue (`Previous` + cursor-backed server paging) to complement current windowed rendering.
3. Tune retention defaults and cron cleanup budgets against production traffic once deployed on Vercel/KV.
