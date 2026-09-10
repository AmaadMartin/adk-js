# CloudRunSandboxCodeExecutor

`CloudRunSandboxCodeExecutor` runs model-generated code inside the sandbox of
the Cloud Run container the agent already runs in. Reach for it when you deploy
an agent to Cloud Run with sandboxes enabled and you want isolated code
execution without a second cloud resource.

## Introduction

A model writes code well, but the code is untrusted. Running it on the agent's
own host gives it your service account, your file system and your network.
`UnsafeLocalCodeExecutor` does exactly that and isolates nothing, so it belongs
in development. `AgentEngineSandboxCodeExecutor` isolates properly, but it
calls a Vertex AI Agent Engine sandbox over the network, which is a separate
resource to create, pay for and keep alive.

Cloud Run offers a third option. A Cloud Run container with sandboxes enabled
installs a guest `sandbox` binary, and that binary runs a command under kernel
isolation inside the same container. This executor drives it. There is no extra
resource and no network hop, and the code runs with no network access unless
you ask for it.

The executor spawns `sandbox do [--allow-egress] <interpreterPath>` once per
call and writes the code to the child's stdin. It works only from inside a
Cloud Run container that has sandboxes enabled. It cannot reach a sandbox
remotely, because it drives the local binary.

## Get started

```ts
import {CloudRunSandboxCodeExecutor, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'data_analyst',
  model: 'gemini-2.5-flash',
  instruction: 'Write and run code to answer the question.',
  codeExecutor: new CloudRunSandboxCodeExecutor(),
});
```

The agent extracts the code block from the model response, runs it, and feeds
the output back to the model.

## Options

| Option            | Default                      | What it does                                                         |
| ----------------- | ---------------------------- | -------------------------------------------------------------------- |
| `sandboxBin`      | `/usr/local/gcp/bin/sandbox` | Path of the guest sandbox binary.                                    |
| `allowEgress`     | `false`                      | Whether the sandbox may reach the network.                           |
| `interpreterPath` | `process.execPath`           | The interpreter the sandbox runs. It reads the program from stdin.   |
| `timeoutSeconds`  | `300`                        | Wall-clock bound on one execution. Pass `null` to wait indefinitely. |

Egress is off by default because generated code that can reach the network can
also exfiltrate whatever it reads. Turn it on only for code that needs it:

```ts
new CloudRunSandboxCodeExecutor({
  allowEgress: true,
  interpreterPath: '/usr/bin/python3',
  timeoutSeconds: 30,
});
```

`codeExecutionInput.language` is ignored. The executor runs one interpreter,
and `interpreterPath` is what picks it. Set it to your Python interpreter to
run Python; the default runs the same Node binary as the agent.

`stateful` and `optimizeDataFile` are `false` and cannot be changed. The
constructor throws if you pass `true` for either.

## Failure modes

`executeCode` never throws. Every failure comes back as a
`CodeExecutionResult`, so the agent's own retry loop can show the error to the
model:

| What happened                       | What you get                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The sandbox binary is missing       | `stderr` says `Sandbox binary "<path>" not found.`, and `exitCode` is unset.                                         |
| The spawn failed for another reason | `stderr` says `Unexpected error running sandbox: <message>`, and `exitCode` is unset.                                |
| The run passed `timeoutSeconds`     | Partial `stdout`, and `exitCode` `-9` (`1` on Windows). `stderr` reports the timeout when the sandbox wrote nothing. |
| The run finished                    | The child's `stdout`, `stderr` and `exitCode`.                                                                       |

Running outside Cloud Run gives you the first row on every call. That is the
designed behaviour, not a crash.

The sandbox writes network-namespace teardown warnings to stderr on runs that
fully succeed. The executor removes them, because any non-empty stderr makes
the result report `OUTCOME_FAILED` to the model.

`outputFiles` is always empty. The executor collects nothing from the sandbox.
