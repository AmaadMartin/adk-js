# Request-driven metric export

`buildRequestDrivenMetrics()` returns an OpenTelemetry metric reader that has no
export timer, plus the span processor that drives it. Reach for it when your
agent runs on the Vertex AI Agent Runtime, where a background timer gets no CPU
and a normal metric pipeline silently drops points.

## Introduction

The Agent Runtime bills per request and throttles CPU the instant a request
finishes. `PeriodicExportingMetricReader`, the reader you would normally
install, exports on a `setInterval`. Between requests that interval callback
gets no CPU, so the export is starved and the points it was carrying are lost.
The problem is not that the export is slow; it is that the export never runs.

This reader removes the timer. Nothing collects on its own. Your request layer
tells the reader when a request starts and when it ends, and the reader answers
whether now is a good moment to collect. Because every collect is driven from
the request path, it always has CPU.

Three constraints shape which moments qualify.

- **I1, export only while serving.** A collect runs while at least one request
  is in flight.
- **I2, never collect too often.** Two collects are never closer than the floor,
  5000 ms by default. The Cloud Monitoring backend does not support a faster
  rate.
- **I3, never collect too rarely.** One export carries a limited number of
  points, so under sustained load the reader collects at least once per
  configured period.

The configured export period is therefore not a schedule. It is a grid of
guideposts, and a guidepost is only a hint that a collect is now warranted.

This reader is for the Agent Runtime and for hosts that behave like it. On a
normal always-on server, keep `PeriodicExportingMetricReader`: it needs no
request-layer wiring and its timer runs.

## Get started

Build the reader and the span processor from a push exporter, then install each
one on its provider:

```ts
import {buildRequestDrivenMetrics} from '@google/adk';
import {MetricExporter} from '@google-cloud/opentelemetry-cloud-monitoring-exporter';
import {metrics} from '@opentelemetry/api';
import {MeterProvider} from '@opentelemetry/sdk-metrics';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';

const {reader, spanProcessor} = buildRequestDrivenMetrics(
  new MetricExporter({projectId}),
);

const meterProvider = new MeterProvider({readers: [reader]});
metrics.setGlobalMeterProvider(meterProvider);

const tracerProvider = new NodeTracerProvider({
  spanProcessors: [spanProcessor],
});
tracerProvider.register();
```

`buildRequestDrivenMetrics()` sets no global provider itself, so you decide
where each half goes. You usually do not have to: `getGcpExporters({enableMetrics:
true})` already returns this pair instead of a periodic reader when
`GOOGLE_CLOUD_AGENT_ENGINE_ID` is set, and the periodic reader everywhere else.

Then drive the reader from your request layer. Each hook is synchronous and
cheap, and returns whether to collect:

```ts
async function serve(request: Request): Promise<Response> {
  if (reader.noteRequestStart()) {
    // Fire and forget: this must not delay the request.
    void reader.submitCollect();
  }
  try {
    return await handle(request);
  } finally {
    if (reader.noteRequestEnd()) {
      // Awaited, so the export finishes before the connection closes.
      await reader.submitCollect();
    }
  }
}
```

Call `noteRequestEnd()` after the response body is fully sent. That is the last
moment your process is guaranteed CPU.

**You must drive the reader.** Installing it is not enough. Every collect except
the one at shutdown starts from `noteRequestStart()` or `noteRequestEnd()`, and
point 4 needs a request in flight before it will fire. A host that installs the
reader and never calls the hooks exports nothing until it shuts down. ADK Python
supplies that driver as request middleware; adk-js does not have one yet, so for
now the host wires the two calls itself.

The span processor needs no wiring beyond installing it. It watches for
`call_llm` span starts, which `LlmAgent` opens on every model call, and drives
the reader from them. Set `inferenceSpanName` if your inference span is named
something else, for instance `generate_content` when the GenAI SDK's own
instrumentation supplies it.

## When the reader collects

Four decisions produce a collect.

1. **A request drains.** When the in-flight count falls to zero, collect. This
   is the common case, and it is gated only on the floor.
2. **A guidepost fires at the next start.** Under continuous overlap the
   in-flight count never reaches zero, so a crossed guidepost collects at the
   next request start instead.
3. **A guidepost inside the floor is muted.** If the crossed guidepost sits
   within the floor of the last collect, the reader skips it and moves the grid
   on by one period. It does not retry the same guidepost as soon as the floor
   allows.
4. **A long request collects off its own model calls.** Once 1.5 periods have
   passed within the current busy period, the next `call_llm` span start
   collects. This is the only thing that stops a single very long request from
   accumulating points.

Point 4 measures "overdue" over the _current_ busy period, from its last collect
or from when it began. A collect from an earlier busy period cannot make a fresh
short request look overdue.

Collects never overlap. A committed collect closes a guard that makes every hook
answer `false`, and `submitCollect()` puts the work on a single-slot queue.

## The case that still loses points

A request shorter than the floor, that drains right after a collect, and that is
the last request before the process goes idle, loses its points. A collect at
its drain is muted by the floor, and no later request arrives to carry them.

```text
req1  [==========]
                  +- in flight 1 -> 0  ->  collect
req2               [=]
                     +- in flight 1 -> 0, but a collect here is under the floor;
                        the points wait for the next collect, which never comes
```

This is accepted. Closing it would mean either exporting faster than the backend
supports, or holding CPU after the response, and the reader does neither.

## Configuration

Two environment variables, both in milliseconds:

| Variable                                                         | Default | Meaning                                    |
| ---------------------------------------------------------------- | ------- | ------------------------------------------ |
| `OTEL_METRIC_EXPORT_INTERVAL`                                    | 60000   | Spacing of the guidepost grid (I3).        |
| `GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS` | 5000    | Minimum spacing between two collects (I2). |

A value that is missing, empty or not a number logs a warning and falls back to
the default. The reader never throws over configuration.

`OTEL_METRIC_EXPORT_TIMEOUT` (default 30000) is the per-collect timeout, as it
is for the periodic reader.

`buildRequestDrivenMetrics()` takes the same three timings as options, plus an
injectable clock. The options exist mainly for tests:

```ts
const {reader} = buildRequestDrivenMetrics(exporter, {
  exportIntervalMillis: 10_000,
  floorMillis: 3_000,
});
```

The default floor is exported as `MIN_EXPORT_INTERVAL_MS`. It is the shared
minimum for every ADK metric reader, including the periodic reader in
`getGcpExporters()`.

## Failure handling

Nothing the reader does can fail a request.

- A collect that throws is logged and swallowed. A fire-and-forget collect has
  nobody to observe a rejection.
- An export the exporter reports as failed is logged. The reader collects again
  at the next opportunity.
- Errors reported by the collection itself are logged, and the reader still
  exports what it did collect.
- A failure inside the span-start hook is logged. The span it observed is
  unaffected.
- An unmatched `noteRequestEnd()` leaves the in-flight count at zero rather than
  driving it negative.

## Interaction with tracing

Each export runs with tracing suppressed, so the exporter's own network call
does not produce spans that produce metrics that produce another export.
Suppression relies on an OpenTelemetry context manager being registered, which
`NodeTracerProvider.register()` does.

The reader suppresses tracing only. OpenTelemetry JavaScript has no
metrics-suppression key, so this is narrower than the equivalent in ADK Python.

## Shutting down

`meterProvider.shutdown()` reaches the reader. It waits for any queued collect,
runs one final collect, and then shuts the exporter down. `forceFlush()`
collects once and then flushes the exporter.
