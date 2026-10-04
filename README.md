# @huginnlabs/dataflow-browser

HuginnLabs Dataflow Browser SDK — real-user monitoring (RUM) for web apps: page
views, outgoing HTTP spans with cross-stack trace propagation, JS error capture,
Web Vitals, click breadcrumbs and opt-in Session Replay. Zero runtime
dependencies in the core bundle, dual ESM/CJS (+ IIFE for script tags),
TypeScript-first.

**Version 0.2.0** — see [Versioning](#versioning).

## Install

```bash
npm install @huginnlabs/dataflow-browser
```

**Zero runtime dependencies.** Session Replay is opt-in and needs
[rrweb](https://www.npmjs.com/package/rrweb) — an *optional peer*: install
it yourself if you want replay (`npm i rrweb`), otherwise the SDK silently
degrades to traces-only and your dependency tree stays clean.

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
| Session Replay (opt-in) | rrweb events → `/api/v1/replay` | — | Separate stream keyed by the page-load trace id. Off by default; sampled independently; privacy-masked. See [Session Replay](#session-replay). |

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

## Session Replay

Session Replay records the DOM with [rrweb](https://github.com/rrweb-io/rrweb) so
a player can reconstruct what a sampled user actually saw — including SPA route
changes (rrweb's full snapshot + DOM mutations cover navigation; no extra
instrumentation). It is **opt-in and off by default**:

```ts
dataflow.init({
  endpoint: 'https://dataflow.example.com',
  apiKey: 'df_your_project_key',
  replay: true,          // opt-in — default false
  replaySampleRate: 0.2, // record 20% of page loads (independent of sampleRate)
});
```

How it works:

- **Dynamic load.** rrweb is imported dynamically, so your core bundle never
  pays for it. If the dynamic import fails (not bundled / blocked by an
  extension), replay degrades silently: it stays off for the page and emits a
  single console warning. The script-tag (IIFE) build cannot resolve a bare
  `rrweb` specifier — provide an import map if you need replay there.
- **Sampling.** `replaySampleRate` (default 1) is rolled once per page load,
  independently of `sampleRate` — a page load can be traced but not recorded,
  and vice versa. One recording stream per page load, keyed by the root trace
  id (`traceId()`), so a replay lines up with the trace timeline in the UI.
- **Batching.** Events buffer in memory (hard cap 3000, oldest dropped) and
  flush to `POST <endpoint>/api/v1/replay` every 3s, at 200 buffered events,
  or on page hide (fetch keepalive, ≤500 events per POST per the server
  contract). Flush failures retry once, then the batch is dropped.

**Privacy defaults (fixed, not configurable):**

| rrweb option | Default | Effect |
|---|---|---|
| `maskAllInputs` | `true` | Every `<input>`/`<textarea>`/`<select>` value is replaced with `*` in the recording. |
| `maskTextClass` | `df-mask` | Text inside elements with class `df-mask` is replaced with `***`. |
| `blockClass` | `df-block` | Elements with class `df-block` are **not recorded at all** (played back as an empty placeholder). |
| `inlineImages` | `false` | Image bytes are never embedded in the payload. |

**Operators: add `df-block` to sensitive widgets** — payment forms, iframes
(support chat, 3-D Secure), personal-data panels. Unlike masking, blocked
subtrees never leave the browser. Use `df-mask` where layout matters but the
text itself is sensitive (e.g. rendered account numbers).

**Retention / storage.** Replay payloads are stored server-side under the
trace id and expire according to the Dataflow server's retention (TTL)
configuration — rrweb recordings are personal data under GDPR, so set a
retention window you can defend and keep it shorter than for ordinary traces.

**Lossy by design.** Recording deliberately never blocks the app and never
retries more than once: a full buffer (3000), a failed flush, or a keepalive
payload over the browser's 64 KiB page-hide cap all drop events rather than
queue them. Replays are representative, not archival.

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
| `replay` | `boolean` | `false` | Opt-in Session Replay via rrweb (dynamically imported — see [Session Replay](#session-replay)). |
| `replaySampleRate` | `number` | `1` | Fraction of page loads recorded when `replay` is on, `0..1`. Rolled once per page load, independent of `sampleRate`. |
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
- **Session Replay** (when explicitly enabled) records the DOM — masked per
  the [fixed privacy defaults](#session-replay), but still potentially
  sensitive (URLs, dynamically rendered text outside `df-mask`). It has its
  own sampling knob (`replaySampleRate`) and server-side retention; see the
  Session Replay section before turning it on.

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
features, PATCH for fixes. This release: **0.2.0** (added opt-in Session
Replay via rrweb).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest + happy-dom
npm run build       # tsup -> dist (esm, cjs, iife, dts)
```
