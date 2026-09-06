# Node results: output, route, state and artifacts

A workflow node reports what it produced in two ways: it yields events, or it
writes to its context. Both reach the session, because ADK emits an event for
whatever the node left on its context when it finishes. Reach for the context
form when the result is easier to assign than to yield — a node that builds a
value in a loop, or one that writes session state after its last event.

## Introduction

A node's result is not a return value. The engine reads four things off the
node context:

| Field                       | What it means                                                  |
| --------------------------- | -------------------------------------------------------------- |
| `ctx.output`                | The value the next node along the edge receives.               |
| `ctx.route`                 | The route key(s) the graph matches against outgoing edges.     |
| `ctx.state`                 | Session state writes, accumulated in `ctx.actions.stateDelta`. |
| `ctx.actions.artifactDelta` | Artifact versions this node saved.                             |

Yielding a value sets `ctx.output` for you, and that event carries the value
into the session. A node that assigns `ctx.output` yields nothing, so ADK emits
one event at the end of the run for the output, the route and any delta still
pending. Without that event the value would live only in memory: the next node
would receive it in this turn, but a resumed run reads the session, and would
re-run a node that had already produced its result.

The end-of-run event appears only when something is still pending. A node that
yielded its output normally, and left no unflushed writes, produces no extra
event.

## Get started

```ts
import {node, NodeContext, Workflow} from '@google/adk';

const summarize = node(
  (ctx: NodeContext, text: string) => {
    ctx.state.set('length', text.length);
    // Assigned, not returned: ADK emits the event that carries it out.
    ctx.output = text.slice(0, 40);
  },
  {name: 'summarize'},
);

const workflow = new Workflow({
  name: 'summarizer',
  edges: [['START', summarize]],
});
```

The run emits two events, both authored `summarize`: the state delta
`{length: …}`, then the output. They arrive separately because `node(fn)`
builds a `FunctionNode`, which attaches its own state writes as it ends; a node
that subclasses `BaseNode` directly leaves both to the end-of-run event, which
then carries them together.

## Routing without an output

`ctx.route` follows the same rule — assign it and the graph still sees it:

```ts
const triage = node(
  (ctx: NodeContext, ticket: {urgent: boolean}) => {
    ctx.route = ticket.urgent ? 'now' : 'later';
  },
  {name: 'triage'},
);

const workflow = new Workflow({
  name: 'triage',
  edges: [
    ['START', triage],
    [triage, {now: escalate, later: enqueue}],
  ],
});
```

## What rides which event

- A **partial** event carries no delta. The writes roll forward and ride the
  next complete event, so a streaming fragment is never a state commit.
- A delta the node put on an event it yielded **wins** over the same key
  pending on the context.
- Each **failed attempt** of a node with a `retryConfig` emits its own error
  event, and that attempt's state and artifact writes are discarded before the
  retry.
- An output your node **delegated** to a child (`ctx.runNode(child, input,
{useAsOutput: true})`) is not emitted twice: the child already announced it.
