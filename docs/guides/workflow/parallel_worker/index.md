# ParallelWorker

`ParallelWorker` takes a node written to handle one item, runs it once per item
of a list input, and collects the outputs back into a list in the original
order.

## Introduction

A node with a list to work through takes as long as all of its items put
together when it handles them one at a time. A parallel worker starts every item
at once instead, so the node takes about as long as its slowest item. That pays
off most when the work is I/O bound, which covers a model call or a request to
an external API.

The worker does three things:

- **Concurrency.** The inner node runs once per item, all at the same time,
  throttled by `maxParallelWorkers` when you set it.
- **Aggregation.** The outputs are gathered into one list that keeps the order
  of the inputs, not the order in which the items finished.
- **Error propagation.** When one item fails, the worker cancels the items still
  in flight and rethrows that item's error.

Reach for it when each element of a list needs the same work and the elements do
not depend on each other. When they do depend on each other, or you need partial
results, drive the fan-out yourself with `ctx.runNode()` from a plain node.

## Get started

Wrap any value an edge accepts — a function, a tool, an agent, or a built node:

```ts
import {ParallelWorker, START, Workflow} from '@google/adk';

function listTopics() {
  return ['mitosis', 'photosynthesis', 'osmosis'];
}

// The worker hands one element at a time to the inner node.
function summarize(_ctx: unknown, topic: string) {
  return `Summary of ${topic}`;
}

// This node receives the collected results, in the input order.
function report(_ctx: unknown, summaries: string[]) {
  return summaries.join('\n');
}

const workflow = new Workflow({
  name: 'summarize_topics',
  edges: [[START, listTopics, new ParallelWorker(summarize), report]],
});
```

`node(value, {parallelWorker: true})` builds the same thing, which is the form
to use when you also want to set the inner node's own options:

```ts
import {node} from '@google/adk';

const summarizeEach = node(summarize, {
  parallelWorker: true,
  maxParallelWorkers: 4,
  timeout: 5,
});
```

Note where each option lands. `parallelWorker` and `maxParallelWorkers` describe
the worker; every other option — `timeout`, `retryConfig`, the schemas —
describes the **inner** node, so it applies per item. To bound the fan-out as a
whole, construct the worker directly and pass them there:

```ts
const summarizeAll = new ParallelWorker(node(summarize, {timeout: 5}), {
  timeout: 30,
  retryConfig: {maxAttempts: 3},
});
```

The two levels compose: each item gets 5 seconds, and the whole fan-out gets 30.

## How it works

1. **Input.** The worker expects a list. A single value that is not a list is
   wrapped in a one-element list. An empty list yields an empty list without
   running anything.
2. **Items.** Each item runs through
   `ctx.runNode(inner, item, {useSubBranch: true})`, so each gets its own branch
   and one item's events are not read as another's.
3. **Order.** Items may finish in any order. The worker remembers each item's
   input index and emits the list in that order.
4. **Failure.** The worker records the failing item, cancels the items still in
   flight, waits up to five seconds for them to stop, and then rethrows the
   error. When several items fail at once, it surfaces the one with the lowest
   input index, so a run and its replay agree.

An item observes the cancellation through `ctx.abortSignal`:

```ts
async function fetchTopic(ctx: NodeContext, topic: string) {
  const response = await fetch(url(topic), {signal: ctx.abortSignal});
  return response.json();
}
```

An item that ignores that signal is abandoned after five seconds, and the worker
logs a warning naming the node and the number of items it gave up on. It does
not wait for them, and it does not turn the abandonment into an error — the node
is already failing on the error that started the cancellation.

## Configuration

| Option               | Type          | Default   | Description                                  |
| :------------------- | :------------ | :-------- | :------------------------------------------- |
| `maxParallelWorkers` | `number`      | unbounded | Upper bound on items in flight at once.      |
| `retryConfig`        | `RetryConfig` | none      | Retry policy for the whole fan-out.          |
| `timeout`            | `number`      | none      | Deadline, in seconds, for the whole fan-out. |

`maxParallelWorkers` below `1` is rejected at construction, and so is a `START`
node. With no bound, a 200-element list issues 200 concurrent inner runs; set a
bound when the inner node is a model or a rate-limited API.

A parallel worker always has `rerunOnResume` on. It has to: after an interrupt
the node runs again to collect the items that had already finished, and those
are replayed from history rather than executed a second time.

## Human input from an item

An item can ask the user a question the way any other node can. Doing so pauses
the whole worker: it stops claiming items, emits no list, and raises the item's
interrupt ids as its own.

```ts
const review = node(
  (ctx: NodeContext, item: string) => {
    const answer = ctx.resumeInputs[`ask-${item}`];
    return answer === undefined
      ? new RequestInput({
          interruptId: `ask-${item}`,
          message: `Approve ${item}?`,
        })
      : `${item}: ${answer}`;
  },
  {rerunOnResume: true},
);
```

When the workflow resumes with the answer, the interrupted item completes, the
items that already finished are fast-forwarded by their run id, and the worker
emits the full list in input order.

## Limitations

- **A list goes in and a list comes out.** There is no way to emit results as
  they arrive.
- **One failure fails everything.** There is no continue-on-error setting, so
  wrap the risky part of an item's own logic in a `try` block when a failed item
  should not take the batch down with it.
- **Cancellation is cooperative.** An item that never reads `ctx.abortSignal`
  runs to completion in the background after the worker has given up on it.
