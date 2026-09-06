# Session resolution

A `Runner` resolves the session id you hand it before the agent runs. A session id that does not exist is an error by default, and `autoCreateSession` opts in to creating it. Reach for the option when your code owns the session id and means the runner to create the session.

## Introduction

A session id normally comes from somewhere: your database, a URL, a client. If the runner quietly created a session for an id it could not find, then a typo, a stale id, or the wrong app name would start an empty conversation instead of continuing the intended one. The user sees an agent that forgot everything, and nothing in the logs says why.

So the runner reports the missing session as a `SessionNotFoundError`. Some callers do own the id, though. A batch job keyed by order number, or a chat client that mints its own conversation id, wants the first message to create the session. `autoCreateSession: true` is for them; the runner then creates the session under the id you supplied.

Both `runAsync` and `runLive` resolve the session the same way. `runEphemeral` is different: it creates and deletes its own session, and the option does not apply to it.

## Get started

```typescript
import {
  InMemorySessionService,
  LlmAgent,
  Runner,
  SessionNotFoundError,
} from '@google/adk';

const runner = new Runner({
  appName: 'my_app',
  agent: new LlmAgent({name: 'root', model: 'gemini-2.5-flash'}),
  sessionService: new InMemorySessionService(),
});

try {
  for await (const event of runner.runAsync({
    userId: 'user1',
    sessionId: 'typo',
    newMessage: {role: 'user', parts: [{text: 'Hello'}]},
  })) {
    // Handle the event.
  }
} catch (error: unknown) {
  if (error instanceof SessionNotFoundError) {
    // error.message: Session not found: typo
  }
}
```

To create the session instead, set the option:

```typescript
const runner = new Runner({
  appName: 'my_app',
  agent,
  sessionService,
  autoCreateSession: true,
});
```

## When the app name does not match

The app name scopes the lookup, so a runner configured with the wrong one finds no session even when the id is right. This is the usual cause, and it is hard to see, because the id in the error looks correct.

The dev `AgentLoader` records the directory it loaded each agent from. When that directory implies a different app name, the runner warns at construction and adds both names to the error:

```
Session not found: abc123. The runner is configured with app name "my_app",
but the root agent was loaded from "/agents/weather_bot", which implies app
name "weather_bot". Ensure the runner appName matches that directory or pass
appName explicitly when constructing the runner. The mismatch prevents the
runner from locating the session. To automatically create a session when
missing, set autoCreateSession: true when constructing the runner.
```

An agent you construct yourself carries no origin, so the hint never fires for it and the message stays `Session not found: <id>`. To supply an origin from your own loader, call `setAgentOrigin`:

```typescript
import {setAgentOrigin} from '@google/adk';

setAgentOrigin(agent, {appName: 'weather_bot', dir: '/agents/weather_bot'});
```

## Guarantees

- A missing session throws `SessionNotFoundError`, which extends `Error` and keeps the `Session not found: <id>` prefix.
- A runner constructed without an app name reports that instead, and creates no session under an undefined app name.
- An existing session is never re-created, whether the option is set or not.
