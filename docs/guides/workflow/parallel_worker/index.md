# ParallelWorker

`ParallelWorker` takes a node written to handle one item and runs it once per
item of an input list, all at the same time, then collects the results back into
a list in the original order.

## Introduction

A node with a list to work through — documents to analyze, queries to run,
topics to explain — takes as long as all of its items put together when it
handles them one at a time. A parallel worker starts every item at once instead,
so the node takes about as long as its slowest item. That pays off most where
the work is I/O bound, which covers an LLM call or a request to an external API.

A parallel worker does three things:

- **Concurrency**: the inner node runs once per item, all at the same time,
  bounded by `maxParallelWorkers` when you set it.
- **Aggregation**: the outputs are gathered into one list that keeps the order
  of the inputs, whatever order the items finish in.
- **Error propagation**: when an item fails, the items still in flight are
  cancelled and the error is rethrown.

Reach for it when one node's work repeats per element of a list. When you need
control it does not offer — partial results, a per-item retry, a different node
per item — drive the fan-out yourself with `ctx.runNode()` instead.

## Get started

Construct it directly, or set `parallelWorker: true` on `node()`:

```ts
import {node, NodeContext, ParallelWorker, Workflow} from '@google/adk';

const listTopics = node(
  (_ctx: NodeContext, topic: string) => [topic, 'osmosis'],
  {
    name: 'list_topics',
  },
);

// Each item of the list arrives as this node's input, not the whole list.
const summarize = new ParallelWorker(
  node((_ctx: NodeContext, item: string) => `Summary of ${item}`, {
    name: 'summarize',
  }),
);

// This node receives the collected results, in the order of the inputs.
const report = node(
  (_ctx: NodeContext, summaries: string[]) => summaries.join('\n'),
  {name: 'report'},
);

const workflow = new Workflow({
  name: 'summarize_topics',
  edges: [['START', listTopics, summarize, report]],
});
```

`node(value, {parallelWorker: true})` builds the same thing and is the shorter
form inside an edge list. It also accepts `maxParallelWorkers`, which is
rejected without `parallelWorker: true`.

## How it works

1. **Input handling.** The worker expects an array. A single value that is not
   an array is wrapped in a one-element array. An empty array yields an empty
   array without running anything.
2. **Item runs.** Each item runs through
   `ctx.runNode(inner, item, {useSubBranch: true})`, keyed by its input index.
   The separate sub-branches keep one item's events from being read as
   another's while they all run at once.
3. **Result ordering.** Items may finish out of order. The worker remembers each
   item's index and emits the results in input order.
4. **Failure handling.** When an item throws, the worker stops claiming new
   items, aborts the items still in flight, waits up to five seconds for them to
   stop, and rethrows the item's error unchanged. When several items fail
   together it rethrows the one belonging to the lowest input index, so the
   error you see is the same on every run and on replay.

Cancellation is cooperative. JavaScript cannot interrupt an `await`, so the
worker aborts a signal each item observes as `ctx.abortSignal`. An item that
never reads that signal keeps running; after five seconds the worker logs a
warning and abandons it rather than waiting forever.

## Configuration options

| Option               | Type          | Default   | Description                                                      |
| :------------------- | :------------ | :-------- | :--------------------------------------------------------------- |
| `maxParallelWorkers` | `number`      | unbounded | Upper bound on items in flight at once. Unset means all of them. |
| `retryConfig`        | `RetryConfig` | none      | Retries the whole fan-out, not one item.                         |
| `timeout`            | `number`      | none      | Seconds allowed for the whole fan-out.                           |

`retryConfig` and `timeout` apply to the fan-out as a whole. To set them per
item, wrap the inner value yourself:

```ts
import {node, NodeContext, ParallelWorker} from '@google/adk';

const worker = new ParallelWorker(
  node((_ctx: NodeContext, item: string) => item.toUpperCase(), {
    name: 'shout',
    timeout: 5, // per item
  }),
  {maxParallelWorkers: 4, timeout: 30}, // for the fan-out
);
```

A value below `1` for `maxParallelWorkers` throws, and so does wrapping the
`START` sentinel.

A parallel worker always has `rerunOnResume` on. It has to: after an interrupt
the node runs again to collect the results of the items that had already
finished. Those items are replayed by their run id rather than executed again.

## Human input from a worker item

An item can ask the user a question by returning a `RequestInput`, as any node
can. The whole worker pauses, emits no list, and raises the item's interrupt id
as its own. Items already in flight are cancelled. When the workflow resumes
with the answer, the worker runs again: completed items are replayed, the
interrupted item finishes, and the node emits the full list in input order.

## Limitations

- **A list goes in, a list comes out.** Anything that is not an array is treated
  as a list of one item.
- **One failure fails everything.** There is no setting that collects partial
  results. Wrap the risky part of an item's own logic in `try` when a failed
  item should not take the batch down with it.
- **Cancellation is cooperative.** An item that ignores `ctx.abortSignal` runs
  to completion in the background after the worker abandons it.
- **Unbounded by default.** A 200-item list starts 200 inner runs. Set
  `maxParallelWorkers` when the inner node is an LLM or a rate-limited API.
