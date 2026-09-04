# Plugin samples

Runnable TypeScript agents that show one ADK plugin each. One directory per
plugin.

| Sample                             | Shows                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| [`debug_logging/`](debug_logging/) | `DebugLoggingPlugin` recording every invocation to a YAML file, with credentials redacted. |

## Running

```bash
npm run build            # needed once / after changes
npm run sample -- samples/plugins/debug_logging/agent.ts
```

See [Running](../workflows/README.md#running) for how `npm run sample` works,
how `samples/` is type-checked, and how to script a run.
