# Telemetry samples

Runnable TypeScript agents that show how to wire ADK's telemetry surfaces. One
directory per feature, each exporting a `rootAgent` that runs with the ADK CLI.

Build and run these the same way as the other samples; see
[Running](../workflows/README.md#running). Unlike the workflow samples, these
are not executed in CI, only type-checked.

## Samples

- [`sqlite_span_exporter`](sqlite_span_exporter/agent.ts) - Persists spans to a
  local SQLite file with `SqliteSpanExporter`. Runs offline, and needs the
  optional `@mikro-orm/sqlite` peer. See the
  [guide](../../docs/guides/telemetry/sqlite_span_exporter/index.md).
