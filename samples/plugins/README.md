# Plugin samples

Runnable TypeScript agents that show one ADK plugin each. One directory per
plugin.

| Sample                             | Shows                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| [`debug_logging/`](debug_logging/) | `DebugLoggingPlugin` recording every invocation to a YAML file, with credentials redacted. |

## Running

Build once, then run any sample by its `agent.ts` path:

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/plugins/debug_logging/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`.

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
has its own `samples/tsconfig.json` and is type-checked separately, in CI and
locally:

```bash
npm run ts:check:samples
```

The CLI is interactive: type a message and press Enter, and type `exit` to
quit.
