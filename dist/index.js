// src/ids.ts
function randomBytes(n) {
  const g = globalThis.crypto;
  const out = new Uint8Array(n);
  if (g && typeof g.getRandomValues === "function") {
    g.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}
function hex(bytes) {
  let s = "";
  const arr = randomBytes(bytes);
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s;
}
function newTraceId() {
  return hex(16);
}
function newSpanId() {
  return hex(8);
}
function newEventId() {
  return hex(16);
}

// src/sampling.ts
function clampRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}
function rollSampling(rate) {
  return Math.random() < clampRate(rate);
}

// src/config.ts
var state = {
  config: null,
  started: false,
  traceId: "",
  sampled: true,
  replaySampled: false,
  seq: 0,
  lastRouteChangeTs: 0
};
function defaultServiceName() {
  try {
    if (typeof location !== "undefined" && location.host) return location.host;
  } catch {
  }
  return "browser";
}
function resolveConfig(opts) {
  return {
    endpoint: String(opts.endpoint ?? "").trim(),
    apiKey: String(opts.apiKey ?? ""),
    serviceName: opts.serviceName && opts.serviceName.trim() ? opts.serviceName.trim() : defaultServiceName(),
    sampleRate: clampNumber(opts.sampleRate ?? 1, 0, 1, 1),
    traceHeader: opts.traceHeader !== false,
    allowedTraceOrigins: Array.isArray(opts.allowedTraceOrigins) ? opts.allowedTraceOrigins.slice() : [],
    disablePageViews: opts.disablePageViews === true,
    disableHttp: opts.disableHttp === true,
    disableErrors: opts.disableErrors === true,
    disableWebVitals: opts.disableWebVitals === true,
    disableBreadcrumbs: opts.disableBreadcrumbs === true,
    maxBreadcrumbs: Math.max(0, Math.floor(clampNumber(opts.maxBreadcrumbs ?? 20, 0, 1e3, 20))),
    flushInterval: Math.max(10, Math.floor(clampNumber(opts.flushInterval ?? 2e3, 10, 36e5, 2e3))),
    maxBatchSize: Math.max(1, Math.floor(clampNumber(opts.maxBatchSize ?? 20, 1, 1e3, 20))),
    replay: opts.replay === true,
    replaySampleRate: clampNumber(opts.replaySampleRate ?? 1, 0, 1, 1),
    debug: opts.debug === true
  };
}
function clampNumber(v, min, max, fallback) {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
function bootstrapState(config) {
  state.config = config;
  state.started = true;
  state.traceId = newTraceId();
  state.sampled = rollSampling(config.sampleRate);
  state.replaySampled = rollSampling(config.replaySampleRate);
  state.seq = 0;
  state.currentViewSpanId = void 0;
  state.currentUrl = void 0;
  state.lastRouteChangeTs = 0;
}
function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== void 0) out[k] = obj[k];
  }
  return out;
}

// src/patch.ts
var teardowns = [];
function addTeardown(fn) {
  teardowns.push(fn);
}
function runTeardowns() {
  for (const fn of teardowns) {
    try {
      fn();
    } catch {
    }
  }
  teardowns.length = 0;
}

// src/version.ts
var VERSION = "0.2.1";
var TRACE_HEADER = "x-dataflow-trace-id";
var INGEST_PATH = "/api/v1/ingest";
var REPLAY_PATH = "/api/v1/replay";
var META = {
  httpMethod: "http.method",
  httpUrl: "http.url",
  errorMessage: "error.message",
  errorStack: "error.stack",
  errorSource: "error.source",
  breadcrumbs: "breadcrumbs",
  vitalLcp: "webvital.lcp",
  vitalFid: "webvital.fid",
  vitalCls: "webvital.cls",
  vitalTtfb: "webvital.ttfb"
};

// src/util.ts
function nowMs() {
  return Date.now();
}
function truncate(s, max) {
  if (s === void 0 || s === null) return void 0;
  return s.length <= max ? s : s.slice(0, max);
}
function toURL(url, base) {
  try {
    const b = base ?? (typeof location !== "undefined" ? location.href : void 0);
    return new URL(url, b);
  } catch {
    return void 0;
  }
}
function safeLocationHost() {
  try {
    if (typeof location !== "undefined" && location.host) return location.host;
  } catch {
  }
  return "browser";
}

// src/ingest.ts
function endpointUrl(path) {
  const base = (state.config?.endpoint ?? "").replace(/\/+$/, "");
  if (base.endsWith(path)) return base;
  return base + path;
}
function ingestUrl() {
  return endpointUrl(INGEST_PATH);
}
function replayUrl() {
  return endpointUrl(REPLAY_PATH);
}
function sameEndpoint(u, path) {
  const mine = toURL(endpointUrl(path));
  if (!mine) return false;
  return u.origin === mine.origin && u.pathname === mine.pathname;
}
function isIngestUrl(u) {
  return sameEndpoint(u, INGEST_PATH);
}
function isReplayUrl(u) {
  return sameEndpoint(u, REPLAY_PATH);
}
function isOwnEndpoint(u) {
  return isIngestUrl(u) || isReplayUrl(u);
}

// src/transport.ts
var MAX_QUEUE = 1e3;
var queue = [];
var timer = null;
function enqueueEvent(ev) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(ev);
  const cfg = state.config;
  if (cfg && queue.length >= cfg.maxBatchSize) void flush();
}
function queueSnapshot() {
  return queue.slice();
}
function takeAll() {
  if (queue.length === 0) return [];
  const all = queue;
  queue = [];
  return all;
}
function flush() {
  const events = takeAll();
  if (events.length === 0) return Promise.resolve();
  return post(events, false);
}
function flushKeepalive() {
  const events = takeAll();
  if (events.length === 0) return;
  void post(events, true);
}
async function post(events, keepalive) {
  const cfg = state.config;
  if (!cfg || !cfg.endpoint || typeof fetch !== "function") return;
  try {
    await fetch(ingestUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey
      },
      body: JSON.stringify({ events }),
      keepalive,
      credentials: "omit"
    });
  } catch {
  }
}
function startTransport() {
  stopTransport();
  const cfg = state.config;
  if (!cfg) return;
  timer = setInterval(() => {
    void flush();
  }, cfg.flushInterval);
  const onVisibility = () => {
    try {
      if (document.visibilityState === "hidden") flushKeepalive();
    } catch {
    }
  };
  const onPageHide = () => {
    try {
      flushKeepalive();
    } catch {
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  addTeardown(() => {
    stopTransport();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
  });
}
function stopTransport() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
function resetTransport() {
  stopTransport();
  queue = [];
}

// src/events.ts
function normalizeMetadata(meta) {
  const out = {};
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (v === void 0 || v === null) continue;
    if (typeof v === "string") {
      out[k] = v;
      continue;
    }
    try {
      const s = JSON.stringify(v);
      out[k] = s === void 0 ? String(v) : s;
    } catch {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function emitEvent(input) {
  const st = state;
  if (!st.started || !st.config) return;
  if (!st.sampled) return;
  const spanId = input.span_id ?? newSpanId();
  const parent = input.parent_span_id === null ? void 0 : input.parent_span_id ?? st.currentViewSpanId;
  const ev = {
    event_id: newEventId(),
    seq: ++st.seq,
    timestamp: Date.now(),
    trace_id: st.traceId,
    span_id: spanId,
    type: input.type,
    service_name: st.config.serviceName,
    name: input.name,
    caller_package: input.caller_package,
    callee_package: input.callee_package,
    function_name: input.function_name,
    duration_ms: input.duration_ms,
    status_code: input.status_code,
    error_message: input.error_message,
    metadata: input.metadata ? normalizeMetadata(input.metadata) : void 0
  };
  if (parent !== void 0) ev.parent_span_id = parent;
  if (input.setAsCurrentView) st.currentViewSpanId = spanId;
  enqueueEvent(ev);
  if (st.config.debug) {
    try {
      console.debug("[dataflow]", ev.type, ev.name, ev.duration_ms);
    } catch {
    }
  }
}

// src/instrument/breadcrumbs.ts
var crumbs = [];
function instrumentBreadcrumbs() {
  const opts = { capture: true, passive: true };
  const handler = (e) => {
    try {
      recordClick(e);
    } catch {
    }
  };
  document.addEventListener("click", handler, opts);
  addTeardown(() => {
    document.removeEventListener("click", handler, { capture: true });
    crumbs = [];
  });
}
function recordClick(e) {
  const cfg = state.config;
  if (!cfg || cfg.disableBreadcrumbs) return;
  const t = e.target;
  if (!t || typeof t.tagName !== "string") return;
  const tag = t.tagName.toLowerCase();
  const id = t.id ? `#${t.id}` : "";
  let text = "";
  try {
    text = (t.textContent ?? "").trim().slice(0, 64);
  } catch {
  }
  crumbs.push({ label: `${tag}${id}:${text}`, timestamp: Date.now() });
  const max = cfg.maxBreadcrumbs;
  if (crumbs.length > max) crumbs = crumbs.slice(crumbs.length - max);
}
function getBreadcrumbs() {
  return crumbs.slice();
}

// src/instrument/errors.ts
var MAX_MESSAGE = 500;
var MAX_STACK = 8192;
function instrumentErrors() {
  const onError = (e) => {
    try {
      if (!(e instanceof ErrorEvent)) return;
      const stack = e.error instanceof Error ? e.error.stack : void 0;
      const msg = e.message || (e.error instanceof Error ? e.error.message : "Unknown error");
      handleError(msg, stack, "window.onerror", `${e.filename}:${e.lineno}:${e.colno}`);
    } catch {
    }
  };
  const onRejection = (e) => {
    try {
      const reason = e.reason;
      const stack = reason instanceof Error ? reason.stack : void 0;
      const msg = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason ?? "Unhandled rejection");
      handleError(msg, stack, "unhandledrejection", "promise");
    } catch {
    }
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  addTeardown(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });
}
function handleError(msg, stack, fn, source) {
  const cfg = state.config;
  if (!cfg || cfg.disableErrors || !state.started) return;
  const metadata = {
    [META.errorMessage]: truncate(msg, MAX_MESSAGE) ?? ""
  };
  const st = truncate(stack, MAX_STACK);
  if (st) metadata[META.errorStack] = st;
  metadata[META.errorSource] = source;
  if (!cfg.disableBreadcrumbs && cfg.maxBreadcrumbs > 0) {
    metadata[META.breadcrumbs] = getBreadcrumbs();
  }
  emitEvent({
    type: "FUNCTION_CALL",
    name: "browser.error",
    function_name: fn,
    caller_package: "browser",
    callee_package: "browser",
    status_code: 500,
    error_message: truncate(msg, MAX_MESSAGE),
    metadata
  });
}

// src/instrument/history.ts
function currentUrlString() {
  return location.pathname + location.search + location.hash;
}
function instrumentHistory() {
  const w = window;
  const h = w.history;
  const anyHistory = h;
  if (h && !anyHistory.__dataflowPatched) {
    const origPush = h.pushState;
    const origReplace = h.replaceState;
    h.pushState = function(...args) {
      const result = origPush.apply(this, args);
      onRouteChange();
      return result;
    };
    h.replaceState = function(...args) {
      const result = origReplace.apply(this, args);
      onRouteChange();
      return result;
    };
    anyHistory.__dataflowPatched = true;
    addTeardown(() => {
      h.pushState = origPush;
      h.replaceState = origReplace;
      delete anyHistory.__dataflowPatched;
    });
  }
  const onPop = () => {
    try {
      onRouteChange();
    } catch {
    }
  };
  const onHash = () => {
    try {
      onRouteChange();
    } catch {
    }
  };
  w.addEventListener("popstate", onPop);
  w.addEventListener("hashchange", onHash);
  addTeardown(() => {
    w.removeEventListener("popstate", onPop);
    w.removeEventListener("hashchange", onHash);
  });
}
function onRouteChange() {
  const cfg = state.config;
  if (!cfg || cfg.disablePageViews || !state.started) return;
  const url = currentUrlString();
  if (url === state.currentUrl) return;
  const now = nowMs();
  const duration = Math.max(0, now - state.lastRouteChangeTs);
  state.currentUrl = url;
  state.lastRouteChangeTs = now;
  emitEvent({
    type: "PAGE_VIEW",
    name: `VIEW ${location.pathname}`,
    duration_ms: duration,
    caller_package: "browser",
    callee_package: "browser",
    setAsCurrentView: true
  });
}

// src/instrument/http.ts
function traceEligible(u) {
  const cfg = state.config;
  if (!cfg || !cfg.traceHeader) return false;
  if (isOwnEndpoint(u)) return false;
  if (u.origin === location.origin) return true;
  return cfg.allowedTraceOrigins.includes(u.origin);
}
function instrumentHttp() {
  if (typeof fetch === "function" && !fetch.__dataflowWrapped) {
    installFetch();
  }
  if (typeof XMLHttpRequest !== "undefined") {
    installXhr();
  }
}
function installFetch() {
  const original = fetch;
  const wrapped = function(input, init2) {
    const cfg = state.config;
    if (!cfg || cfg.disableHttp || !state.started) {
      return original.call(this === void 0 ? globalThis : this, input, init2);
    }
    const u = toURL(input instanceof Request ? input.url : String(input));
    if (!u || isOwnEndpoint(u)) {
      return original.call(this === void 0 ? globalThis : this, input, init2);
    }
    const method = (init2?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    let newInit = init2;
    if (traceEligible(u)) {
      try {
        const headers = new Headers(
          init2?.headers ?? (input instanceof Request ? input.headers : void 0)
        );
        headers.set(TRACE_HEADER, state.traceId);
        newInit = { ...init2 ?? {}, headers };
      } catch {
        newInit = init2;
      }
    }
    const started = nowMs();
    return original.call(this === void 0 ? globalThis : this, input, newInit).then(
      (res) => {
        emitHttpSpan(method, u, res.status, nowMs() - started, void 0);
        return res;
      },
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        emitHttpSpan(method, u, 0, nowMs() - started, msg);
        throw err;
      }
    );
  };
  wrapped.__dataflowWrapped = true;
  globalThis.fetch = wrapped;
  addTeardown(() => {
    globalThis.fetch = original;
  });
}
function emitHttpSpan(method, u, status, duration, errorMessage) {
  const cfg = state.config;
  if (!cfg || cfg.disableHttp || !state.started) return;
  if (isOwnEndpoint(u)) return;
  emitEvent({
    type: "HTTP_CLIENT",
    name: `${method} ${u.host}${u.pathname}`,
    caller_package: safeLocationHost(),
    callee_package: u.host,
    duration_ms: Math.max(0, Math.round(duration)),
    status_code: status,
    error_message: errorMessage,
    metadata: {
      [META.httpMethod]: method,
      [META.httpUrl]: u.href
    }
  });
}
function installXhr() {
  const proto = XMLHttpRequest.prototype;
  if (proto.__dataflowWrapped) return;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function(...args) {
    const [method, url] = args;
    try {
      this.__dataflowReq = { method: String(method).toUpperCase(), url: String(url) };
    } catch {
    }
    return origOpen.apply(this, args);
  };
  proto.send = function(body) {
    const info = this.__dataflowReq;
    if (info) {
      const u = toURL(info.url);
      if (u && traceEligible(u) && !info.headerSet) {
        try {
          this.setRequestHeader(TRACE_HEADER, state.traceId);
          info.headerSet = true;
        } catch {
        }
      }
      const started = nowMs();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const status = typeof this.status === "number" ? this.status : 0;
        emitHttpSpan(
          info.method,
          u,
          status,
          nowMs() - started,
          status === 0 ? "XHR network error or aborted" : void 0
        );
      };
      this.addEventListener("load", finish);
      this.addEventListener("error", finish);
      this.addEventListener("abort", finish);
    }
    return origSend.call(this, body);
  };
  proto.__dataflowWrapped = true;
  addTeardown(() => {
    proto.open = origOpen;
    proto.send = origSend;
    delete proto.__dataflowWrapped;
  });
}

// src/instrument/vitals.ts
function startVitals(target) {
  const cfg = state.config;
  if (!cfg) return;
  try {
    if (!cfg.disableWebVitals) {
      const list = performance.getEntriesByType?.("navigation");
      const nav = list?.[0];
      if (nav && typeof nav.responseStart === "number" && nav.responseStart > 0 && typeof nav.requestStart === "number") {
        target[META.vitalTtfb] = Math.max(0, Math.round(nav.responseStart - nav.requestStart));
      }
    }
  } catch {
  }
  const PO = globalThis.PerformanceObserver;
  if (typeof PO !== "function") return;
  const observe = (type, cb) => {
    try {
      const po = new PO((list) => {
        try {
          cb(list.getEntries());
        } catch {
        }
      });
      po.observe({ type, buffered: true });
      addTeardown(() => {
        try {
          po.disconnect();
        } catch {
        }
      });
    } catch {
    }
  };
  observe("largest-contentful-paint", (entries) => {
    if (state.config?.disableWebVitals) return;
    const last = entries[entries.length - 1];
    if (last && typeof last.startTime === "number") {
      target[META.vitalLcp] = Math.round(last.startTime);
    }
  });
  let cls = 0;
  observe("layout-shift", (entries) => {
    if (state.config?.disableWebVitals) return;
    for (const e of entries) {
      if (!e.recentInput) cls += e.value ?? 0;
    }
    target[META.vitalCls] = Math.round(cls * 1e3) / 1e3;
  });
  observe("first-input", (entries) => {
    if (state.config?.disableWebVitals) return;
    const f = entries[0];
    if (f && typeof f.processingStart === "number" && typeof f.startTime === "number") {
      target[META.vitalFid] = Math.max(0, Math.round(f.processingStart - f.startTime));
    }
  });
}

// src/replay.ts
var REPLAY_BUFFER_CAP = 3e3;
var REPLAY_FLUSH_BATCH = 200;
var REPLAY_FLUSH_INTERVAL_MS = 3e3;
var REPLAY_MAX_BATCH = 500;
var KEEPALIVE_MAX_BYTES = 65536;
var REPLAY_PRIVACY = {
  maskAllInputs: true,
  maskTextClass: "df-mask",
  blockClass: "df-block",
  inlineImages: false
};
var buffer = [];
var droppedEvents = 0;
var timer2 = null;
var stopRecording = null;
var starting = false;
var degraded = false;
function maybeStartReplay() {
  const cfg = state.config;
  if (!cfg || !state.started) return;
  if (!cfg.replay || !state.replaySampled) return;
  if (stopRecording || starting || degraded) return;
  starting = true;
  void startRecording();
}
async function startRecording() {
  try {
    let record;
    try {
      const mod = await import("rrweb");
      if (typeof mod?.record !== "function") throw new TypeError("rrweb.record is not a function");
      record = mod.record;
    } catch (err) {
      degraded = true;
      warnOnce(err);
      return;
    }
    const cfg = state.config;
    if (!cfg || !cfg.replay || !state.replaySampled || stopRecording) return;
    let stop;
    try {
      stop = record({ ...REPLAY_PRIVACY, emit: onRrwebEvent });
    } catch (err) {
      degraded = true;
      warnOnce(err);
      return;
    }
    if (typeof stop !== "function") {
      degraded = true;
      warnOnce(new Error("rrweb.record did not return a stop function"));
      return;
    }
    stopRecording = stop;
    timer2 = setInterval(() => {
      void flushReplay();
    }, REPLAY_FLUSH_INTERVAL_MS);
    const onVisibility = () => {
      try {
        if (document.visibilityState === "hidden") flushReplayOnHide();
      } catch {
      }
    };
    const onPageHide = () => {
      try {
        flushReplayOnHide();
      } catch {
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    addTeardown(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      stopReplay();
    });
  } finally {
    starting = false;
  }
}
function warnOnce(err) {
  try {
    console.warn(
      "[dataflow] replay: rrweb could not be loaded \u2014 Session Replay stays off for this page.",
      err instanceof Error ? err.message : err
    );
  } catch {
  }
}
function bufferEvent(ev) {
  if (buffer.length >= REPLAY_BUFFER_CAP) {
    buffer.shift();
    droppedEvents++;
  }
  buffer.push({ type: ev.type, data: ev.data, timestamp: ev.timestamp });
}
function onRrwebEvent(ev) {
  bufferEvent(ev);
  if (buffer.length >= REPLAY_FLUSH_BATCH) void flushReplay();
}
function takeBuffer() {
  if (buffer.length === 0) return [];
  const all = buffer;
  buffer = [];
  return all;
}
function replayBody(events) {
  return JSON.stringify({ trace_id: state.traceId, events });
}
function flushReplay() {
  const events = takeBuffer();
  if (events.length === 0) return Promise.resolve();
  return (async () => {
    for (let i = 0; i < events.length; i += REPLAY_MAX_BATCH) {
      const chunk = events.slice(i, i + REPLAY_MAX_BATCH);
      const body = replayBody(chunk);
      if (await postReplay(body, false)) continue;
      await postReplay(body, false);
    }
  })();
}
function flushReplayOnHide() {
  const cfg = state.config;
  if (!cfg || !cfg.endpoint || typeof fetch !== "function") return;
  let events = takeBuffer();
  if (events.length === 0) return;
  if (events.length > REPLAY_MAX_BATCH) {
    droppedEvents += events.length - REPLAY_MAX_BATCH;
    events = events.slice(events.length - REPLAY_MAX_BATCH);
  }
  let body = replayBody(events);
  while (events.length > 0 && byteLength(body) > KEEPALIVE_MAX_BYTES) {
    const cut = Math.max(1, Math.floor(events.length / 4));
    droppedEvents += cut;
    events = events.slice(cut);
    body = replayBody(events);
  }
  if (events.length > 0) void postReplay(body, true);
}
async function postReplay(body, keepalive) {
  const cfg = state.config;
  if (!cfg || !cfg.endpoint || typeof fetch !== "function") return false;
  try {
    const res = await fetch(replayUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey
      },
      body,
      keepalive,
      credentials: "omit"
    });
    return res.ok;
  } catch {
    return false;
  }
}
function byteLength(s) {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}
function stopReplay() {
  if (timer2 !== null) {
    clearInterval(timer2);
    timer2 = null;
  }
  try {
    stopRecording?.();
  } catch {
  }
  stopRecording = null;
}
function resetReplay() {
  stopReplay();
  buffer = [];
  droppedEvents = 0;
  starting = false;
  degraded = false;
}

// src/index.ts
function start() {
  const cfg = state.config;
  if (!cfg) return;
  instrumentBreadcrumbs();
  instrumentHttp();
  instrumentErrors();
  instrumentHistory();
  const vitalsMeta = {};
  try {
    vitalsMeta["agent.ua"] = navigator.userAgent;
    vitalsMeta["agent.lang"] = navigator.language || "";
    vitalsMeta["agent.viewport"] = `${window.innerWidth}x${window.innerHeight}`;
  } catch {
  }
  startVitals(vitalsMeta);
  const pageLoadStart = nowMs();
  const loadSpanId = newSpanId();
  state.currentViewSpanId = loadSpanId;
  state.currentUrl = currentUrlString();
  state.lastRouteChangeTs = pageLoadStart;
  let finalized = false;
  const finalizePageLoad = () => {
    if (finalized) return;
    finalized = true;
    const duration = Math.max(0, nowMs() - pageLoadStart);
    state.lastRouteChangeTs = nowMs();
    if (!cfg.disablePageViews && state.sampled) {
      const initPathname = (state.currentUrl || currentUrlString()).split("#")[0].split("?")[0];
      emitEvent({
        type: "PAGE_VIEW",
        name: `VIEW ${initPathname}`,
        span_id: loadSpanId,
        parent_span_id: null,
        // root span of the page-load trace
        duration_ms: duration,
        caller_package: "browser",
        callee_package: "browser",
        metadata: vitalsMeta
      });
    }
  };
  if (document.readyState === "complete") {
    finalizePageLoad();
  } else {
    const onLoad = () => finalizePageLoad();
    window.addEventListener("load", onLoad, { once: true });
  }
  startTransport();
  maybeStartReplay();
}
function init(options) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("[dataflow] @huginnlabs/dataflow-browser must run in a browser environment");
  }
  if (!state.started) {
    const missing = [];
    if (!options.endpoint) missing.push("endpoint");
    if (!options.apiKey) missing.push("apiKey");
    if (missing.length > 0) {
      throw new Error(`[dataflow] init: missing required option(s): ${missing.join(", ")}`);
    }
    bootstrapState(resolveConfig(options));
    start();
  } else if (options && Object.keys(options).length > 0) {
    const merged = resolveConfig({ ...state.config, ...stripUndefined(options) });
    if (!merged.endpoint || !merged.apiKey) {
      throw new Error('[dataflow] init: "endpoint" and "apiKey" are required');
    }
    state.config = merged;
    maybeStartReplay();
  }
  return publicApi;
}
var publicApi = {
  init,
  flush: () => flush(),
  traceId: () => state.traceId,
  isSampled: () => state.sampled,
  version: VERSION
};
var index_default = publicApi;
var __internals = {
  state,
  queueSnapshot,
  emitEvent,
  onRouteChange,
  flushKeepalive
};
function __resetForTests() {
  runTeardowns();
  resetTransport();
  resetReplay();
  state.config = null;
  state.started = false;
  state.traceId = "";
  state.sampled = true;
  state.replaySampled = false;
  state.seq = 0;
  state.currentViewSpanId = void 0;
  state.currentUrl = void 0;
  state.lastRouteChangeTs = 0;
}
export {
  __internals,
  __resetForTests,
  index_default as default,
  init,
  publicApi
};
//# sourceMappingURL=index.js.map