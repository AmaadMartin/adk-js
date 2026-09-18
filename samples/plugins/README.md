# Plugin samples

Runnable TypeScript agents that show one ADK plugin each. Every directory
exports an `app` that the ADK CLI runs:

```bash
npm run build
npm run sample -- samples/plugins/<name>/agent.ts
```

These samples call a live model, so CI does not execute them. It type-checks
them with the rest of `samples/`:

```bash
npm run ts:check:samples
```

See [Running](../workflows/README.md#running) for how `npm run sample` works,
and how to script a run.

## `auto_tracing`

Installs [`AutoTracingPlugin`](../../docs/guides/plugins/auto_tracing/index.md)
and prints every span to the console, so you can see one span per function the
agent reaches with its arguments and result attached.

Environment variables:

| Variable         | Required | Meaning                           |
| ---------------- | -------- | --------------------------------- |
| `GEMINI_API_KEY` | yes      | Key for the model the agent calls |

Ask about Paris. The console exporter prints a `lookupCity` span and, nested
under it, a `format` span, each carrying `adk.fn.*` attributes. The names are
bare because `cityFacts` is a plain object; a method on a class prototype is
named `Owner.method`.
