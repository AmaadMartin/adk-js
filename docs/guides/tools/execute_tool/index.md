# ExecuteTool

`ExecuteTool` gives an agent one tool, `Execute`, that runs a shell command in
a `BaseEnvironment` working directory and reports the exit code, stdout and
stderr. Reach for it when the agent has to run programs, tests or build
commands.

## Introduction

adk-js has the environment abstraction — `BaseEnvironment` and its
`LocalEnvironment` implementation — but nothing on top of it that an agent can
call. `ExecuteTool` is that layer. It declares the command parameter to the
model, runs the command through `BaseEnvironment.execute`, and turns the result
into a small object the model can read.

The tool never reaches a process API itself. It goes through the environment,
so swapping `LocalEnvironment` for a sandboxed or remote environment changes
where the command runs and needs no change to the agent.

Two neighbouring pieces do a different job. A code executor
(`UnsafeLocalCodeExecutor` and friends) runs a code _snippet_ and reports the
files it produced. `ExecuteTool` runs a _shell command_ in a working directory
and reports a process exit status. Use the code executor for "evaluate this
Python", and `ExecuteTool` for "run the test suite".

`LocalEnvironment` runs commands on the host with no sandboxing, so every
`Execute` call pauses for an explicit client confirmation before anything runs.
There is no option to switch that off.

## Get started

```ts
import {ExecuteTool, LlmAgent, LocalEnvironment} from '@google/adk';

const environment = new LocalEnvironment();
await environment.initialize();

export const rootAgent = new LlmAgent({
  name: 'coder',
  model: 'gemini-2.5-flash',
  instruction: 'Run the tests and report what failed.',
  tools: [new ExecuteTool(environment)],
});
```

A runnable version is in `samples/tools/environment_execute/agent.ts`:

```
npm run sample -- samples/tools/environment_execute/agent.ts
```

## Initialize the environment first

`ExecuteTool` never calls `initialize()` or `close()` on the environment. That
is the caller's job, and forgetting it is the first thing most people hit. An
uninitialized `LocalEnvironment` makes the tool return an error rather than
throw:

```ts
{
  status: 'error',
  error: 'Environment is not initialized. Call initialize() first.',
}
```

## The confirmation flow

The first call for a given command does not run it. The tool records a
confirmation request on the tool context and returns an intermediate result:

```ts
{
  partial: 'This tool call needs external confirmation before completion.';
}
```

The request carries the command in both its hint and its payload, so a client
can show the user exactly what would run. Once the client approves and the call
is re-issued, the command runs. If the client refuses:

```ts
{
  status: 'error',
  error: 'Command execution was not confirmed and was rejected.',
  errorCode: ExecuteToolErrorCode.CONFIRMATION_REJECTED,
}
```

## Response shape

The keys are the names the model sees. They stay snake_case to match
adk-python.

| Key         | When it is present                                                             |
| ----------- | ------------------------------------------------------------------------------ |
| `status`    | Always. `'ok'`, or `'error'` for a non-zero exit, a timeout, or a failed call. |
| `stdout`    | The command wrote to stdout.                                                   |
| `stderr`    | The command wrote to stderr.                                                   |
| `exit_code` | The command exited non-zero.                                                   |
| `error`     | The command timed out, the argument was invalid, or the environment threw.     |

A command that succeeds silently returns `{status: 'ok'}` and nothing else. A
non-zero exit code is a result, not an exception, so the output still comes
back with it:

```ts
{status: 'error', stdout: 'partial', exit_code: 2}
```

A command killed by the timeout carries both keys when it also exited
non-zero:

```ts
{status: 'error', exit_code: 137, error: 'Command timed out after 30s.'}
```

The timeout is fixed at 30 seconds, matching adk-python. It is not
configurable.

## Capping the output

Both `stdout` and `stderr` are capped independently at 30000 characters.
Anything longer is cut and given a notice reporting the true length:

```
<first 30000 characters>
... (truncated, 40000 total chars)
```

Pass `maxOutputChars` to change the cap:

```ts
new ExecuteTool(environment, {maxOutputChars: 10_000});
```

Lengths count code points, matching adk-python, so an emoji counts as one and
the cut never splits a surrogate pair.
