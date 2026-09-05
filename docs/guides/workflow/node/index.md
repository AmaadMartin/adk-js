# `node()` and `WorkflowNode`

`node()` turns a function, tool, agent, or existing node into a workflow node.
`WorkflowNode` is the base class you subclass when a node needs its own fields
and its own logic. Both can fan a node out over a list input.

## Introduction

A graph edge accepts several kinds of value, and `node()` is what converts one
into a `BaseNode`. Reach for it when you want a node with a specific name, a
retry policy, a timeout, or a fan-out — a bare function in an edge gets none of
those.

Subclass `WorkflowNode` instead when the node carries state of its own. A
subclass keeps its class and its fields everywhere the framework copies it,
including inside a fan-out, so each item sees the same configured node.

`ParallelWorker` is the node that does the fanning out. You rarely construct it
yourself: `parallelWorker: true` on either form builds it for you.

## Get started

`node()` takes a value and returns a node:

```ts
import {node, NodeContext} from '@google/adk';

const classify = node((_ctx: NodeContext, text: string) => text.toUpperCase(), {
  name: 'classify',
});
```

Called with options alone, it returns a function that builds the node later:

```ts
const classify = node({name: 'classify'})((_ctx: NodeContext, text: string) =>
  text.toUpperCase(),
);
```

The two forms are equivalent. The second is the portable half of adk-python's
`@node(...)` decorator; TypeScript decorators apply only to classes and class
elements, so there is no `@node` on a function here.

## Fan a node out over a list

`parallelWorker: true` runs the node once per item of a list input and emits the
ordered list of the results. A non-list input is treated as a one-element list.

```ts
const doubler = node({parallelWorker: true, maxParallelWorkers: 3})(
  (_ctx: NodeContext, item: number) => item * 2,
);
// Given [1, 2, 3], `doubler` emits [2, 4, 6].
```

A `WorkflowNode` subclass sets the same options in its `super()` call, and keeps
its own fields on every item:

```ts
import {node, NodeContext, Workflow, WorkflowNode} from '@google/adk';

const splitTopics = node(
  (_ctx: NodeContext, text: string) => text.split(',').map((t) => t.trim()),
  {name: 'split_topics'},
);

class Summarize extends WorkflowNode<string, string> {
  constructor(private readonly style: string) {
    super({name: 'summarize', parallelWorker: true, maxParallelWorkers: 3});
  }

  protected async *runNodeImpl(_ctx: NodeContext, topic: string) {
    yield `${this.style}: ${topic}`;
  }
}

export const rootAgent = new Workflow({
  name: 'workflow_node_parallel',
  edges: [['START', splitTopics, new Summarize('terse')]],
});
```

Given `ships, sealing wax`, `Summarize` emits
`['terse: ships', 'terse: sealing wax']`. The runnable version of this workflow
is `tests/integration/workflows/workflow_node_parallel/agent.ts`.

`maxParallelWorkers` caps how many items run at once. Leave it unset and
`ParallelWorker`'s own default of 8 applies; pass `Infinity` for unbounded
concurrency. Setting it without `parallelWorker`, or below 1, throws where you
set it rather than where the node runs.

Fanning out also forces `rerunOnResume` to `true`, overriding an explicit
`false`: the fan-out re-runs from the top when a paused item is answered, and
items that already completed are fast-forwarded rather than run again.
