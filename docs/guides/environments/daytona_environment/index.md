# DaytonaEnvironment

`DaytonaEnvironment` gives an agent a remote workspace. It runs shell commands
and reads and writes files inside one Daytona sandbox. Reach for it when the
commands come from a model and you do not want them on the host.

## Introduction

ADK models a workspace as a `BaseEnvironment`: a working directory plus three
operations, `execute`, `readFile` and `writeFile`. `LocalEnvironment`
implements that with child processes on the host machine. It is fast and needs
no account, but a command it runs has the same reach as the agent process.

`DaytonaEnvironment` implements the same three operations against a Daytona
sandbox. The sandbox is the isolation boundary, so a command cannot touch the
host filesystem or the host network stack. That costs a Daytona account, an API
key, and the latency of a remote call on every operation.

Two differences from `LocalEnvironment` are worth knowing before you swap one
for the other.

- Daytona folds a command's stderr into its stdout, so `stderr` in the returned
  `ExecutionResult` is always `''`.
- `LocalEnvironment` confines a file path to its working directory.
  `DaytonaEnvironment` does not, because the sandbox already confines it. An
  absolute path such as `/etc/hostname` reads the sandbox's own file.

The sandbox limits where a command runs. It does not make the command safe. A
tool that lets a model choose the command string still needs its own gate.

## Get started

Install the optional peer dependency and set a credential:

```sh
npm install @daytona/sdk
export DAYTONA_API_KEY=...
```

```ts
import {DaytonaEnvironment} from '@google/adk';

const env = new DaytonaEnvironment({envVars: {STAGE: 'dev'}});
await env.initialize();
try {
  // result is {exitCode: 0, stdout: 'hello\n', stderr: '', timedOut: false}
  const result = await env.execute('echo hello');

  await env.writeFile('sub/notes.txt', 'hello');
  const bytes = await env.readFile('sub/notes.txt');
} finally {
  await env.close();
}
```

`initialize()` creates the sandbox. `close()` deletes it and releases the
client. Always call `close()`, and call it from a `finally` block, or the
sandbox stays alive until its auto-stop interval elapses.

## Configuration

Every option is optional.

| Option           | Meaning                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `image`          | Daytona image used to create the sandbox. Without it, Daytona's default `python` snapshot is used. |
| `timeoutSeconds` | Sandbox lifetime, and the default per-command timeout. Defaults to 300.                            |
| `apiKey`         | Daytona API key. Falls back to `DAYTONA_API_KEY`.                                                  |
| `apiUrl`         | Daytona API URL. Falls back to the Daytona Cloud API.                                              |
| `envVars`        | Environment variables set inside the sandbox.                                                      |

`timeoutSeconds` also sets the sandbox's auto-stop interval, in whole minutes
rounded down. A positive value under a minute still gets one minute, because
Daytona reads `0` as "never auto-stop".

Pass a per-call timeout to override the default for one command:

```ts
const result = await env.execute('npm install', 600);
```

## Lifecycle and failure modes

`initialize()` and `close()` are both idempotent. A second call does nothing.

The working directory is `/workspaces`. A relative path resolves against it;
an absolute path is used unchanged.

| Condition                               | What happens                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@daytona/sdk` is not installed         | `initialize()` throws an error naming the package and the install command.                        |
| No credential is reachable              | The Daytona SDK throws `DaytonaAuthenticationError`.                                              |
| An operation runs before `initialize()` | It throws `Environment is not initialized. Call initialize() first.`                              |
| A command exits non-zero                | Reported as `exitCode`. Nothing is thrown.                                                        |
| A command exceeds its timeout           | Returned as `{exitCode: -1, timedOut: true}`. Nothing is thrown.                                  |
| A file does not exist                   | `readFile` throws `File not found: <path>`, with the Daytona error as `cause`.                    |
| `close()` cannot delete the sandbox     | The error propagates, but the client is still released and the environment is left uninitialized. |

`writeFile` creates the parent directories of its target, outermost first, and
tolerates a directory that already exists. Any other directory failure is
thrown, so a permission problem surfaces where it happens.
