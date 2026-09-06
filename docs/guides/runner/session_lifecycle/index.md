# Runner session lifecycle and run-level options

Before an agent can run, `Runner` resolves the session. That one step either
finds the session, creates it, or explains why it could not. A few options then
apply to the whole invocation rather than to one agent.

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

Use `runAsync`. `Runner.run` exists because `google/adk-python` has one, where
it is a synchronous generator that lets a synchronous caller drive the async
runtime. TypeScript has no such divide, so `run` yields exactly what `runAsync`
yields and takes exactly the same options.

## Get started

```typescript
import {InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  appName: 'weather_bot',
  agent: new LlmAgent({name: 'weather_agent', model: 'gemini-2.5-flash'}),
  autoCreateSession: true,
});

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: 'session-1',
  newMessage: {role: 'user', parts: [{text: 'What is the weather?'}]},
})) {
  render(event);
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
