# Starting a run

Every run needs a session to append its events to, and a way to hand those
events back to you. The `Runner` finds or creates the session, explains itself
when it cannot, and offers two entry points for the event stream. Reach for this
page when a run reports a session you believe exists, or when a slow consumer is
holding the agent back.

## Introduction

A runner reads and writes sessions under one app name. `runAsync` looks the
session up by `appName`, `userId` and `sessionId`. If it is not there, the run
stops: starting an empty conversation under an id the caller believes already
exists loses the history silently, which is worse than an error.

Two things follow. A caller that owns the session id and expects the first turn
to create it sets `autoCreateSession: true`. And a failed lookup raises
`SessionNotFoundError`, not a plain `Error`, so the caller can tell a missing
session apart from any other failure.

The usual cause of a session that exists but cannot be found is an app name that
disagrees with the one the session was written under. The `dev` loader names an
app after the directory it read the agent from, and records that directory. A
runner built with a different `appName` reads somewhere else. The runner
compares the two at construction, warns about the difference, and repeats it in
the lookup error, because the error on its own reads like a missing session.

The two entry points differ only in who sets the pace. `runAsync` produces an
event when you pull one, so the invocation runs at the speed of the loop that
drains it. `run` starts the invocation immediately and buffers, so the agent
keeps working while you are busy with the event you already have.

## Get started

Create the session on first use:

```ts
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';

const runner = new Runner({
  appName: 'booking',
  agent: new LlmAgent({name: 'booking_agent', model: 'gemini-2.0-flash'}),
  sessionService: new InMemorySessionService(),
  autoCreateSession: true,
});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: 's1',
  newMessage: {role: 'user', parts: [{text: 'book me a table'}]},
})) {
  // 's1' was created by this call.
}
```

Handle the missing session yourself instead:

```ts
import {SessionNotFoundError} from '@google/adk';

try {
  for await (const event of runner.runAsync({
    userId: 'u1',
    sessionId: 's1',
    newMessage: {role: 'user', parts: [{text: 'book me a table'}]},
  })) {
    // The session existed.
  }
} catch (error) {
  if (error instanceof SessionNotFoundError) {
    // Offer the user their existing conversations, or create one by name.
  }
}
```

## Letting the agent run ahead

Use `run` when the work you do per event is slow enough to hold the agent back:

```ts
for await (const event of runner.run({
  userId: 'u1',
  sessionId: 's1',
  newMessage: {role: 'user', parts: [{text: 'summarise the quarter'}]},
})) {
  await renderToBrowser(event); // The agent keeps going while this awaits.
}
```

`run` yields the same events as `runAsync`, in the same order, and reports a
failure only after the events produced before it. Two things to know:

- It is still asynchronous. adk-python's `run` is a synchronous generator fed by
  a background thread. JavaScript has no synchronous generator that can await,
  so this port carries over the decoupling and not the synchronous signature.
- Leaving the loop early does not stop the invocation. It runs to completion in
  the background and its remaining events are dropped. Pass an `abortSignal` to
  `runAsync` when you need the run itself to stop.

## Choosing the root

A runner takes exactly one root, and names the ones it was given when it gets
more than one:

- `app` — an `App`, which carries the root agent, the plugins and the
  resumability config. This is the recommended form.
- `agent` — a bare agent. Pass `appName` with it; without one the runner has no
  app name to look sessions up under, and says so at the first lookup.
- `node` — a graph root. It names the app after itself when you pass no
  `appName`.

`plugins` belongs to the `App`. Passing it alongside `app` is refused. Passing
it alongside `agent` still works and is deprecated.

## Agent transfer and prompt caching

A runner whose agent tree can transfer warns once per app name per process. Each
transfer swaps the system instruction and the tool set, so the request prefix
changes and the whole prompt is re-sent uncached after every transfer. The
warning is informational: adk-js has no context cache configuration yet.

## Failure modes

| What you did                                         | What you get                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| Ran against a session that does not exist            | `SessionNotFoundError: Session not found: <id>`               |
| The same, with an app name the loader disagrees with | The above, plus the directory the agent was loaded from       |
| Ran with `agent` and no `appName`                    | `Session lookup failed: appName must be provided…`            |
| Passed more than one of `app`, `agent` and `node`    | `Only one of app, agent, or node may be provided, but got: …` |
| Passed none of them                                  | `One of app, agent, or node must be provided. Got none.`      |
| Passed `plugins` alongside `app`                     | `When app is provided, plugins should not be provided…`       |
