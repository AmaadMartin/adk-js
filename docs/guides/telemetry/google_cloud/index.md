# Google Cloud telemetry export

`getGcpExporters` and `getGcpResource` send an agent's traces, metrics and log
records to Google Cloud. Reach for them when you run an agent on Google Cloud,
or on a laptop against a Google Cloud project, and you want the three signals
to arrive without running your own OpenTelemetry collector.

## Introduction

ADK instruments a run with OpenTelemetry. It opens a span for each model call
and each tool call, records metrics, and emits log records. Those signals reach
a backend only once you install providers for them, which is what
`maybeSetOtelProviders` does.

There are two ways to feed it. The generic path reads the standard
`OTEL_EXPORTER_OTLP_*` variables and needs a collector you operate. The Google
Cloud path is this module: it builds exporters that post OTLP over HTTP
straight to `telemetry.googleapis.com`, signed with your Google credentials.
Cloud Trace, Cloud Monitoring and Cloud Logging read from there, so no
collector sits in between.

`getGcpResource` builds the OpenTelemetry resource that says which project and
which process the signals came from. Pass its result to
`maybeSetOtelProviders` alongside the exporters.

## Get started

`adk web --otel_to_cloud` already does all of this. Wire it yourself when you
embed ADK in your own service:

```ts
import {
  getGcpExporters,
  getGcpResource,
  maybeSetOtelProviders,
  resolveGoogleAuth,
} from '@google/adk';

const googleAuth = await resolveGoogleAuth();

maybeSetOtelProviders(
  [
    await getGcpExporters({
      enableTracing: true,
      enableMetrics: true,
      enableLogging: true,
      googleAuth,
    }),
  ],
  getGcpResource(googleAuth?.projectId),
);
```

Resolve the credentials with `resolveGoogleAuth` rather than by hand. It reads
Application Default Credentials, and on Agent Engine it turns the project
number they report into a project id. Pass its result to both calls, so the
exporters and the resource name the same project.

`googleAuth` is optional on `getGcpExporters`. Omit it and it calls
`resolveGoogleAuth` itself, which is enough when you do not also need the
project id for the resource. `resolveGoogleAuth` returns `undefined` when the
process is not authenticated, and nothing here throws.

Supply `googleAuth` yourself, rather than letting it resolve, when your service
already holds credentials. A project id you pass in is used as given: no
project-number lookup runs on it.

Enable `telemetry.googleapis.com` on the project before you run this. Traces go
to `https://telemetry.googleapis.com/v1/traces`, metrics to `/v1/metrics` and
log records to `/v1/logs`.

## What you get

Each flag installs one component, and nothing more:

| Flag            | Installed component                                    |
| --------------- | ------------------------------------------------------ |
| `enableTracing` | A batching span processor.                             |
| `enableMetrics` | A periodic metric reader that exports every 5 seconds. |
| `enableLogging` | A batching log record processor.                       |

Telemetry setup never throws. When no project can be determined,
`getGcpExporters` logs a warning and returns an empty set of hooks, so the
agent runs with no export rather than failing to start.

## The resource

`getGcpResource(projectId)` merges four sources. Later ones win:

1. A per-process `service.instance.id`, plus `gcp.project_id` and
   `cloud.account.id` from `projectId`.
2. On Agent Engine, the attributes describing the deployment.
3. `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`.
4. Off Agent Engine, the Google Cloud detector's attributes for Compute Engine,
   GKE and Cloud Run.

Step 3 sits above step 1, so `OTEL_RESOURCE_ATTRIBUTES=gcp.project_id=other`
overrides the argument you passed. Step 4 is skipped on Agent Engine, where the
detector would otherwise overwrite the deployment's own attributes.

## Log names

Cloud Logging files a record under a log name. A record that carries none lands
in a generic `otlp` log, which breaks log filters. The log record processor
therefore names every record before it is batched:

- An explicit `gcp.log_name` attribute on the record wins.
- Otherwise the default is `adk-otel`, or the value of `GCP_DEFAULT_LOG_NAME`.
- On Agent Engine the default is
  `aiplatform.googleapis.com/reasoning_engine_stdout`, which is where the
  previous stdout pipeline wrote.

A record that carries an `eventName` keeps it as an `event.name` attribute, and
the processor clears the field. Cloud Logging reads `eventName` ahead of
`gcp.log_name`, so leaving it set scatters the records over one log per event
type.

The processor rewrites a copy. The provider hands the same record to every
processor you register, so your own processors see it unchanged.

## Agent Engine

Set `GOOGLE_CLOUD_AGENT_ENGINE_ID` and the resource describes the deployment:
`cloud.platform` becomes `gcp.agent_engine`, `service.name` becomes the engine
id, and `cloud.region` comes from `GOOGLE_CLOUD_AGENT_ENGINE_LOCATION` or
`GOOGLE_CLOUD_LOCATION`.

Log records additionally carry the MonitoredResource hints Cloud Logging needs
to file them against the ReasoningEngine rather than a generic task. Those
hints stay on the log records: `gcp.resource_type` also steers metric
ingestion, so putting it on the shared resource would move the deployment's
metrics off their monitored resource.

Agent Engine reports a project number where Cloud Logging wants a project id,
so `resolveGoogleAuth` turns one into the other through the Cloud Resource
Manager API. Enable `cloudresourcemanager.googleapis.com` on the project.
Without it the lookup warns and the project number is kept, which leaves logs
and traces unassociated.

This is why the example resolves once and passes the result to both calls. A
project id you supply yourself is used as given, so resolving the credentials
by hand and passing the project number through would produce the same split.

## Mutual TLS

Set `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` and the exporters look for the
context-aware client certificate gcloud provides, and present it.
`GOOGLE_API_USE_MTLS_ENDPOINT` then picks the host: `always` uses
`telemetry.mtls.googleapis.com`, `never` uses `telemetry.googleapis.com`, and
`auto`, the default, uses the mutual-TLS host only when a certificate resolved.

When no certificate resolves, export stays on the plain host and logs a
warning, whatever `GOOGLE_API_USE_MTLS_ENDPOINT` says. The mutual-TLS host
rejects a connection that presents no certificate, so selecting it would drop
all telemetry.
