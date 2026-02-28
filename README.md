# Dezoomify

[![Dezoomify cover image](./cover.png)](https://ophir.alwaysdata.net/dezoomify/dezoomify.html)

## Download zoomable images

_Dezoomify_ extracts full high-resolution images from online zoomable image interfaces.
It works with several zoomable image tools, from several different websites (see the list below).
It takes as input the URL of a a zoomable image and gives as output an image that you can download (by right-clicking on it, and choosing *Save Image as...*).

In order to find the URL of the zoomable that dezoomify requires, you can install the [**dezoomify browser extension**](https://github.com/lovasoa/dezoomify-extension/#dezoomify-extension). Alternatively, you can also try to [find the zoomable image URL yourself](https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ).

## Try it
If you are not interested in the source code and just want to assemble tiles of (dezoomify) a zoomify-powered image, go there : [**unzoomify an image**](https://ophir.alwaysdata.net/dezoomify/dezoomify.html)

## Troubleshooting
#### FAQ
If you have problems while downloading an image, then read the **[FAQ](https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ)**.
#### Reporting issues
Your bug reports and feature requests are welcome!
Please go the the [Github issue page of the project](https://github.com/lovasoa/dezoomify/issues),
and explain your problem.
Please be clear, and give the URL of the page containing the image dezoomify
failed to process.

## Supported zoomable image formats
The following formats are supported by dezoomify:

* [Zoomify](http://www.zoomify.com/) : Most common zoomable image format. *dezoomify* used to support only this, hence the name.
* [Deep Zoom](http://en.wikipedia.org/wiki/Deep_Zoom) : Zoomable image format created by Microsoft. Dezoomify has a special support for the following websites that use *Deep Zoom*:
  * The [British Library](http://www.bl.uk/)
  * [National Gallery](http://www.nationalgallery.org.uk/) : The national gallery uses its own zoomable image format.
  * The [World Digital Library (WDL)](http://www.wdl.org/fr/)
  * [Polona](http://polona.pl/), the Polish Digital National Library
  * [BALaT](http://balat.kikirpa.be/), Belgian Art Links and Tools
* [Arts & Culture](https://artsandculture.google.com/) (formerly Google Art Project): a cooperation between google and several international museums. [More info about the controversy around this dezoomer.](https://github.com/lovasoa/dezoomify/issues/435).
* [IIIF](https://iiif.io): The International Image Interoperability Framework, used on many websites, including:
  * [Gallica](https://gallica.bnf.fr/), the numeric library of the French national library
  * [Bavarikon](https://www.bavarikon.de/)
  * [Harvard's library](https://library.harvard.edu/)
* [Zoomify single-file format](https://github.com/lovasoa/pff-extract/wiki/Zoomify-PFF-file-format-documentation) : Less common format used by zoomify, where all tiles are in a single *.pff* file, and are queried through a java servlet.
* [XLimage](http://www.centrica.it/products/xlimage-2/), a zoomable image format developed by an Italian company. It is used on the following websites:
  * The [Royal Library of Belgium](http://kbr.be/)
* **TopViewer**, also named **Memorix Maior picture viewer** used on the following websites:
  * [daguerreobase](http://daguerreobase.org/en/), a collection of daguerreotypes.
  * [Several dutch websites](https://picturae.com/nl/website/websites-portfolio) developed by the company picturae.
* [krpano Panorama Viewer](http://krpano.com), mainly used in panoramic images and interactive virtual tours.
* [The Tretiakov gallery](http://www.tretyakovgallery.ru/en/), official website of the Третьяковская галерея (in Moscow).
* [FSI Viewer](https://www.neptunelabs.com/products/fsi-viewer/), zoomable image server by NeptuneLabs GmbH.
* [Visual Library Server](https://www.semantics.de/visual_library/), by semantics
* [Micr.io](https://micr.io/)'s non-IIIF format, used on [vangoghmuseum.nl](https://www.vangoghmuseum.nl/en/explore-the-collection)
* [Hungaricana](https://hungaricana.hu/en/) a format found only on the **Hungarian Cultural Heritage Portal**, that hosts half a million images.

The most prominant supported websites include :
- Arts & Culture (artsandculture.google.com)
- Gallica (gallica.bnf.fr)
- The British Library (bl.uk)
- National Gallery of Art (nga.gov)
- Hungaricana (hungaricana.hu)
- National Library of Australia (nla.gov.au)
- National Library of Israel (nli.org.il)
- National Galleries Of Scotland (nationalgalleries.org)
- National Library of Scotland (nls.uk)
- Harvard Library (library.harvard.edu)
- heidICON, Heidelberg University (heidicon.ub.uni-heidelberg.de)
- Geographicus (geographicus.com)
- Archivio di Stato di Trieste (archiviodistatotrieste.it)


Dezoomify also has a
[generic dezoomer](https://github.com/lovasoa/dezoomify/wiki/Generic-dezoomer-tutorial).
If the zoomable image format is simple enough, you just have to enter a pattern of tile
URL, and dezoomify will be able to work with it.

## Screenshots
![dezoomify downloading an image](https://user-images.githubusercontent.com/552629/95110615-9723ba80-073e-11eb-8845-2ccf6e557480.gif)

## Video tutorial
[![Video tutorial for dezzomify](http://pix.toile-libre.org/upload/original/1460095793.png)](https://www.youtube.com/watch?v=RtyckiAE5Eo)

# Programming Languages
The aim of the script is to do as much as possible in _Javascript_ (with the HTML5 `<canvas>` tag), and only the network-related stuffs on the server side. The only little piece of server-side code that remains in the code is just a proxy, used to circumvent the [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy).
We implemented this code both in Javascript ([node-app/proxy.js](node-app/proxy.js)) and PHP ([proxy.php](proxy.php)), so you just need to have either one
on your server to run dezoomify.

## Wikimedia
This script on wikimedia : [Zoomify in the help about zoomable Images on wikimedia](https://secure.wikimedia.org/wikipedia/commons/wiki/Help:Zoomable_images)

## Local development

You can run the script locally, using php:

```bash
# Install the dependencies
sudo apt install php-cli

# Run the script
php -S localhost:3000
```

Then open http://localhost:3000/ in your browser.

### Deterministic jobs tests

The server-side jobs/scheduling logic includes deterministic, zero-network tests:

```bash
cd tests
npm run test:jobs
```

### Deterministic proxy tests

The Vercel proxy handler also has deterministic, zero-network regression tests:

```bash
cd tests
npm run test:proxy
```

### Deterministic metrics tests

The `/api/metrics` auth and response behavior has deterministic tests:

```bash
cd tests
npm run test:metrics
```

### Deterministic benchmark API tests

The benchmark trend API (`/api/benchmarks`) is covered by deterministic tests:

```bash
cd tests
npm run test:benchmarks
```

### Deterministic observability alert tests

5xx/quota alert threshold behavior in the observability layer is covered by deterministic tests:

```bash
cd tests
npm run test:observability
```

### Deterministic async service tests

The async submit/status/download service is covered by deterministic tests:

```bash
cd tests
npm run test:async-service
npm run test:async-handlers
npm run test:cron
```

### Deterministic IIIF tests

IIIF fast-path and fallback probe behavior is covered by deterministic tests:

```bash
cd tests
npm run test:iiif
```

### Deterministic queue/backoff tests

Tile queue/adaptive backoff logic (including worker-render fallback behavior) in `zoommanager.js` is covered by deterministic tests:

```bash
cd tests
npm run test:zoommanager
```

### Jobs-state benchmark

Run a quick local benchmark for schedule processing throughput:

```bash
cd tests
npm run bench:jobs
```

You can also provide custom values:

```bash
node bench-jobs-state.js 2000 500
```

> The benchmark follows service caps (`JOBS_MAX_SCHEDULES`, default `120`).

CI guardrails can be enabled with:

- `BENCH_MAX_PER_JOB_MS`
- `BENCH_MAX_DURATION_MS`
- `BENCH_OUTPUT_FILE` (optional JSON artifact output path)

Optional trend publish command:

```bash
node publish-bench-trend.js ./bench-jobs.json
```

With environment variables:

- `BENCHMARK_TREND_ENDPOINT` (deployed `/api/benchmarks` URL)
- `BENCHMARK_WRITE_TOKEN` (if configured)
- `BENCHMARK_SUITE` (defaults to `jobs-state`)

## Deploy on Vercel

This repository can be deployed directly as a Vercel app.

1. Import the repository in Vercel.
2. Keep the root directory as-is.
3. Deploy.

The project includes:
- `/api/proxy` as a serverless proxy endpoint.
- `/api/jobs` for persisted schedule/history state.
- `/api/cron` for background schedule execution.
- `/api/metrics` for runtime service metrics snapshots.
- `/api/benchmarks` for persistent benchmark trend history.
- `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`, `/api/auth/key`, `/api/auth/key/rotate` for account and key lifecycle.
- `/api/storage-health` for runtime storage diagnostics.
- `/api/submit`, `/api/status`, `/api/download`, `/api/list`, `/api/history`, `/api/retry`, `/api/retry-bulk`, `/api/remove-bulk`, `/api/cancel` for async artifact jobs and operations UX.
- `vercel.json` rewrite from `/proxy.php` to `/api/proxy` for compatibility with existing frontend code.
- `vercel.json` cron entry (`0 3 * * *`) that hits `/api/cron` once daily (Hobby-compatible).

Primary hosted target is Vercel serverless + persistent storage (`KV_REST_API_URL`/`KV_REST_API_TOKEN` or `REDIS_URL`).

## Embed in your website

You can link users directly with prefilled URL parameters:

- `?url=...` : prefill the target URL.
- `?autostart=1` : auto-start download after page load.
- `?concurrency=12` : set initial download speed.
- `?worker_render=0` : force classic main-thread rendering mode (disable worker/offscreen path).
- `?api_key=...` : preload API key into the UI/session.
- `?metrics_token=...` : preload metrics token for the Service Metrics panel.

> In browser-based deployments, API keys are user-visible. Use scoped keys with limited quotas.

Example:

```text
https://your-dezoomify-app.vercel.app/?url=https%3A%2F%2Fmap-view.nls.uk%2Fiiif%2F19619%252F196194600%2Finfo.json&autostart=1
```

## UX features for hosted deployments

The web UI now includes:

- **Public downloader**: paste URL, tune tile concurrency, and run direct dezoomify flow.
- **Account shell**: create account/sign in, view session state, rotate personal API key.
- **Dashboard tabs**: queue, history, schedules, metrics, and settings (including storage health).
- **Service limits + rate feedback**: includes retry-after behavior and quota identity details.
- Automatic off-main-thread tile rendering in supported browsers (Web Worker + OffscreenCanvas), with fallback to classic mode.

Storage fallback behavior:

- If `/api/jobs` is reachable, schedules/history are persisted on the server.
- If not, the UI automatically falls back to browser local storage.

## Always-on scheduling (Vercel Cron + server state)

This repo now supports always-on schedule execution through `/api/cron`.

Recommended environment variables:

- `CRON_SECRET` (optional but recommended): if set, `/api/cron` requires this secret (query, `x-cron-secret`, or `Authorization: Bearer ...`).
- `CRON_MAX_JOBS_PER_RUN` (default: `25`): cap scheduled jobs handled per cron invocation.
- `JOBS_MAX_SCHEDULES` (default: `120`): max schedules stored per owner.
- `JOBS_MAX_HISTORY` (default: `200`): max history entries stored per owner.
- `JOBS_PROBE_TIMEOUT_MS` (default: `15000`): timeout for each scheduled URL probe.
- `JOBS_PROBE_MAX_REDIRECTS` (default: `2`): redirect cap for scheduled URL probe.
- `JOBS_MIN_URL_SPACING_MS` (default: `60000`): minimum spacing between identical schedule URLs in a cron pass.
- `JOBS_HISTORY_RETENTION_MS` (default: `2592000000`): server-side history retention window.
- `ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN` (default: `120`): async cleanup scan budget per cron run.
- `ASYNC_CLEANUP_EXPIRED_GRACE_MS` (default: `3600000`): grace period after expiry before async jobs are purged.
- `ASYNC_FINISHED_RETENTION_MS` (default: `604800000`): purge completed/error/canceled async jobs older than this retention window.
- `JOBS_REQUIRE_API_KEY` / `JOBS_DISABLE_ANON`: optional overrides for jobs API auth mode. Defaults inherit `API_AUTH_REQUIRED` / `API_DISABLE_ANON`.
- `JOBS_STATE_KEY_PREFIX` / `JOBS_OWNER_REGISTRY_KEY`: optional key namespace overrides in KV.

`/api/cron` also runs async queue housekeeping (owner-scoped expired-job cleanup) when async APIs are enabled.

State backend:

- Uses `KV_REST_API_URL` + `KV_REST_API_TOKEN` when configured.
- Uses `REDIS_URL` when KV REST variables are not set.
- Falls back to in-memory state for non-authenticated fallback paths only.

## Async service API (`submit/status/download/list/history/retry/retry-bulk/remove-bulk/cancel`)

The service exposes an async artifact flow with resumable download support.

Endpoints:

- `POST /api/submit` with JSON body: `{ "url": "https://..." }`
- `GET /api/status?id=<job_id>`
- `GET /api/download?id=<job_id>`
- `GET /api/list?status=queued,error&limit=30&cursor=0&q=<search>`
- `GET /api/history?status=error&limit=20&cursor=0&q=<search>`
- `POST /api/retry` with JSON body: `{ "id": "<job_id>" }`
- `POST /api/retry-bulk` with JSON body: `{ "ids": ["<job_id>", "..."] }`
- `POST /api/remove-bulk` with JSON body: `{ "ids": ["<job_id>", "..."] }`
- `POST /api/cancel` with JSON body: `{ "id": "<job_id>" }`

Notes:

- `/api/download` supports `Range` headers (`Accept-Ranges: bytes`) for resumable transfers.
- `POST /api/submit` supports `process_now=1` (query or body) to process the new job immediately.
- `POST /api/retry` supports `process_now=1` (query or body) to process the retried job immediately.
- `POST /api/retry-bulk` supports `process_now=1` (query or body) for immediate processing.
- `/api/list` is owner-scoped and supports `status`, `limit`, `cursor`, and `q` filters.
- `/api/history` is owner-scoped and supports `status`, `limit`, `cursor`, and `q` filters.
- `POST /api/cancel` cancels `queued` async jobs and returns `409` for non-cancelable states.
- `/api/retry-bulk` and `/api/remove-bulk` are owner-scoped and capped by `ASYNC_BULK_MAX_IDS`.
- If `AUTH_ENFORCE_ADVANCED=true`, advanced endpoints require session or user API key.

## Account auth + user API keys

Endpoints:

- `POST /api/auth/register` body `{ "email": "...", "password": "..." }`
- `POST /api/auth/login` body `{ "email": "...", "password": "..." }`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `GET /api/auth/key`
- `POST /api/auth/key/rotate`
- `GET /api/storage-health`

Auth environment variables:

- `AUTH_ENFORCE_ADVANCED` (`true`/`false`, default `false`)
- `AUTH_OPEN_SIGNUP` (`true`/`false`, default `true`)
- `AUTH_SESSION_COOKIE` (default `dz_session`)
- `AUTH_SESSION_TTL_MS` (default `604800000`)
- `AUTH_PASSWORD_MIN_LENGTH` (default `8`)
- `ADMIN_EMAILS` (comma-separated admin accounts)
- `HOBBY_CRON_ONLY` (`true`/`false`) for daily-only schedule UX messaging

Storage requirement:

- Account features require persistent storage.
- Configure either:
  - `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or
  - `REDIS_URL`

Environment variables:

- `ASYNC_SUBMIT_PROCESS_NOW` (`true`/`false`, default `false`)
- `ASYNC_MAX_JOBS_PER_OWNER` (default `200`)
- `ASYNC_MAX_JOBS_PER_CRON_RUN` (default `20`)
- `ASYNC_CLEANUP_MAX_JOBS_PER_CRON_RUN` (default `120`)
- `ASYNC_CLEANUP_EXPIRED_GRACE_MS` (default `3600000`)
- `ASYNC_FINISHED_RETENTION_MS` (default `604800000`)
- `ASYNC_BULK_MAX_IDS` (default `80`)
- `ASYNC_LIST_MAX_LIMIT` (default `120`)
- `ASYNC_JOB_TTL_MS` (default `86400000`)
- `ASYNC_ARTIFACT_TTL_MS` (default `ASYNC_JOB_TTL_MS`)
- `ASYNC_MAX_ARTIFACT_BYTES` (default `8388608`)
- `ASYNC_ARTIFACT_STORAGE_MODE` (`auto`, `inline`, `chunked`; default `auto`)
- `ASYNC_MAX_INLINE_ARTIFACT_BYTES` (default `1048576`)
- `ASYNC_ARTIFACT_CHUNK_BYTES` (default `196608`)
- `ASYNC_MAX_ARTIFACT_CHUNKS` (default `128`)
- `ASYNC_PROBE_TIMEOUT_MS` (default `15000`)
- `ASYNC_PROBE_MAX_REDIRECTS` (default `2`)
- `ASYNC_PROBE_USER_AGENT` (optional)
- `ASYNC_OWNER_REGISTRY_KEY`, `ASYNC_OWNER_JOBS_KEY_PREFIX`, `ASYNC_JOB_KEY_PREFIX`, `ASYNC_ARTIFACT_CHUNK_KEY_PREFIX` (optional KV key namespace overrides)

## Observability

The API layer now emits structured JSON request logs and keeps in-memory coarse metrics buckets.

Environment variables:

- `OBSERVABILITY_ENABLED` (`true`/`false`, default `true`)
- `OBS_SUCCESS_LOG_SAMPLE_RATE` (default `0.02`)
- `OBS_RECENT_BUCKET_LIMIT` (default `90`)
- `OBS_BUCKET_RETENTION_MINUTES` (default `180`)
- `OBS_ALERT_WINDOW_MINUTES` (default `5`)
- `OBS_ALERT_MIN_REQUESTS` (default `25`)
- `OBS_ALERT_5XX_WARN_RATIO` / `OBS_ALERT_5XX_CRIT_RATIO` (defaults `0.05` / `0.15`)
- `OBS_ALERT_QUOTA_WARN_PER_MIN` / `OBS_ALERT_QUOTA_CRIT_PER_MIN` (defaults `4` / `10`)
- `METRICS_READ_TOKEN` (optional; if set, required for `/api/metrics`)

Metrics endpoint:

- `GET /api/metrics` returns per-process counters snapshot.
- Snapshot includes rolling minute buckets (`recentBuckets`) and computed `rollups`/`alerts`.
- Auth if configured:
  - `Authorization: Bearer <METRICS_READ_TOKEN>`
  - or header `x-metrics-token`
  - or query `?token=...`

## Benchmark trend persistence

Use `/api/benchmarks` to persist benchmark history outside CI artifacts.

Environment variables:

- `BENCHMARK_READ_TOKEN` (optional; required for GET when set)
- `BENCHMARK_WRITE_TOKEN` (optional; required for POST when set; defaults to read token)
- `BENCHMARK_HISTORY_MAX` (default `240`)
- `BENCHMARK_HISTORY_KEY_PREFIX` (default `dz:bench:history:v1:`)

API:

- `GET /api/benchmarks?suite=jobs-state&limit=30`
- `POST /api/benchmarks` with JSON body:
  - `suite` (string)
  - `report` (object)
  - `metadata` (object)

Storage backend:

- Uses `KV_REST_API_URL` + `KV_REST_API_TOKEN` when configured.
- Falls back to in-memory storage when KV is unavailable.

## Vercel rate-limit configuration

The `/api/proxy` route supports configurable per-IP limits via environment variables:

- `RATE_LIMIT_MAX_REQUESTS` (default: `180`)
- `RATE_LIMIT_WINDOW_MS` (default: `60000`)

## API auth and persistent quotas

The Vercel proxy also supports API-key auth and quota tracking.

Environment variables:

- `API_AUTH_REQUIRED` (`true`/`false`): require a valid API key for all requests.
- `API_DISABLE_ANON` (`true`/`false`): disable anonymous traffic unless API key is provided.
- `API_KEY_CONFIG_JSON`: JSON object mapping API keys to plans.
- `API_DEFAULT_DAILY_QUOTA` / `API_DEFAULT_MINUTE_QUOTA`: default plan limits for configured keys.
- `API_ANON_DAILY_QUOTA` / `API_ANON_MINUTE_QUOTA`: limits for anonymous users.

Example `API_KEY_CONFIG_JSON`:

```json
{
  "dz_live_key_1": { "label": "denis-main", "dailyQuota": 12000, "minuteQuota": 240 },
  "dz_partner_key": { "label": "partner-a", "dailyQuota": 6000, "minuteQuota": 120 }
}
```

Persistent backend (recommended on Vercel):

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

If KV is not configured, quotas fall back to in-memory counters (not durable across cold starts).

## GPL
> Copyright © 2011-2017 Lovasoa
>
>  This file is part of Dezoomify.
>
>  Dezoomify is free software; you can redistribute it and/or modify
>  it under the terms of the GNU General Public License as published by
>  the Free Software Foundation; either version 2 of the License, or
>  (at your option) any later version.
>
>  Dezoomify is distributed in the hope that it will be useful,
>  but WITHOUT ANY WARRANTY; without even the implied warranty of
>  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
>  GNU General Public License for more details.
>
>  You should have received a copy of the GNU General Public License
>  along with Dezoomify; if not, write to the Free Software
>  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301
>  USA*/
