# Agent Engine telemetry

Joins an ADK run onto the trace of the caller that started it, and stamps a
support identifier on the run. Reach for it when you deploy an ADK server on
Vertex AI Agent Engine and its traces do not show up the way you expect.

## Introduction

Agent Engine terminates the caller's request and starts a new one against your
container, so the W3C `traceparent` of the original request does not reach your
server on the usual header. Agent Engine forwards it on
`Google-Agent-Engine-Traceparent` instead, and sends the caller's own request
identifier on `traceparent`. Without a middleware that reads the first header,
every run begins a new trace, and the caller's trace stops at the Agent Engine
boundary.

This module supplies the pieces:

| Symbol                          | What it does                                               |
| ------------------------------- | ---------------------------------------------------------- |
| `isAgentEngine()`               | True when `GOOGLE_CLOUD_AGENT_ENGINE_ID` is set.           |
| `getPropagatedContext(headers)` | Builds the context a request should run under.             |
| `TopSpanProcessor`              | Records the support identifier on the first span of a run. |

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

## Differences from adk-python

adk-python decides whether a span is the top span by comparing its parent span
id against the `traceparent` in baggage. adk-js asks the OpenTelemetry SDK
instead, which marks a propagated parent remote. The outcome is the same and the
SDK cannot mis-parse a caller-supplied value.

## Not here yet

Agent Engine's runtime bills by request and throttles CPU the instant a request
ends, so a periodic metric reader gets no CPU between requests and its metrics
are dropped. adk-python drives collection from the request path instead, in
`telemetry/_agent_engine.py` and `telemetry/_agent_engine_metric_exporter.py`.
adk-js has neither the reader nor the middleware that drives it.
