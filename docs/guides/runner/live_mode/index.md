# Live mode

`Runner.runLive` drives a bidirectional streaming run: the caller feeds a
`LiveRequestQueue` while the runner yields events. Reach for it when the input
arrives over time — microphone audio, video frames, or text typed a turn at a
time — rather than as one complete message.

## Introduction

`runAsync` takes one `newMessage` and runs to a final response. Live mode has no
single message. The caller pushes onto a `LiveRequestQueue` for as long as the
conversation lasts, and the runner streams events back the whole time.

Two kinds of root can run live:

- A `BaseAgent`, usually an `LlmAgent` on a live model, which holds an open
  connection and answers as the input arrives.
- A `Workflow`, which the runner drives as a node. The graph runs exactly as it
  does under `runAsync`; what live mode adds is the `LiveRequestQueue` on the
  invocation context, for the nodes that read it.

Both produce the same thing: an `AsyncGenerator<Event>`, with non-partial events
appended to the session as they are produced.

Live mode is **experimental** and its API may change.

## Get started

A `Workflow` root, run live:

```ts
import {
  Event,
  InMemorySessionService,
  LiveRequestQueue,
  node,
  Runner,
  Workflow,
} from '@google/adk';

const sessionService = new InMemorySessionService();
const session = await sessionService.createSession({
  appName: 'app',
  userId: 'user',
});

const workflow = new Workflow({
  name: 'review',
  edges: [['START', node(() => 'reviewed', {name: 'review'})]],
});

const runner = new Runner({appName: 'app', agent: workflow, sessionService});
const liveRequestQueue = new LiveRequestQueue();

const events: Event[] = [];
for await (const event of runner.runLive({
  userId: 'user',
  sessionId: session.id,
  liveRequestQueue,
})) {
  events.push(event);
}
```

`liveRequestQueue` is required. Omitting it throws
`liveRequestQueue is required for runLive.` for every kind of root.

A live run starts the root node with **no input**, matching adk-python's
`run_node_live`. There is no `newMessage` to derive one from. Input arrives on
the queue, which a node reads through
`ctx.invocationContext.liveRequestQueue`.

## Events from underneath the root

Code that runs _beneath_ the root cannot yield an event through the root's own
stream. A `NodeTool` running a sub-workflow, for example, is called by the model
and returns a value; its intermediate and interrupt events have nowhere to go.

Those producers push onto `InvocationContext.eventQueue` instead. `runLive`
creates that queue for the whole run and merges it with the root's own stream,
so a tool's events reach the caller in the order they are produced:

```ts
import {BaseLlm, LlmAgent, NodeTool, Workflow} from '@google/adk';

// Any model whose `connect()` opens a live session.
declare const liveModel: BaseLlm;
// The wrapped node must declare an `inputSchema`; NodeTool derives the tool's
// parameter schema from it.
declare const reviewWorkflow: Workflow;

export const host = new LlmAgent({
  name: 'host',
  model: liveModel,
  tools: [new NodeTool(reviewWorkflow)],
});
```

The queue is inherited by every child invocation context, so a tool several
agents deep reaches the queue the run was started with. It is cleared from the
context when the run finishes, on the failure path as well as the normal one.

Queued events are treated exactly like the root's own: the `onEvent` plugin
callback runs on them, and a non-partial one is appended to the session before
it is yielded.

## Stopping a run

Three things can end a live run, and each is accounted for:

- **The root finishes.** The event queue is closed, whatever is left in it
  drains, and the generator ends.
- **The caller stops reading** — a `break` out of the `for await`. The runner
  asks the root to stop, and nothing is thrown.
- **The root fails.** The events it already produced are delivered first, then
  the failure is thrown to the caller.

`runLive` returns to you straight away in every case. When the root is torn down
does depend on which event you stopped on. Stopping after an event the root
produced tears it down before `runLive` returns. Stopping after an event that
came from the event queue cannot: the root is mid-step, since that step is what
the code producing the queued event runs inside. The stop then takes effect when
the root next produces.

One consequence is worth knowing. A live agent root sitting in
`connection.receive()` on a model that has gone quiet does not produce again, so
its connection stays open until the model or the transport closes it. An
`abortSignal` does not shorten that wait — the live flow reads the signal when a
response arrives — but pass one anyway, because it stops every step that does
get to run:

```ts
const controller = new AbortController();
for await (const event of runner.runLive({
  userId: 'user',
  sessionId: session.id,
  liveRequestQueue,
  abortSignal: controller.signal,
})) {
  if (done(event)) controller.abort();
}
```

## What is not persisted

Model media events carrying raw inline bytes — audio, video, or image
`inlineData` — are yielded but not appended to the session, so large blobs stay
out of the conversation history. Media referenced by `fileData`, transcriptions,
tool calls and usage events are persisted as they are under `runAsync`. Partial
events are never persisted.
