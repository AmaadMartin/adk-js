# Telemetry samples

Runnable TypeScript agents that show how to wire ADK's telemetry surfaces. One
directory per feature, each exporting an agent that runs with the ADK CLI.

## Running

Build and run these the way the workflow samples document, in
[samples/workflows/README.md](../workflows/README.md#running):

```bash
npm run sample -- samples/telemetry/sqlite_span_exporter/agent.ts
```

The CLI is interactive: type a message and press Enter to send it, then type
`exit` to quit.

Unlike the workflow samples, these are not executed in CI, only type-checked.

## Samples

- [`agent_engine`](agent_engine/agent.ts) - Exercises the Vertex AI Agent Engine
  telemetry paths by hand: the caller's trace context, the support identifier,
  and metric export from the request path. See the
  [guide](../../docs/guides/telemetry/agent_engine/index.md).
- [`experimental_semconv`](experimental_semconv/agent.ts) - Reports every model
  call in the experimental OpenTelemetry GenAI semantic conventions, and prints
  the completion-details log record. Needs a Gemini API key. See the
  [guide](../../docs/guides/telemetry/experimental_semconv/index.md).
- [`sqlite_span_exporter`](sqlite_span_exporter/agent.ts) - Persists spans to a
  local SQLite file with `SqliteSpanExporter`. Runs offline, and needs the
  optional `@mikro-orm/sqlite` peer. See the
  [guide](../../docs/guides/telemetry/sqlite_span_exporter/index.md).

## Driving the Agent Engine paths

Every Agent Engine path is inert unless `GOOGLE_CLOUD_AGENT_ENGINE_ID` is set.
Off Agent Engine the sample is an ordinary agent, which is the point: nothing
changes for a laptop run.

Serve the agent, pretending to be Agent Engine:

```bash
export GOOGLE_CLOUD_AGENT_ENGINE_ID=my-deployment
npx adk api_server samples/telemetry
```

Send a request carrying both headers. `Google-Agent-Engine-Traceparent` parents
the run onto the caller's span; `traceparent` is the support identifier the run
records as the `supportID` attribute on its top span.

```bash
curl -sS http://localhost:8000/api/reasoning_engine \
  -H 'Content-Type: application/json' \
  -H 'Google-Agent-Engine-Traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -H 'traceparent: support-id-from-the-user-report' \
  -d '{"input": {"appName": "agent_engine", "userId": "u", "sessionId": "s",
       "newMessage": {"role": "user", "parts": [{"text": "hello"}]}}}'
```

Request-driven metric export needs Google Cloud telemetry as well, so add
`--otel_to_cloud` to the server command. Metrics then leave on the request path
instead of on a background timer.
