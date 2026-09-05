# Task node conversation isolation

A `task`-mode `LlmAgent` used as a workflow node runs under an isolation scope
of its own. Its turns stay out of every peer node's view, and a node the graph
triggers again starts a fresh conversation. Reach for this when a graph holds a
multi-turn conversation at one node and the rest of the graph must not read it.

## Introduction

A `task`-mode agent talks to the user until it calls `finish_task`. That takes
several turns, and those turns land in the same session every other node reads.
Without a scope the graph leaks in both directions. A peer node sees a
half-finished interview as if it were the workflow's own conversation. A node
the graph routes back to sees its previous attempt and carries on instead of
starting over.

An isolation scope tags the events a node writes and filters the events it
reads. A scoped agent sees the unscoped history plus its own turns, and nothing
a sibling wrote. Unscoped nodes are unaffected: they keep seeing the shared
history, which still holds the user's messages and the output of every node.

The scope is the node's full path and first run, `<path>@<runId>` — for example
`intake_flow.intake@1`. The path is included so two nested workflows that reuse
a node name do not share a scope. The node then keeps that scope for every later
activation, because an event is readable only inside the scope it was written
under: a node that took a new scope on re-trigger would read none of its own
turns.

Only `task`-mode agent nodes get a scope automatically. A node that declares its
own `isolationScope` keeps the one it declared.

## Get started

Mark the agent `mode: 'task'` and use it as a graph node. Nothing else is
needed.

```ts
import {LlmAgent, node, Workflow} from '@google/adk';
import {Type} from '@google/genai';

const intake = new LlmAgent({
  name: 'intake',
  model: 'gemini-2.5-flash',
  mode: 'task',
  instruction: 'Collect the name, then finish your task.',
  outputSchema: {
    type: Type.OBJECT,
    properties: {name: {type: Type.STRING}},
  },
});

const greet = node(
  (_ctx, identity: {name: string}) => `Hello ${identity.name}`,
  {
    name: 'greet',
  },
);

export const rootAgent = new Workflow({
  name: 'intake_flow',
  edges: [['START', intake, greet]],
});
```

`intake` writes its turns under `intake_flow.intake@1`. `greet` is unscoped, so
it never reads them; it receives the agent's output as its input.

## Keeping a scope of your own

Declare `isolationScope` on the node to override the default. Give two task
nodes the same tag and they share one conversation view.

```ts
const intake = new LlmAgent({
  name: 'intake',
  model: 'gemini-2.5-flash',
  mode: 'task',
  isolationScope: 'shared-thread',
});
```

## Retries

A graph that routes back to a task node runs it again under the scope it already
has, so the second attempt reads the first. It also sees the unscoped history,
which includes whatever the routing node said about the failure.

```ts
import {createEvent, DEFAULT_ROUTE, node, Workflow} from '@google/adk';

const check = node(
  (_ctx, identity: {name: string}) =>
    identity.name === 'Jane Doe'
      ? `Hello ${identity.name}`
      : createEvent({
          route: 'retry',
          content: {
            role: 'user',
            parts: [{text: `No records for ${identity.name}. Try again.`}],
          },
        }),
  {name: 'check'},
);

export const rootAgent = new Workflow({
  name: 'intake_flow',
  edges: [
    ['START', intake, check],
    [check, {retry: intake, [DEFAULT_ROUTE]: greet}],
  ],
});
```

The second run of `intake` stays in `intake_flow.intake@1`. It reads the
`No records for ...` message, because `check` is unscoped, and its own earlier
questions, so it can ask for something it has not asked for yet.

adk-python differs here: it re-derives the scope per activation and compensates
in its content filter, which drops untagged events and rebuilds the agent's
opening turn. adk-js keeps untagged events shared and has no such rebuild, so it
carries the scope forward instead. Both give the agent a whole conversation;
adk-python restarts it on a retry and adk-js continues it.
