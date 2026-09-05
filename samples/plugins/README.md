# Plugin samples

Runnable TypeScript samples for the ADK plugins, one directory per plugin. Each
directory exports an `App` that runs with the ADK CLI.

## Running

Build once, then run a sample by its `agent.ts` path:

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/plugins/auto_tracing/agent.ts
```

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
has its own `samples/tsconfig.json` and is type-checked separately:

```bash
npm run ts:check:samples
```

## Samples

### auto_tracing

[`auto_tracing/agent.ts`](auto_tracing/agent.ts) - `AutoTracingPlugin` wrapping
the helpers an agent reaches, with a console span exporter so a run prints the
`adk.fn.*` spans. Runs offline, with no model and no credentials. The guide is
[docs/guides/plugins/auto_tracing](../../docs/guides/plugins/auto_tracing/index.md).
