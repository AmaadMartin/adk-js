# Telemetry samples

Runnable TypeScript agents that show how to wire ADK's telemetry surfaces. One
directory per feature, each exporting a `rootAgent` that runs with the ADK CLI.

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

- [`sqlite_span_exporter`](sqlite_span_exporter/agent.ts) - Persists spans to a
  local SQLite file with `SqliteSpanExporter`. Runs offline, and needs the
  optional `@mikro-orm/sqlite` peer. See the
  [guide](../../docs/guides/telemetry/sqlite_span_exporter/index.md).
