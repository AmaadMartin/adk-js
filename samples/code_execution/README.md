# Code execution samples

Runnable TypeScript agents that write code and run it through a code executor.
One directory per executor setup. Each directory exports a `rootAgent` that runs
with the ADK CLI, and links the guide under `docs/guides/` that explains the
classes it uses.

## Running

Build once, then run any sample by its `agent.ts` path:

```bash
npm run build            # builds @google/adk (and the CLI); needed once / after changes
npm run sample -- samples/code_execution/local_code_execution/agent.ts
```

`npm run sample -- <path>` is shorthand for
`node dev/dist/esm/cli_entrypoint.js run <path>`.

`samples/` is not an npm workspace, so `npm run build` does not compile it. It
has its own `samples/tsconfig.json` and is type-checked separately, in CI and
locally:

```bash
npm run ts:check:samples
```

## Coverage

Lint, Prettier, the license check and `ts:check:samples` all read these files,
so a syntax, style, license or type error fails CI. Nothing executes them: the
`tests/integration/docs_samples` suite resolves its `SAMPLES_ROOT` to
`samples/workflows` and does not reach this directory.

## Requirements

Every sample in this category calls a live model. Set `GEMINI_API_KEY`; a `.env`
file in the working directory is loaded automatically.

`local_code_execution` also needs `python3` on the `PATH`, because the agent
runs every code block as Python.

## Samples

| Sample                                                   | Shows                                                                     | Key |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | --- |
| [`local_code_execution`](local_code_execution/README.md) | `UnsafeLocalCodeExecutor` running model-written Python, with file outputs | ✅  |

## Worth knowing

- **`UnsafeLocalCodeExecutor` has no sandbox.** The model's code runs as the
  current user with full access to the file system and the network. Use
  `ContainerCodeExecutor` when the code, or the prompt that produced it, is not
  trusted.
- **A code executor is not a tool.** The agent reads the first fenced code block
  out of each model response, runs it, and sends the output back as the next
  turn. Nothing appears in the tool list.
- **Every block the agent executes is run as Python.** The fence decides whether
  a block is recognized, not which interpreter runs it, so a
  ` ```javascript ` block reaches `python3`.

## See also

- [Code executors](../../docs/guides/code_executors/index.md) - How an agent runs model-written code, and how to choose between the executors.
- [Tool samples](../tools/README.md) - Agents that call tools rather than write code.
