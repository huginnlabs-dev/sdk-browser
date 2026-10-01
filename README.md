# @huginnlabs/dataflow-browser

HuginnLabs Dataflow Browser SDK — real-user monitoring (RUM) for web apps: page
views, outgoing HTTP spans with cross-stack trace propagation, JS error capture,
Web Vitals and click breadcrumbs. Zero runtime dependencies, dual ESM/CJS
(+ IIFE for script tags), TypeScript-first.

**Version 0.1.0** — see [Versioning](#versioning).

## Install

```bash
npm install @huginnlabs/dataflow-browser
```

## Quick start

### Bundler (ESM / CJS)

```ts
import dataflow from '@huginnlabs/dataflow-browser';

dataflow.init({
  endpoint: 'https://dataflow.example.com', // base URL — SDK posts to <endpoint>/api/v1/ingest
  apiKey: 'df_your_project_key',
  serviceName: 'web-app',   // becomes service_name on every event
  sampleRate: 1,            // 0..1, rolled once per page load
  traceHeader: true,        // join browser + backend into ONE trace
});
```

The SDK initializes nothing at import time — everything starts at explicit
`init()` (browsers have no environment variables). `init()` is idempotent:
subsequent calls merge options into the running config (endpoint, sampleRate,
disable flags and friends are re-read live; a new trace id is never rolled).

### Script tag (IIFE)

```html
<script src="https://unpkg.com/@huginnlabs/dataflow-browser/dist/index.iife.js"></script>
<script>
  dataflow.init({ endpoint: 'https://dataflow.example.com', apiKey: 'df_...', serviceName: 'web-app' });
</script>
```

## What's captured

| Signal | Span type | Name | Notes |
|---|---|---|---|
| First page load | `PAGE_VIEW` | `VIEW <pathname>` | Opens at `init()`, ends on the window `load` event; duration = load time. Web Vitals land in its metadata. |
| SPA route change | `PAGE_VIEW` | `VIEW <pathname>` | `history.pushState` / `replaceState` (patched), `popstate` and `hashchange`. Duration = time on the previous route. Same-URL changes are deduped. |
| Outgoing fetch | `HTTP_CLIENT` | `METHOD host/path` | `window.fetch` wrapped. `status_code`, duration, `http.method` / `http.url` metadata. Network failures record `status_code: 0` + `error_message` (the rejection is still passed through to the app). |
| Outgoing XHR | `HTTP_CLIENT` | `METHOD host/path` | `XMLHttpRequest.open` / `send` wrapped; span emitted on completion. |
| JS errors | `FUNCTION_CALL` | `browser.error` | `window.onerror` (via the `error` event) + `unhandledrejection`. `status_code: 500`, `error.message` (<= 500 chars), `error.stack` (<= 8192 chars), `error.source` (`file:line:col`), plus click breadcrumbs. |
| Web Vitals | metadata on the page-load span | `webvital.lcp`, `webvital.fid`, `webvital.cls`, `webvital.ttfb` | Hand-rolled via `PerformanceObserver` — no `web-vitals` dependency. FID is the raw first-input delay; INP-style attribution is a roadmap item (when a page sees no interaction before flush, no FID is reported). |
| Click breadcrumbs | metadata on error spans | `breadcrumbs` | Capture-phase click listener; last N (default 20) entries as a JSON array of `{ label: "tag#id:text", timestamp }`. Attached **only** to error spans — never sent on their own. |

Browser spans never carry payloads (the encrypted `payload` block is a
server-side / backend-SDK feature).

## Trace propagation (browser + backend = one trace)

When `traceHeader` is on (default), the SDK injects
`x-dataflow-trace-id: <current trace id>` on outgoing requests so backend
services join the same trace the browser started. Injection policy — this is
deliberately strict to avoid breaking CORS:

- **Same-origin** requests always get the header.
- **Cross-origin** requests get the header **only** if the origin is listed in
  `allowedTraceOrigins` (custom headers on third-party origins trigger CORS
  failures).
- The SDK's **own ingest beacons are never traced** and never receive the
  header (no self-tracing loops).
- With `traceHeader: false` nothing is injected anywhere.

Trace model: one trace id per page load. The page-load `PAGE_VIEW` span is the
root; route-change views chain onto it; HTTP and error spans parent to the
current view span.

The header is independent of sampling: an unsampled page load still propagates
its trace id, so a backend span can exist even when the browser drops its own.

## Batching and page-hide

- Events queue in memory and flush every `flushInterval` ms (default 2000) or
  when `maxBatchSize` (default 20) events are queued.
- On `visibilitychange → hidden` / `pagehide` the remaining batch is sent with
  `fetch(..., { keepalive: true })` **with full `X-Api-Key` headers**.
  `navigator.sendBeacon` is deliberately NOT used because it cannot set the
  `X-Api-Key` header. On browsers without fetch keepalive support the final
  batch is silently dropped.
- The transport never throws into the host app and never blocks the UI thread:
  every network failure is swallowed (the batch is dropped).

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | — (required) | Base URL of the Dataflow server; the SDK posts to `<endpoint>/api/v1/ingest`. |
| `apiKey` | `string` | — (required) | Project API key, sent as the `X-Api-Key` header. |
| `serviceName` | `string` | `location.host` | Logical app name; `service_name` on every event. |
| `sampleRate` | `number` | `1` | Fraction of page loads traced, `0..1` (values are clamped). Rolled **once per page load** — the whole session is consistently sampled or not. |
| `traceHeader` | `boolean` | `true` | Inject `x-dataflow-trace-id` per the policy above. |
| `allowedTraceOrigins` | `string[]` | `[]` | Extra cross-origin origins that may receive the trace header. |
| `disablePageViews` | `boolean` | `false` | Disable route-change / page-load spans. |
| `disableHttp` | `boolean` | `false` | Disable fetch/XHR spans (headers still follow `traceHeader`). |
| `disableErrors` | `boolean` | `false` | Disable JS error capture. |
| `disableWebVitals` | `boolean` | `false` | Disable Web Vitals collection. |
| `disableBreadcrumbs` | `boolean` | `false` | Disable click breadcrumbs. |
| `maxBreadcrumbs` | `number` | `20` | Breadcrumb trail length. |
| `flushInterval` | `number` | `2000` | Batch flush interval (ms). |
| `maxBatchSize` | `number` | `20` | Queue size that triggers an immediate flush. |
| `debug` | `boolean` | `false` | Log emitted spans to the console. |

All `disable*` flags are evaluated at event time, so a later `init()` merge can
toggle instrumentation on a running page.

## Privacy notes

- **Click breadcrumbs** contain DOM-derived labels (`tag#id:text`) — element
  ids and visible button/link text can leak product or account specifics.
  They are attached only to error spans and capped at `maxBreadcrumbs`; disable
  with `disableBreadcrumbs: true`.
- **Stack traces and error URLs** (`error.stack`, `error.source`, `http.url`)
  may contain app routes, file names and query strings. Treat them as
  potentially sensitive; `disableErrors: true` / `disableHttp: true` turn them
  off.
- The SDK sends data only to the configured `endpoint` with the project's API
  key. Sampling (`sampleRate`) is the coarsest lever: at `0.5`, half of all
  page loads send nothing at all.

## CORS

Browsers enforce CORS on the ingest POST. The Dataflow server allows browser
origins for `/api/v1/ingest` (`Access-Control-Allow-Origin: *`), so no proxy is
needed. The trace header is only injected where it cannot break CORS — see the
[trace propagation policy](#trace-propagation-browser--backend--one-trace).

## Browser support

Modern evergreen browsers with ES2020 + `PerformanceObserver` + fetch:
Chrome/Edge 85+, Firefox 79+, Safari 14+. Without fetch keepalive, the
page-hide flush is dropped (earlier batches still arrive). Node 18+ is needed
only to build/test the package.

## Versioning

SemVer: MAJOR for breaking API/wire changes, MINOR for backward-compatible
features, PATCH for fixes. This release: **0.1.0**.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest + happy-dom
npm run build       # tsup -> dist (esm, cjs, iife, dts)
```
