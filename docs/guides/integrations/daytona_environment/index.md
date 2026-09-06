# DaytonaEnvironment

`DaytonaEnvironment` gives an agent a remote workspace: a Daytona sandbox that
runs shell commands and holds files. Reach for it when the commands come from a
model and you do not want them anywhere near the host.

## Introduction

An environment is the thing an agent runs commands in. ADK ships two.

`LocalEnvironment` spawns a child process on the machine the agent runs on. It
is fast and needs no account, but a command it runs has the same reach as the
agent process itself.

`DaytonaEnvironment` sends the command to a Daytona sandbox instead. The sandbox
is a remote container with its own filesystem and its own network identity.
A command can still do anything it likes inside that sandbox, so treat it as
isolation from the host, not as a general security control.

Both implement `BaseEnvironment`, so code written against the interface works
with either one. The differences you can observe are:

|                                    | `LocalEnvironment`                     | `DaytonaEnvironment`              |
| ---------------------------------- | -------------------------------------- | --------------------------------- |
| Where a command runs               | the host                               | a remote sandbox                  |
| `stderr`                           | captured separately                    | always `''`, merged into `stdout` |
| Working directory                  | a temporary directory, or one you name | `/workspaces`                     |
| Path outside the working directory | rejected                               | allowed                           |
| Account needed                     | none                                   | a Daytona API key                 |

## Get started

`@daytona/sdk` is an optional peer dependency. Install it alongside ADK:

```sh
npm install @google/adk @daytona/sdk
```

Set `DAYTONA_API_KEY` in the environment, or pass `apiKey` in the options.

```ts
import {DaytonaEnvironment} from '@google/adk';

const env = new DaytonaEnvironment({envVars: {DATASET: 'census'}});
await env.initialize();
try {
  await env.writeFile('analyze.py', 'print("hello from the sandbox")');
  const result = await env.execute('python analyze.py');
  // result.exitCode is 0 and result.stdout holds what the script printed.
  const script = await env.readFile('analyze.py');
} finally {
  await env.close();
}
```

## Lifecycle

`initialize()` creates one sandbox. `close()` deletes it. Both are idempotent,
so a second call to either does nothing.

Every other method needs a live sandbox and throws
`Sandbox is not started. Call initialize() first.` without one. That includes
the `workingDir` getter.

Put `close()` in a `finally` block. A sandbox you never close is still cleaned
up, but late: the environment derives Daytona's auto-stop interval from
`timeoutSeconds`, rounded down to whole minutes and never below one, so the
default of 300 seconds stops the sandbox after five idle minutes. Auto-delete
is set to zero minutes, which tells Daytona to delete the sandbox as soon as it
stops.

## Options

```ts
const env = new DaytonaEnvironment({
  image: 'debian:12.9', // omit to let Daytona pick a Python sandbox
  timeoutSeconds: 600, // sandbox lifetime and default command timeout
  apiKey: process.env.MY_KEY, // omit to let the SDK read DAYTONA_API_KEY
  apiUrl: process.env.MY_URL, // omit to use Daytona Cloud
  envVars: {DATASET: 'census'}, // set inside the sandbox
});
```

Every field is optional. `apiKey` and `apiUrl` are handed to the SDK, which
falls back to its own environment variables for whichever one you leave out.

You can also pass a `client` you built yourself. That client belongs to you:
`close()` deletes the sandbox but does not dispose the client, so you can share
one client across several environments.

## Paths

A relative path is resolved against `/workspaces`. An absolute path is used as
given, so it can address the whole sandbox filesystem — this is path
resolution, not containment. `writeFile` creates the parent directories of the
resolved path before it uploads.

`readFile` returns the raw bytes. A file that does not exist produces an error
carrying `code: 'ENOENT'`, which is the same code `LocalEnvironment` surfaces
from `node:fs`.

## Failure modes

- **`@daytona/sdk` is not installed.** The class still imports and constructs;
  `initialize()` rejects with an error naming the package and the install
  command.
- **A command exceeds its timeout.** `execute()` resolves with
  `{exitCode: -1, stdout: '', stderr: '', timedOut: true}`. It does not throw.
- **A command exits non-zero.** `execute()` resolves with that exit code. A
  non-zero exit is a result, not an error.
- **Anything else Daytona rejects** — bad credentials, a sandbox that has been
  deleted, a failed upload — propagates unchanged.
