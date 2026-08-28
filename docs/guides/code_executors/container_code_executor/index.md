# ContainerCodeExecutor

Runs model-generated code inside a Docker container that has no network and no
Linux capabilities. Reach for it when an agent must run code you do not trust,
and you want the isolation of a container without depending on a managed cloud
sandbox.

## Introduction

An agent that writes code has to run it somewhere. `UnsafeLocalCodeExecutor`
runs it in the host process, so the code sees the host filesystem, the host
network and the host credentials. `AgentEngineSandboxCodeExecutor` runs it in a
managed sandbox, which needs a Google Cloud project. `ContainerCodeExecutor`
sits between the two: it runs the code on a Docker daemon you control, local or
self-hosted.

The container is hardened when it starts. Networking is disabled, every Linux
capability is dropped, and `no-new-privileges` is set. The code therefore cannot
reach the cloud metadata endpoint at `169.254.169.254`, cannot reach internal
services, and cannot escalate privileges. Set `networkEnabled: true` to give the
code a network when you trust it.

One container serves every execution of one executor instance, which keeps each
run cheap. It also means a run that never returns would pin the container for
every later caller, so every execution runs under a wall-clock bound. The bound
is enforced by a supervisor process inside the container, not by the host, and
the executed code never runs in that supervisor. The code cannot disarm the
bound, and the kill reaches the whole process group, so what the code spawned
dies with it.

The executor is marked experimental. Its options may change.

## Get started

You need a reachable Docker daemon and an image with `python3` on the `PATH`.
The executor verifies `python3` when the container starts, because the timeout
supervisor is written in Python.

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

Pass either a prebuilt tag or a directory holding a Dockerfile. One of the two
is required; the constructor throws when both are missing.

```ts
new ContainerCodeExecutor({image: 'python:3-slim'});
new ContainerCodeExecutor({dockerPath: './sandbox'});
```

With `dockerPath`, the image is built before the container starts and is tagged
`adk-code-executor:latest` unless you also pass `image`.

To reach a daemon that is not the local default, pass `baseUrl`. It accepts a
unix socket path, and `tcp`, `http`, `https` and `ssh` urls.

```ts
new ContainerCodeExecutor({
  image: 'python:3-slim',
  baseUrl: 'tcp://127.0.0.1:2375',
});
```

## The execution bound

`timeoutSeconds` is the wall-clock bound on a single execution. It defaults to
300 and must be a positive integer; the constructor throws otherwise.

```ts
const executor = new ContainerCodeExecutor({
  image: 'python:3-slim',
  timeoutSeconds: 60,
});
```

When the bound expires the supervisor kills the run and the executor appends a
notice to whatever the code wrote to stderr:

```
Code execution timed out after 60 seconds.
```

The notice is appended, not assigned, because the code's own stderr is the
useful diagnostic. The container survives the kill, so the next execution runs
normally.

One case is not covered. Code that leaves its process group on purpose, with
`os.setsid()` or a double fork, outlives the bound until the container is torn
down.

## Languages

The executor picks the interpreter from `codeExecutionInput.language`: `python3`
for Python, `node` for JavaScript, `npx tsx` for TypeScript and `sh` for shell.
A language with no interpreter throws. Every language runs under the same
supervisor, so the bound applies to all of them.

## Shutting down

`close()` stops and removes the container. Call it when the agent is done.

```ts
await executor.close();
```

The executor also stops its containers on `beforeExit`, `SIGINT` and `SIGTERM`.
That hook is best effort: it does not run on `process.exit()`, on a fatal
signal, or after an uncaught exception. Treat `close()` as the supported
teardown.

## What it does not do

`stateful` and `optimizeDataFile` are always `false` on this executor. Input
files are ignored and `outputFiles` is always empty, matching the same executor
in adk-python.
