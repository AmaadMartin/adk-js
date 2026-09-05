# Agent Engine telemetry

Joins an ADK run onto the trace of the caller that started it, stamps a support
identifier on the run, and drives metric export from the request path. Reach for
it when you deploy an ADK server on Vertex AI Agent Engine and its traces or
metrics do not show up the way you expect.

## Introduction

Agent Engine puts two constraints on telemetry that an ordinary server does not.

The first is trace continuity. Agent Engine terminates the caller's request and
starts a new one against your container, so the W3C `traceparent` of the
original request does not reach your server on the usual header. Agent Engine
forwards it on `Google-Agent-Engine-Traceparent` instead, and sends the caller's
own request identifier on `traceparent`. Without a middleware that reads the
first header, every run begins a new trace, and the caller's trace stops at the
Agent Engine boundary.

The second is CPU. The Agent Engine runtime bills by request and throttles CPU
the instant a request ends. A periodic metric reader exports on a timer, and
that timer gets no CPU between requests, so metrics accumulate and are dropped.
Collection has to be driven from the request lifecycle instead.

This module supplies the pieces for both:

| Symbol                                               | What it does                                               |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `isAgentEngine()`                                    | True when `GOOGLE_CLOUD_AGENT_ENGINE_ID` is set.           |
| `getPropagatedContext(headers)`                      | Builds the context a request should run under.             |
| `TopSpanProcessor`                                   | Records the support identifier on the first span of a run. |
| `createMetricsFlushingMiddleware(reader)`            | Drives a reader from the request lifecycle.                |
| `getAgentEngineMetricsSetup(build)`                  | Builds that reader once per process.                       |
| `maybeInstallRequestMetricsMiddleware(app, options)` | Installs the middleware when it applies.                   |
| `telemetryUserAgentHeaders()`                        | The `User-Agent` header for Agent Engine exporters.        |

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

## Request-driven metrics

`createMetricsFlushingMiddleware` drives a reader that satisfies
`RequestDrivenMetricReader`:

```ts
export interface RequestDrivenMetricReader {
  noteRequestStart(): boolean;
  noteRequestEnd(): boolean;
  submitCollect(): Promise<void> | undefined;
}
```

The middleware calls `noteRequestStart` when the request arrives and starts a
collect without waiting for it. It then replaces `res.end` so that the final
chunk is written first, the drain runs next, and the response is finalized last.
The client therefore has every byte before the export begins, and the export
runs while the request still holds CPU. A `close` listener drains an aborted
connection, where `res.end` is never reached.

Install it through `maybeInstallRequestMetricsMiddleware`, which returns without
doing anything off Agent Engine, and when telemetry is not exported to Google
Cloud:

```ts
import {maybeInstallRequestMetricsMiddleware} from '@google/adk';

maybeInstallRequestMetricsMiddleware(app, {
  otelToCloud: true,
  buildMetrics: () => ({reader, spanProcessor}),
});
```

`buildMetrics` is called at most once per process. `getAgentEngineMetricsSetup`
memoizes its result and ignores the builder after the first call, so the check
for an already-installed `MeterProvider` runs before ADK installs its own, and
every call site drives the same reader.

adk-js does not ship a `RequestDrivenMetricReader` implementation yet, so the
ADK API server supplies no builder and the middleware is not installed. Pass
your own builder to use the middleware today.

## Failure modes

Telemetry never breaks the request it rides on.

| What fails                                              | What happens                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A malformed `Google-Agent-Engine-Traceparent`           | The run starts a fresh trace. Nothing is logged.                                                   |
| `noteRequestStart` or the entry collect throws          | `Metrics request-start hook failed` is logged. The request proceeds.                               |
| `noteRequestEnd` or the drain collect throws or rejects | `Failed to flush metrics on request end` is logged. The response completes.                        |
| The downstream handler throws                           | The drain runs, then the error propagates, so the reader stays balanced.                           |
| A `MeterProvider` is already installed                  | A warning is logged and no reader is built. ADK defers to that setup.                              |
| `buildMetrics` throws                                   | `Failed to set up request-driven metric export on Agent Engine.` is logged and no reader is built. |

## Differences from adk-python

adk-python decides whether a span is the top span by comparing its parent span
id against the `traceparent` in baggage. adk-js asks the OpenTelemetry SDK
instead, which marks a propagated parent remote. The outcome is the same and the
SDK cannot mis-parse a caller-supplied value.

`telemetryUserAgentHeaders()` reports `Vertex-Agent-Engine/<adk version>`.
adk-python reports the `google-cloud-aiplatform` version and appends the OTLP
exporter version; neither is readable from adk-js without loading a
dependency's `package.json` at runtime.

adk-python drains inside a Starlette streaming response body iterator. Express
has no such hook, so adk-js wraps `res.end`. The ordering and the guarantee are
the same.
