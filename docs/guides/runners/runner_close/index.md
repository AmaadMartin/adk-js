# Closing a runner

`Runner.close()` releases what a runner holds open. Reach for it when a runner
outlives one request — a long-lived server, a worker, or a test that builds a
runner in `beforeEach` — and the agent tree carries toolsets that own a
subprocess or a socket.

## Introduction

A runner is cheap to create but it is not free to keep. Its agent tree can carry
toolsets, and a toolset such as an MCP toolset owns a child process and a
transport. Nothing releases those when the last reference to the runner goes
away, because a garbage collector does not run `close()` for you.

`runAsync` already closes the toolsets at the end of each invocation, so a
one-shot script needs nothing extra. Two cases are not covered by that. A live
session started with `runLive` does not close its toolsets when the run ends.
And plugins are never closed per invocation, so a runner that is dropped without
`close()` leaks whatever its plugins hold.

`Runner.close()` covers both. It closes every toolset reachable from the agent
tree, then closes every registered plugin. It is safe to call more than once:
the second call returns without doing anything.

The dev API server does this for you. `AdkApiServer` caches one runner per app,
and `stop()` closes every cached runner before it returns. Teardown is
best-effort and bounded: the runners close concurrently, a runner that fails to
close does not stop the others, and the server gives up after 30 seconds rather
than letting a wedged tool server hold up shutdown. `stop()` also empties the
cache, so a server that starts again builds a fresh runner instead of handing
out a closed one.

## Get started

Close the runner from a `finally`, so an error on the run path still releases
the toolsets.

```ts
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';

const sessionService = new InMemorySessionService();
const session = await sessionService.createSession({
  appName: 'weather_app',
  userId: 'user1',
});
const runner = new Runner({
  appName: 'weather_app',
  agent: new LlmAgent({name: 'weather_agent', model: 'gemini-2.5-flash'}),
  sessionService,
});

try {
  for await (const event of runner.runAsync({
    userId: 'user1',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'What is the weather?'}]},
  })) {
    console.log(event.content);
  }
} finally {
  await runner.close();
}
```

## What close() guarantees

- Every toolset in the agent tree is closed. Each agent is visited once, so a
  toolset shared by two agents closes once per call.
- A toolset that fails to close is logged, and the remaining toolsets still
  close.
- Plugins close after the toolsets. A plugin that throws does not stop the other
  plugins, and `close()` then raises an `AggregateError` naming every plugin
  that failed.
- A second call is a no-op.

## Differences from adk-python

`close_runners` in adk-python cancels the tasks that overran the deadline. There
is no equivalent in JavaScript: a promise cannot be cancelled, so the dev server
abandons the stragglers and returns. The runner keeps closing in the background
until the process exits.

adk-python's `Runner.close()` also flushes the session service. adk-js has no
flush hook on `BaseSessionService`, so `close()` does not do it.
