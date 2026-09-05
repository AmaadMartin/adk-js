# Resumable workflow checkpoints

A `Workflow` on a resumable app records how far its graph got. It writes a
checkpoint event each time a node starts and each time a node finishes, then an
end-of-agent marker once the graph completes. Reach for this when something
outside the process has to read a workflow's progress: a dashboard, a resume
driven by another runtime, or an operator asking why a run stopped.

## Introduction

A workflow already resumes without any of this. It rebuilds what ran by
replaying the session's own events, so a completed node is not run twice. The
checkpoints solve a different problem: they state the progress explicitly
instead of leaving a reader to derive it.

That matters in two places. A session adk-js writes stays resumable by
adk-python, because the checkpoint payload is the one adk-python's `Workflow`
persists. And a consumer reading the event stream can tell a paused workflow
from a finished one without replaying the graph itself.

Nothing changes for an app that is not resumable. Every checkpoint path checks
`isResumable` first, so a plain session carries the same events it always did.

## Get started

Set `resumabilityConfig` on the runner or the app, and run the workflow as
usual.

```ts
import {InMemorySessionService, node, Runner, Workflow} from '@google/adk';

const first = node((_ctx, input: string) => `first(${input})`, {name: 'first'});
const second = node((_ctx, input: string) => `second(${input})`, {
  name: 'second',
});

const workflow = new Workflow({
  name: 'resumable_wf',
  edges: [['START', first, second]],
});

const sessionService = new InMemorySessionService();
const session = await sessionService.createSession({
  appName: 'app',
  userId: 'u1',
});
const runner = new Runner({
  appName: 'app',
  agent: workflow,
  sessionService,
  resumabilityConfig: {isResumable: true},
});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'x'}]},
})) {
  if (event.actions?.agentState) {
    // {nodes: {first: {status: 2, interrupts: []}}}, and so on.
  }
}
```

## What the checkpoint holds

Each checkpoint carries the whole node map, not a delta:

```json
{
  "nodes": {
    "first": {"status": 3, "interrupts": []},
    "gate": {"status": 4, "interrupts": ["approve-1"]}
  }
}
```

`status` is the numeric `NodeStatus` wire value — `2` is `RUNNING`, `3` is
`COMPLETED`, `4` is `WAITING`. `interrupts` lists the interrupt ids a waiting
node is blocked on.

The payload deliberately omits the node's resume inputs. For a node behind an
auth gate those hold the credential the user sent, and a resume rebuilds them
from the function responses already in the session.

The key `nodes` does not collide with the `{input}` stash the node runner
writes on an interrupt event. Both may appear on one stream.

## When each event is written

| Moment                                            | Event                                         |
| ------------------------------------------------- | --------------------------------------------- |
| A node is scheduled and genuinely runs            | `actions.agentState`                          |
| A node completes, interrupts, or waits for output | `actions.agentState`                          |
| A node is fast-forwarded from history             | its recovered `output`, under `nodeInfo.path` |
| The graph finishes with no pending interrupt      | `actions.endOfAgent`                          |

A node fast-forwarded on resume did not run, so it does not announce itself
with a fresh checkpoint. It re-emits the output it produced originally instead,
which keeps the stream complete for a reader that only sees this turn.

The end-of-agent marker is withheld while any interrupt is pending. A workflow
paused for human input has not finished, and the absence of the marker is how a
reader tells the two apart.
