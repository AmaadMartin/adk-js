# Telemetry samples

Runnable TypeScript agents that show how to wire ADK's telemetry surfaces. One
directory per feature, each exporting a `rootAgent` that runs with the ADK CLI.

## Running

Build once, then run a sample by its `agent.ts` path:

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/telemetry/sqlite_span_exporter/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`.

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
has its own `samples/tsconfig.json` and is type-checked separately, in CI and
locally:

```bash
npm run ts:check:samples
```

These samples call a live model, so they need an API key. Set `GEMINI_API_KEY`
before running one. They are not executed in CI.

## Samples

- [`sqlite_span_exporter`](sqlite_span_exporter/agent.ts) - Persists spans to a
  local SQLite file with `SqliteSpanExporter`. Needs `@mikro-orm/sqlite`. See
  the [guide](../../docs/guides/telemetry/sqlite_span_exporter/index.md).
