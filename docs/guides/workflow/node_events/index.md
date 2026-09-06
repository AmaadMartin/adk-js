# What a workflow node emits

A workflow node reports its result through the event stream. Some of those
events you write yourself; the rest the node runner writes for you. This guide
says which is which, so you can tell whether a value you set will reach the
stream.

## Introduction

A node can produce a result two ways. It can return or yield a value, which
becomes an event straight away. Or it can assign `ctx.output`, `ctx.route`,
`ctx.state` and `ctx.actions.artifactDelta` and yield nothing at all.

The second way needs help: there is no event left to carry those values. So when
a node finishes, the runner emits one event carrying whatever the node set and
never sent. That is the whole feature. Reach for this page when a value you
assigned did not turn up downstream, when you see one result arrive as two
events, or when you need to know which event a state write lands on.

Two things the runner deliberately does not do. It does not repeat an output an
event already carried. And it does not adopt a route or an agent transfer from
an event a nested sub-agent authored — only from the node's own.

## Get started

A node that assigns its result instead of returning it:

```ts
import {NodeContext, START, Workflow, node} from '@google/adk';

const summarize = node(
  (ctx: NodeContext, input: unknown) => {
    ctx.output = `summary of ${String(input)}`;
  },
  {name: 'summarize'},
);

const workflow = new Workflow({
  name: 'summarizer',
  edges: [[START, summarize]],
});
```

The handler returns nothing, so it yields no event of its own. One event still
reaches the stream when the node ends, carrying the output it assigned.

## The end-of-node event

The runner emits one trailing event when the node has any of these left over:

- an `output` no event carried,
- a `route` no event carried,
- pending `ctx.state` writes or `ctx.actions.artifactDelta` entries.

It emits nothing when the node has none of them. It also emits nothing when the
node stopped to ask the user: that pause writes its own checkpoint event, and
the node has not finished yet.

## Where a state write lands

A write goes onto the next event the node emits, and the runner clears it from
the context as it does so. Each write therefore appears on exactly one event.

```ts
const report = node(
  async function* (ctx: NodeContext) {
    ctx.state.set('stage', 'drafting');
    yield 'draft';
    ctx.state.set('stage', 'done');
  },
  {name: 'report'},
);
```

This emits two events. The first carries `output: 'draft'` and
`stateDelta: {stage: 'drafting'}`. The second is the end-of-node event, and
carries `stateDelta: {stage: 'done'}` alone.

A partial event carries no delta. Partial events are slices of one streamed
message, so the writes wait for the finished event that follows.

## What the runner reads off your events

The runner takes `output` from any event that carries one. It takes `route` and
`actions.transferToAgent` only from an event the node authored, or one that
names no author at all.

That guard matters for a node that wraps another agent. A `SequentialAgent` run
as a node forwards its sub-agents' events, and those events already had their
routing handled inside. Without the guard the enclosing node would adopt a
sub-agent's route as its own decision.

## A failed attempt leaves an error event

Every failed attempt emits one `NodeErrorEvent`, whether or not the node runs
inside a `Workflow`. A node that fails twice and succeeds on the third attempt
leaves two error events and then its output.

```ts
import {isNodeErrorEvent} from '@google/adk';

const failures = events.filter(isNodeErrorEvent).map((failure) => ({
  attempt: failure.attemptCount,
  code: failure.errorCode,
  message: failure.errorMessage,
}));
```

Each event carries:

- `errorType` — the error's class name.
- `errorCode` — a string `.status` on the error if it has one (an API's own
  canonical status, such as `PERMISSION_DENIED`), otherwise its `.code`,
  otherwise its class name, otherwise `UNKNOWN_ERROR`.
- `errorMessage` — the error's message.
- `attemptCount` — which attempt failed, counting from 1.

A node cut short by cancellation emits nothing. An aborted invocation, or a
sibling failing and cancelling this node, is not this node's failure to report.
