# ContainerCodeExecutor

Runs model-generated code inside a Docker container that has no network and no
Linux capabilities. Reach for it when an agent must run code you do not trust,
and you want container isolation without a managed cloud sandbox.

## Introduction

An agent that writes code has to run it somewhere. `UnsafeLocalCodeExecutor`
runs it in the host process, so the code sees the host filesystem, the host
network and the host credentials. `AgentEngineSandboxCodeExecutor` runs it in a
managed sandbox, which needs a Google Cloud project. `ContainerCodeExecutor`
sits between the two. It runs the code on a Docker daemon you control, local or
self-hosted.

The container is hardened when it starts. Networking is disabled, every Linux
capability is dropped, and `no-new-privileges` is set. The code cannot reach
the cloud metadata endpoint at `169.254.169.254`, cannot reach internal
services, and cannot escalate privileges. Set `networkEnabled: true` to give
the code a network when you trust it. There is no option that weakens the
capability or privilege settings.

One container serves every execution of one executor instance, which keeps each
run cheap. It also means a run that never returns would pin the container for
every later caller, so every execution runs under a wall-clock bound. A
supervisor process inside the container holds that bound, and the executed code
never runs in the supervisor. The code cannot disarm the bound, and the kill
reaches the whole process group, so what the code spawned dies with it.

The class is marked experimental. Its options may change.

## Get started

`dockerode` is an optional peer dependency, so install it first:

```sh
npm install dockerode
```

You also need a reachable Docker daemon and an image with `python3` on the
`PATH`. The executor verifies `python3` when the container starts, because the
timeout supervisor is written in Python.

The executor creates a container from an image the daemon already holds, and
never pulls one. Pull the image yourself first, or the daemon answers 404:

```sh
docker pull python:3-slim
```

```ts
import {ContainerCodeExecutor, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'data_analyst',
  model: 'gemini-2.5-flash',
  instruction: 'Analyze data using Python scripts.',
  codeExecutor: new ContainerCodeExecutor({image: 'python:3-slim'}),
});
```

## Choosing an image

Pass either a prebuilt tag or a directory that holds a Dockerfile. One of the
two is required, and the constructor throws when both are missing.

```ts
new ContainerCodeExecutor({image: 'python:3-slim'});
new ContainerCodeExecutor({dockerPath: './sandbox'});
```

With `dockerPath` the image is built before the container starts. It is tagged
`adk-code-executor:latest` unless you also pass `image`.

## Bounding a run

`timeoutSeconds` defaults to 300 and must be a positive integer. There is no
way to express "no timeout".

```ts
import {CodeExecutionLanguage, ContainerCodeExecutor} from '@google/adk';

const executor = new ContainerCodeExecutor({
  image: 'python:3-slim',
  timeoutSeconds: 2,
});

const result = await executor.executeCode({
  invocationContext,
  codeExecutionInput: {
    code: 'while True: pass',
    language: CodeExecutionLanguage.PYTHON,
    inputFiles: [],
  },
});

result.exitCode; // 124
result.stderr; // 'Code execution timed out after 2 seconds.'
```

A timeout is not an error. The executor reports exit code 124 and appends the
notice to whatever the code wrote to stderr. The container stays usable for the
next execution.

Code that leaves its process group on purpose, with `os.setsid()` or a double
fork, outlives the bound until the container is torn down.

## Languages

The declared language picks the interpreter inside the container.

| `CodeExecutionLanguage` | Command                |
| ----------------------- | ---------------------- |
| `PYTHON`                | `python3 -c`           |
| `JAVASCRIPT`            | `node -e`              |
| `TYPESCRIPT`            | `npx --yes tsx --eval` |
| `SHELL`                 | `sh -c`                |

The image must carry the interpreter you use. Any other language throws before
a container is started. The supervisor itself is always Python, so `python3` is
required whichever language you run.

`tsx` is fetched from the npm registry, which the default configuration blocks.
Install it in the image to run TypeScript, or set `networkEnabled: true`. A
missing interpreter is not a crash: the run reports a non-zero exit code and
the interpreter's own message on stderr.

## Shutting down

Call `close()` when the agent is done. It stops and removes the container, and
a second call does nothing.

```ts
await executor.close();
```

When Docker refuses the stop, `close()` rejects and the executor keeps the
container, so a later `close()` retries. Containers that are still running when
the process exits are stopped by a `beforeExit`, `SIGINT` and `SIGTERM` hook.

## Limitations

- `stateful` and `optimizeDataFile` are always false, and `outputFiles` is
  always empty. Use `AgentEngineSandboxCodeExecutor` when you need files back.
- A container is process isolation, not kernel isolation. For a kernel sandbox
  use a managed executor.
