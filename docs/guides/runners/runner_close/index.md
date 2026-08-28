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
one-shot script needs nothing extra. A live session started with `runLive` does
not, so its toolsets stay open when the run ends.

`Runner.close()` closes every toolset reachable from the agent tree. It never
rejects, and it is safe to call more than once.

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
- A toolset that fails to close does not stop the remaining toolsets closing,
  and it does not make `close()` reject.
- A runner whose root is a bare workflow node owns no toolsets, so `close()`
  resolves without doing anything.
- Calling it twice closes the toolsets twice. Toolset `close()` is expected to
  be idempotent, so this is safe.

## Differences from adk-python

`close_runners` in adk-python cancels the tasks that overran the deadline. There
is no equivalent in JavaScript: a promise cannot be cancelled, so the dev server
abandons the stragglers and returns. The runner keeps closing in the background
until the process exits.

adk-python's `Runner.close()` also closes the plugin manager and flushes the
session service. adk-js has neither a plugin close hook nor a session flush, so
the toolsets are the whole of `close()` here.
