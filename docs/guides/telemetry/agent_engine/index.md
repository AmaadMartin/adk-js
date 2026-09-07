# Agent Engine telemetry

Joins an ADK run onto the trace of the caller that started it, stamps a support
identifier on the run, and exports metrics from the request path. Reach for it
when you deploy an ADK server on Vertex AI Agent Engine and its traces or
metrics do not show up the way you expect.

## Introduction

Agent Engine terminates the caller's request and starts a new one against your
container, so the W3C `traceparent` of the original request does not reach your
server on the usual header. Agent Engine forwards it on
`Google-Agent-Engine-Traceparent` instead, and sends the caller's own request
identifier on `traceparent`. Without a middleware that reads the first header,
every run begins a new trace, and the caller's trace stops at the Agent Engine
boundary.

This module supplies the pieces:

| Symbol                                            | What it does                                               |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `isAgentEngine()`                                 | True when `GOOGLE_CLOUD_AGENT_ENGINE_ID` is set.           |
| `getPropagatedContext(headers)`                   | Builds the context a request should run under.             |
| `TopSpanProcessor`                                | Records the support identifier on the first span of a run. |
| `maybeInstallRequestMetricsMiddleware(app, opts)` | Drives metric export from the request lifecycle.           |

The ADK API server wires all of this up already. Use the pieces directly only
when you host ADK behind your own Express app.

## Get started

Register the context middleware before every route, so each run inherits the
caller's trace.

```ts
import {getPropagatedContext, isAgentEngine} from '@google/adk';
import {context} from '@opentelemetry/api';
import express from 'express';

const app = express();

if (isAgentEngine()) {
  app.use((req, _res, next) => {
    context.with(getPropagatedContext(req.headers), next);
  });
}
```

Then add `TopSpanProcessor` to your tracer provider, so the caller's request
identifier lands on the run.

```ts
import {isAgentEngine, TopSpanProcessor} from '@google/adk';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';

const provider = new NodeTracerProvider({
  spanProcessors: isAgentEngine() ? [new TopSpanProcessor()] : [],
});
provider.register();
```

A run started by a request carrying both headers now produces a top span that is
a child of the caller's span and carries a `supportID` attribute. Query your
traces for `supportID = <the traceparent the user reports>` to find the run
behind a support ticket.

## Trace context

`getPropagatedContext` reads two headers, and it never throws.

`Google-Agent-Engine-Traceparent` is parsed by the W3C trace context
propagator. A value the propagator rejects leaves the context unchanged, so the
run starts a fresh trace instead of failing. Nothing is logged: the header comes
from outside and a malformed one is not your server's problem.

`traceparent` is treated as an opaque string. ADK never parses it. It is stored
in baggage under `google_traceparent`, and `TopSpanProcessor` copies it onto the
top span as the `supportID` attribute.

A repeated header arrives from Node as an array. Only the first value is used.

`TopSpanProcessor` sets `supportID` on the top span of a run only, never on its
children, so the attribute identifies the run rather than each of its spans. A
span is the top span when it has no parent, or when its parent came in over the
wire from the propagator.

## Failure modes

Telemetry never breaks the request it rides on. A malformed
`Google-Agent-Engine-Traceparent` makes the run start a fresh trace, and nothing
is logged.

## Request-driven metric export

Agent Engine bills by request and throttles CPU the instant a request ends. A
periodic metric reader gets no CPU between requests, so its export is starved
and metric points are dropped. On Agent Engine ADK swaps the periodic reader for
a reader with no timer at all, and collects from the request lifecycle instead.

`getGcpExporters({enableMetrics: true})` builds that reader when
`GOOGLE_CLOUD_AGENT_ENGINE_ID` is set. Install the middleware that drives it on
your app:

```ts
import {maybeInstallRequestMetricsMiddleware} from '@google/adk';
import express from 'express';

const app = express();

await maybeInstallRequestMetricsMiddleware(app, {otelToCloud: true});
```

The call is a no-op off Agent Engine, and a no-op when `otelToCloud` is false.
The ADK API server makes it for you.

### What the reader guarantees

- **Export only while serving.** Every collect runs while a request is in
  flight, which is the only time CPU is guaranteed.
- **Never collect more often than the floor**, 5000 ms by default. Set
  `GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS` to change it.
  Exporting faster than the floor risks points being rejected or throttled.
- **Never collect too rarely.** One export carries a bounded number of points,
  so `OTEL_METRIC_EXPORT_INTERVAL` (60000 ms by default) becomes a grid of
  guideposts. Under sustained load a crossed guidepost forces a collect at the
  next request start. A very long single request collects on its own
  `generate_content` spans, once 1.5 grid periods have passed.

### What it loses

A request shorter than the floor, draining right after a collect, and being the
last request before the process goes idle, loses its points. A collect then is
muted by the floor, and no later request arrives to carry them. This is the one
documented loss case.

### Opting out

If your process installs its own `MeterProvider` before ADK runs, ADK's reader
would not land on the active provider. ADK detects that, logs a warning, and
leaves your setup alone. Metrics may then be dropped between requests, which is
what the warning says.
