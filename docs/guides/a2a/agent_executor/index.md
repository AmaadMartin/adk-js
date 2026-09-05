# A2AAgentExecutor

Runs an ADK agent behind an Agent2Agent (A2A) server. The executor takes an A2A
request, drives the ADK `Runner`, and republishes the run as A2A task events.
Reach for it when you serve an ADK agent to A2A clients and need to control how
the run is translated onto the wire.

## Introduction

An A2A server speaks in tasks. A client sends a message, and the server reports
progress as a `Task`, then a stream of status and artifact updates, then one
terminal status. An ADK run speaks in `Event`s instead: a model turn, a tool
call, a partial chunk. `A2AAgentExecutor` is the adapter between the two.

One execution publishes, in order:

1. a `Task` in the `submitted` state, unless the request already carries a task,
2. a `working` status update,
3. one artifact update per ADK event that produces parts,
4. exactly one terminal status update: `completed`, `failed`, or
   `input-required`.

The terminal state follows three rules. An ADK event carrying an error makes the
task `failed`, and the **last** such event decides the message. A run that left
a long-running function call unanswered makes the task `input-required`, which
is how a human-in-the-loop pause reaches the client. Everything else is
`completed`.

Every published event carries metadata naming the app, the user and the session,
plus the ADK integration extension flag. A peer reads the flag to tell which ADK
A2A integration served the request. Artifact updates and the terminal event also
keep their own per-event keys, such as the invocation id and the author.

Most deployments do not construct the executor directly: `toA2a` builds one and
mounts it on an Express app. Construct it yourself when you host the A2A server
and want to supply your own runner or converter.

## Get started

Build a `Runner` for your agent and hand it to the executor. The A2A server
calls `execute` with its request context and event bus.

```typescript
import {
  A2AAgentExecutor,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';

const runner = new Runner({
  appName: 'weather_app',
  agent: new LlmAgent({
    name: 'weather_agent',
    model: 'gemini-2.5-flash',
    instruction: 'Answer weather questions.',
  }),
  sessionService: new InMemorySessionService(),
});

const executor = new A2AAgentExecutor({runner});
```

The `runner` option also accepts a `RunnerConfig`, or a factory returning
either. A factory runs once per request, so it can build the runner lazily:

```typescript
const executor = new A2AAgentExecutor({
  runner: async () => buildRunnerFromEnvironment(),
});
```

If the factory returns something that is not a runner — `undefined` from an
unset environment variable, for example — `execute` rejects with a `TypeError`
naming the type it got. The error reports the type only, never the value.

## Sessions

The executor derives both identifiers from the A2A context id: the session id is
the context id, and the user id is `A2A_USER_` followed by it. It looks the
session up on the runner's session service and creates it when it is missing.

The lookup asks for the session's full event history. Those events decide
whether a human-in-the-loop request raised by an earlier turn is still
unanswered. When one is, the executor publishes an `input-required` status
update and does not run the agent, so a client cannot talk past an open gate by
starting a new task in the same context.

## Converting parts

`genAiPartConverter` replaces the default conversion of one GenAI part into one
A2A part:

```typescript
import {A2AAgentExecutor, toA2APart} from '@google/adk';

const executor = new A2AAgentExecutor({
  runner,
  genAiPartConverter: (part, longRunningToolIds) =>
    part.thought ? undefined : toA2APart(part, longRunningToolIds),
});
```

A converter that returns `undefined` drops the part. An artifact update left
with no parts is not published at all. A long-running function call whose parts
all convert to nothing is an error, because the client would otherwise be told
the task completed while the agent waits for an answer: the executor throws, and
the run is reported as `failed`.

## Callbacks

Three optional callbacks observe the execution. `beforeExecuteCallback` runs
before anything is published. `afterEventCallback` runs for each artifact update,
before it reaches the bus. `afterExecuteCallback` runs once with the terminal
event, exactly as it will be published, and with the error when the run failed.
An exception thrown by `afterExecuteCallback` is logged and does not change the
event.

## Cancellation

`cancelTask` throws. A client that cancels an in-flight task gets an error, not
a `canceled` task event.
