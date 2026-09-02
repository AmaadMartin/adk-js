# Starting a run

Every run needs a session to append its events to. The `Runner` finds that
session or creates it, and explains itself when it cannot. Reach for this page
when a run reports a session you believe exists, or when you are deciding how to
give the runner its root.

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

## Choosing the root

A runner takes exactly one root, and names the ones it was given when it gets
more than one:

- `app` — an `App`, which carries the root agent, the plugins and the
  resumability config. This is the recommended form.
- `agent` — a bare agent, or a graph node. Pass `appName` with an agent; without
  one the runner has no app name to look sessions up under, and says so at the
  first lookup. A node names the app after itself when you pass no `appName`.

`plugins` belongs to the `App`. Passing it alongside `app` is refused. Passing
it alongside `agent` still works and is deprecated.

## Agent transfer and prompt caching

A runner whose agent tree can transfer warns once per app name per process. Each
transfer swaps the system instruction and the tool set, so the request prefix
changes and the whole prompt is re-sent uncached after every transfer. The
warning is informational: adk-js has no context cache configuration yet.

## Failure modes

| What you did                                         | What you get                                            |
| ---------------------------------------------------- | ------------------------------------------------------- |
| Ran against a session that does not exist            | `SessionNotFoundError: Session not found: <id>`         |
| The same, with an app name the loader disagrees with | The above, plus the directory the agent was loaded from |
| Ran with `agent` and no `appName`                    | `Session lookup failed: appName must be provided…`      |
| Passed both `app` and `agent`                        | `Only one of app or agent may be provided, but got: …`  |
| Passed neither                                       | `One of app or agent must be provided. Got none.`       |
| Passed `plugins` alongside `app`                     | `When app is provided, plugins should not be provided…` |
