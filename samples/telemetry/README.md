# Telemetry samples

Runnable TypeScript agents that show how to wire ADK's telemetry surfaces. One
directory per feature, each exporting an agent that runs with the ADK CLI.

## Running

Build and run these the way the workflow samples document, in
[samples/workflows/README.md](../workflows/README.md#running):

```bash
npm run sample -- samples/telemetry/experimental_semconv/agent.ts
```

The CLI is interactive: type a message and press Enter to send it, then type
`exit` to quit.

Unlike the workflow samples, these are not executed in CI, only type-checked.

## Samples

- [`experimental_semconv`](experimental_semconv/agent.ts) - Reports every model
  call in the experimental OpenTelemetry GenAI semantic conventions, and prints
  the completion-details log record. Needs a Gemini API key. See the
  [guide](../../docs/guides/telemetry/experimental_semconv/index.md).
