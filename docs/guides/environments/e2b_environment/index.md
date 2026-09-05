# E2BEnvironment

`E2BEnvironment` is a `BaseEnvironment` backed by a remote [E2B](https://e2b.dev)
sandbox. It gives an agent a persistent workspace it can write files into, run
shell commands in, and install software into, without running any of that on
the host.

## Introduction

`LocalEnvironment` runs the command string on the machine hosting the agent. It
says so plainly in its own documentation: there is no sandboxing, the child
inherits the whole of `process.env`, and its path check is a lexical one. That
is fine when the command comes from you. It is not fine when the command comes
from a model.

`E2BEnvironment` moves the work to a remote sandbox, so the isolation boundary
is a real one. A command reads and writes the sandbox's filesystem, not yours,
and `pip install` or `apt install` changes the sandbox rather than your machine.
The two classes implement the same interface, so code written against
`BaseEnvironment` works with either.

The trade is cost and lifetime. A sandbox consumes E2B credits while it lives,
so it carries a time-to-live: `timeoutSeconds`, 300 by default. Every operation
resets that clock, so a workspace in active use never expires under you. A
workspace left idle past the TTL does expire, and the next operation logs a
warning and creates a fresh sandbox — installed packages and files are gone.
Treat the workspace as durable within one task, not across tasks.

## Get started

`e2b` is an optional peer dependency, so install it alongside ADK:

```bash
npm install e2b
```

The sandbox needs an API key. `E2BEnvironment` reads `apiKey` if you pass one,
and otherwise the SDK falls back to the `E2B_API_KEY` environment variable.

```ts
import {E2BEnvironment} from '@google/adk';

async function runScript(source: string): Promise<string> {
  const env = new E2BEnvironment({timeoutSeconds: 300});
  await env.initialize();
  try {
    await env.writeFile('script.py', source);
    const result = await env.execute('python script.py');
    return result.stdout;
  } finally {
    await env.close();
  }
}
```

`initialize()` creates the sandbox and `close()` kills it. Both are idempotent,
so the `finally` above is safe even if `initialize()` never ran. Every other
method throws until `initialize()` has been called.

## Paths

The working directory is `/home/user`, the sandbox user's home. A relative path
resolves against it, and an absolute path is used as given:

```ts
await env.readFile('notes.txt'); // /home/user/notes.txt
await env.readFile('/etc/hostname'); // /etc/hostname, inside the sandbox
```

Unlike `LocalEnvironment`, there is no check confining a path to the working
directory, and none is needed. `/etc/hostname` reads the sandbox's file. The
sandbox is the boundary, so a path cannot escape to the host.

## Exit codes, timeouts and missing files

A non-zero exit code is a result, not an error. The command below returns
`{exitCode: 3, stdout: '', stderr: '', timedOut: false}` and throws nothing:

```ts
const result = await env.execute('exit 3');
```

A command that exceeds its timeout returns
`{exitCode: -1, stdout: '', stderr: '', timedOut: true}`.

The second argument to `execute()` is that timeout, in seconds:

```ts
await env.execute('sleep 30', 5); // gives up after 5 seconds
```

Omit it and the command is bounded by the sandbox TTL instead. The e2b SDK caps
a command at 60 seconds when the option is absent, which would be a limit the
`BaseEnvironment` contract says is not there, so `E2BEnvironment` passes the TTL
explicitly. The sandbox dies at that point and takes the command with it, so it
is the real ceiling either way.

Reading a file that does not exist throws an `Error` whose `code` is `'ENOENT'`,
matching what `LocalEnvironment` propagates from `node:fs`:

```ts
try {
  await env.readFile('missing.txt');
} catch (error: unknown) {
  // message: ENOENT: no such file or directory, open '/home/user/missing.txt'
}
```

Any other error from the E2B SDK propagates unchanged.

## Configuration

| Option           | Default       | Meaning                                                                   |
| ---------------- | ------------- | ------------------------------------------------------------------------- |
| `image`          | `'base'`      | E2B template name or ID. `base` is public and available to every account. |
| `timeoutSeconds` | `300`         | Sandbox time-to-live. Reset by every operation.                           |
| `apiKey`         | `E2B_API_KEY` | E2B API key.                                                              |
| `envVars`        | none          | Environment variables set inside the sandbox.                             |
