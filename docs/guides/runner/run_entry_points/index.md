# Choosing a Runner entry point

`Runner.run` and `Runner.runAsync` both drive one invocation and yield its
events. They differ in who sets the pace. Reach for `run` when the code reading
the events is slow and you do not want it to slow the agent down.

## Introduction

`runAsync` is demand-driven. The agent advances only when the caller asks for
the next event, so a caller that renders each event, writes it to a database,
or waits on a user paces the whole invocation. That is usually what you want in
a server: the work stops when nobody is reading it.

`run` is the opposite. Iterating it starts the invocation, and the invocation
keeps going while the caller is busy. The events wait in a buffer until the
caller collects them. This is the entry point for a script or a test, where the
agent should finish as fast as it can and the reader is incidental.

`adk-python` draws the same line, and names the two methods the same way. Its
`run` is a _synchronous_ generator, backed by a background thread. ADK for
TypeScript cannot offer that: JavaScript has no way to block the calling thread
for asynchronous work, and the `core` package ships a browser bundle, so worker
threads are not available to it. `run` is therefore an async generator like
`runAsync`, and it is the eagerness, not the synchronicity, that is ported.

Neither method changes what the agent does. The session, the plugins, the run
config and the events are the same.

## Get started

```typescript
import {InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  agent: new LlmAgent({
    name: 'assistant',
    model: 'gemini-2.0-flash',
    instruction: 'Answer the user.',
  }),
  appName: 'assistant_app',
});

const session = await runner.sessionService.createSession({
  appName: 'assistant_app',
  userId: 'u1',
});

const transcript: string[] = [];
for await (const event of runner.run({
  userId: 'u1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Summarize the news.'}]},
})) {
  // The agent runs ahead while this body is busy.
  transcript.push(event.content?.parts?.[0]?.text ?? '');
}
```

## What it guarantees

- **Order is preserved.** Events arrive in the order the agent produced them,
  with no duplicates and no drops.
- **The buffer is bounded.** At most 1000 events are held. On reaching the cap
  the invocation waits for the caller to catch up, so a caller that stops
  reading cannot grow the buffer without bound.
- **A failure arrives after the events that preceded it.** The events the agent
  produced before it failed are handed over first, and the error is thrown
  after them.
- **Stopping early raises nothing.** Break out of the `for await` and the
  invocation is closed. No error surfaces, and the agent does not run on in the
  background.

## Failure modes

An agent that throws an `Error` reports that same `Error` to the caller. An
agent that terminates with something that is not an `Error` — a cancellation
token, a bare string — reports an `Error` whose `cause` is the thrown value,
so a caller cannot mistake it for its own control flow.

## A related diagnostic

An app whose agents can transfer between each other, and which sets no
`App.contextCacheConfig`, logs one warning when the first `Runner` is built for
it. Every transfer swaps the system instruction and the tool set, so the
request prefix changes and the whole prompt is re-sent uncached. The warning
fires once per app name. Set `contextCacheConfig` on the `App` to give each
agent its own cache, or ignore the warning if the app is small enough that the
re-sends do not matter.
