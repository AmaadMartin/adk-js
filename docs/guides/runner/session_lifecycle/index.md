# Runner entry points and session lifecycle

`Runner` has two entry points. `runAsync` advances the invocation each time you
ask for the next event; `run` keeps the invocation going while you are busy with
the last one. Around both sits one session-resolution step, which either finds
the session, creates it, or explains why it could not.

## Introduction

An invocation needs a session before an agent can run. The runner loads it, and
what happens when it is not there is a policy decision: raising tells a web
front-end that its session id is stale, while creating tells a script that a
first turn should just work. `autoCreateSession` picks between them, and the
default is to raise `SessionNotFoundError`.

A missing session is most often a misconfigured `appName`, because the runner
searches under that name. When a loader recorded where the root agent came from,
the runner compares the two names at construction, warns about a disagreement,
and repeats the explanation inside the session-not-found message. The dev
`AgentLoader` records this for every agent it loads, so an agent in
`agents/weather_agent/` run under `appName: 'weather_bot'` says so.

Choose between the entry points by who is slower. `runAsync` is the default and
the right one when the caller keeps up. Reach for `run` when the caller is the
bottleneck — writing to a slow socket, rendering, awaiting a downstream service
— and you want the agent to finish rather than wait. `run` buffers up to 1000
events and then applies back pressure; it never drops one, and the events and
their order are exactly what `runAsync` produced.

## Get started

```typescript
import {InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  appName: 'weather_bot',
  agent: new LlmAgent({name: 'weather_agent', model: 'gemini-2.5-flash'}),
  autoCreateSession: true,
});

for await (const event of runner.run({
  userId: 'user-1',
  sessionId: 'session-1',
  newMessage: {role: 'user', parts: [{text: 'What is the weather?'}]},
})) {
  await renderSlowly(event); // The agent is not throttled by this.
}
```

## When the session is missing

Without `autoCreateSession` the run rejects before any agent event:

```typescript
import {SessionNotFoundError} from '@google/adk';

try {
  for await (const event of runner.runAsync({
    userId: 'user-1',
    sessionId: 'stale-id',
    newMessage: {role: 'user', parts: [{text: 'hello'}]},
  })) {
    handle(event);
  }
} catch (error) {
  if (error instanceof SessionNotFoundError) {
    startNewConversation();
  }
}
```

The message begins `Session not found: stale-id`. When the runner also found an
app-name disagreement it names both names and the directory the agent came
from, and points at `autoCreateSession`.

## Run-level configuration

Three options apply to a whole invocation rather than to one agent.

```typescript
for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: 'session-1',
  newMessage: {role: 'user', parts: [{text: 'hello'}]},
  yieldUserMessage: true,
  runConfig: {
    customMetadata: {requestId: 'req-1'},
    getSessionConfig: {numRecentEvents: 50},
  },
})) {
  handle(event);
}
```

`yieldUserMessage` makes the persisted user event the first event you receive,
so a transcript can be rendered from the run alone.

`runConfig.customMetadata` is merged onto every event of the run, yielded and
persisted. An event that already carries a key keeps its own value, so an agent
can override a run-level default for that key while the rest still land.

`runConfig.getSessionConfig` is passed straight to
`sessionService.getSession` as `config`, on both the `runAsync` and the
`runLive` path. Use `numRecentEvents` to stop loading the full history of a long
conversation on every turn.

## Failures on the eager path

`run` reports a failure only after it has yielded the events the agent produced
before it. An `Error` the agent threw is re-thrown unchanged. Any other thrown
value becomes an `Error` whose `cause` is the original value, because
re-throwing it would describe the caller's control flow rather than the agent's
failure. A caller that stops iterating early gets no error at all.

## Recording where an agent came from

Tooling that loads agents out of a directory sets `adkOrigin` so the runner can
report a mismatch:

```typescript
agent.adkOrigin = {
  appName: 'weather_agent',
  path: '/workspace/agents/weather_agent',
};
```

An origin app name starting with `__` marks a built-in agent and implies no app
name, so it never produces a warning.
