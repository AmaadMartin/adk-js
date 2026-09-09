# Workflow nodes

`node()` turns a function, a tool, an agent or an existing node into a workflow
node. `WorkflowNode` is the base class you subclass when the node needs state or
logic of its own. Both accept `parallelWorker`, which runs the node once per
item of a list input and collects the results.

## Introduction

A workflow graph is built from `BaseNode`s, but you rarely write one by hand.
`node()` builds the right node for whatever you give it: a plain function
becomes a `FunctionNode`, a `BaseTool` becomes a `ToolNode`, and an agent is
already a node so it goes in as itself. Given a node it already built, it
returns a copy with your overrides applied, which lets one node sit in two
graphs under two names.

Subclass `WorkflowNode` when a function is not enough — when the node carries
fields, or when you want the schema, retry and timeout machinery of `BaseNode`
on a class of your own.

Either way, `parallelWorker` is the setting that changes how the node is _run_
rather than what it does. A node written to handle one item then handles a list
of them, one run per item, and emits the results in the input order.

## Get started

```ts
import {node, NodeContext, Workflow} from '@google/adk';

const classify = node(
  (_ctx: NodeContext, text: string) =>
    text.endsWith('?') ? 'question' : 'statement',
  {name: 'classify'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', classify]],
});
```

## The two call forms

`node(value, options)` builds a node now. `node(options)` builds nothing and
returns a wrapper that applies those options to whatever it is later given:

```ts
import {node, NodeContext} from '@google/adk';

const asWorker = node({parallelWorker: true, maxParallelWorkers: 3});

const summarize = asWorker(async function summarize(
  _ctx: NodeContext,
  topic: string,
) {
  return `summary of ${topic}`;
});
```

The wrapper form is the portable half of adk-python's `@node(...)` decorator.
TypeScript decorators apply only to classes and class elements, so there is no
`@node` on a function declaration; the call above is what replaces it.

`node()` with no arguments returns a wrapper that applies no overrides.

## Running a node once per list item

Set `parallelWorker` and the node is wrapped in a `ParallelWorker`. Give it
`[1, 2, 3]` and it runs three times, once per item, and emits `[2, 4, 6]`:

```ts
import {node, NodeContext, Workflow} from '@google/adk';

const double = node({parallelWorker: true})(async function double(
  _ctx: NodeContext,
  value: number,
) {
  return value * 2;
});

function produce() {
  return [1, 2, 3];
}

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', produce, double]],
});
```

An input that is not a list is treated as a list of one item. An empty list
produces an empty list without running anything. If one item throws, the worker
stops claiming new items and rethrows the first error, so partial results are
discarded — make an item failure-tolerant if that matters.

`maxParallelWorkers` bounds how many items are in flight at once. It defaults to
8, which is a deliberate difference from adk-python, where the fan-out is
unbounded: an item is often an LLM call or a remote request, and an
input-driven list length would otherwise decide your request rate. Pass
`Infinity` for no bound.

A parallel worker always has `rerunOnResume` on. After an interrupt the node
runs again to collect the items that had already finished, and those are
replayed from the checkpoint rather than executed a second time.

## Subclassing WorkflowNode

Implement `runNodeImpl`. It receives the node input — one item at a time when
`parallelWorker` is set — and yields events, raw values, or `null`:

```ts
import {
  NodeContext,
  Workflow,
  WorkflowNode,
  WorkflowNodeConfig,
} from '@google/adk';

interface LabelNodeConfig extends WorkflowNodeConfig {
  label: string;
}

class LabelNode extends WorkflowNode<string, string> {
  private readonly label: string;

  constructor(config: LabelNodeConfig) {
    super(config);
    this.label = config.label;
  }

  protected async *runNodeImpl(_ctx: NodeContext, input: string) {
    yield `${this.label}: ${input}`;
  }
}

const classify = new LabelNode({
  name: 'classify',
  label: 'topic',
  parallelWorker: true,
  maxParallelWorkers: 4,
});

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', classify]],
});
```

Fed `['x', 'y']`, that workflow emits `['topic: x', 'topic: y']`.

The wrapper is built the first time the node runs, not in the constructor. A
base constructor runs before a subclass assigns its own fields, so a wrapper
built there would wrap a copy of the node with `label` still undefined.

## Copying a node

`node(existing, {...})` and `WorkflowNode.clone()` both return a copy that keeps
the original's class and fields. A copy of a parallel worker builds a fresh
wrapper around itself, so it fans out over its own fields rather than the ones
it was copied from:

```ts
const renamed = node(classify, {name: 'classify_2'});
```

`node(existing)` with no overrides returns the original, not a copy: callers
compare the node they passed in against the one the graph holds.

## Configuration errors

| Condition                                     | Message                                                           |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `maxParallelWorkers` without `parallelWorker` | `maxParallelWorkers can only be set when parallelWorker is true.` |
| `maxParallelWorkers` below `1`                | `maxParallelWorkers must be greater than or equal to 1.`          |
| `parallelWorker` on the `'START'` sentinel    | `ParallelWorker cannot wrap a START node.`                        |

The first two are raised by the call that got them wrong. `node({parallelWorker:
false, maxParallelWorkers: 3})` throws where it is written, before the wrapper
it returns is ever applied.
