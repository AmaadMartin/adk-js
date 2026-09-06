# Request-driven metric export

`RequestDrivenMetricReader` is an OpenTelemetry metric reader that exports when
the request lifecycle tells it to, instead of on a background timer. Reach for
it when you deploy an ADK agent on a runtime that throttles CPU between
requests, such as the Vertex AI Agent Runtime.

## Introduction

A normal metric pipeline uses `PeriodicExportingMetricReader`, which exports on
a timer. That works while the process keeps getting CPU. The Agent Runtime bills
per request and throttles CPU the instant a request finishes, so between
requests the timer gets no CPU. The periodic export is starved and metric points
are dropped.

This reader has no timer. It collects only when a hook says a collect is
warranted, and every hook is called from the request path, where CPU is
guaranteed. Three constraints shape it:

- **I1, export only while serving.** A collect runs while a request is in
  flight.
- **I2, never collect more often than the floor.** Two collects closer together
  than the floor are skipped. Cloud Monitoring throttles points sent faster.
- **I3, never collect too rarely.** A single export carries a limited number of
  points, so the reader collects at least once per configured period.

The configured export period stops being a schedule and becomes a grid of
guideposts: would-be collect times used to decide whether an event-driven
collect is warranted. Four decision points drive the reader:

1. **Baseline.** When the in-flight count drains to zero, collect. This is gated
   on the floor only, never on a guidepost.
2. **Overlap.** Under continuous load the in-flight count never reaches zero, so
   a crossed guidepost fires at the next request start instead.
3. **Mute.** A guidepost within the floor of the last collect is muted, and the
   grid advances by one period.
4. **Long request.** A lone long request collects off its own inference span
   starts, once 1.5 periods have passed without a collect in the current busy
   period.

Point 4 is what the returned span processor does. It watches for spans named
`call_llm`, the span ADK opens for a model call.

## Get started

`buildRequestDrivenMetrics` returns both halves. It sets no global provider, so
you install them yourself:

```ts
import {buildRequestDrivenMetrics, maybeSetOtelProviders} from '@google/adk';
import {ConsoleMetricExporter} from '@opentelemetry/sdk-metrics';

const {reader, spanProcessor} = buildRequestDrivenMetrics(
  new ConsoleMetricExporter(),
);

maybeSetOtelProviders([
  {metricReaders: [reader], spanProcessors: [spanProcessor]},
]);
```

Then call the hooks around each request. Each one answers "is a collect
warranted now?", and never blocks:

```ts
if (reader.noteRequestStart()) {
  void reader.submitCollect();
}
try {
  await serve(request, response);
} finally {
  // Awaited, so the export finishes before the connection closes.
  if (reader.noteRequestEnd()) {
    await reader.submitCollect();
  }
}
```

Call `noteRequestEnd` once the response body is fully sent. That drain is the
collect that carries the request's own points, and awaiting it is what keeps
them from being dropped when the runtime throttles the process.

A runnable version is in
[`samples/telemetry/agent_engine_metric_exporter/agent.ts`](../../../../samples/telemetry/agent_engine_metric_exporter/agent.ts).

## Configuration

Every value has a default, and an explicit option always wins over the
environment.

| Option                 | Environment variable                                             | Default           |
| ---------------------- | ---------------------------------------------------------------- | ----------------- |
| `exportIntervalMillis` | `OTEL_METRIC_EXPORT_INTERVAL`                                    | 60000             |
| `exportTimeoutMillis`  | `OTEL_METRIC_EXPORT_TIMEOUT`                                     | 30000             |
| `floorMillis`          | `GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS` | 5000              |
| `inferenceSpanName`    | none                                                             | `call_llm`        |
| `now`                  | none                                                             | `performance.now` |

An environment value that is not a finite number is logged and replaced by the
default. An empty or blank value counts as invalid, because `Number('')` is `0`
and a zero floor would disable I2.

`collectFloorMillis()` reads the floor at call time, so a caller can share the
same value the reader uses.

## Guarantees and failure modes

One collect runs at a time. `submitCollect()` queues each collect behind the
ones already running, which is what makes "consecutive collects are at least
the floor apart" hold.

`collectNow()` never rejects. A collect fired from a request start or a span
start has nobody to observe a rejection, so a failed collect and a failed export
are both logged instead. The span-start hook catches its own errors too: it runs
inside span creation, and a metrics failure must not break the span it observes.

The export runs with tracing suppressed, so the exporter's own request does not
open spans that record metrics that trigger the next export.

`shutdown()` drains the queued collects, runs one final best-effort collect,
then shuts the exporter down. It is safe to call twice, and after it
`submitCollect()` returns `undefined`.

One case still loses points, and it is accepted. A request shorter than the
floor that drains right after a collect, and is the last request before the
process goes idle, loses its points: a collect now is muted by the floor, and no
later request arrives to carry them.

Point 4 is inactive when metrics are on and tracing is off, because there is no
span processor to drive it. A lone very long request can then accumulate points
until it ends.
