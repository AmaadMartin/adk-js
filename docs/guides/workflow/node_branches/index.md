# Event branches in a node run

Every event a workflow node emits carries a `branch`. The branch labels which
path through the graph produced the event, and a node can set it to redirect
the events that follow.

## Introduction

A branch is a string stamped on each event so a reader can tell one path
through a workflow from another. Parallel paths get distinct branches, so a
consumer can group a fan-out's events by the worker that produced them.

The engine stamps the branch for you. When a node runs, the engine computes the
branch in force for that run: the parent's branch, a sub-branch when the node
asked for one, or an explicit `overrideBranch`. Each event the node emits
inherits that branch.

A node can override the stamp per event. This matters when the node itself
knows something the engine does not — an agent-as-node that fans out
internally, or a node that leaves a labelled region and wants its remaining
events unlabelled. Setting `branch` on an event changes that event **and** the
branch every later event of the same run inherits.

The branch is scoped to the run. A node cannot change the branch its parent or
its siblings see; the engine keeps the running value beside the run rather than
on the shared invocation context.

## Get started

A node that emits events without touching `branch` inherits the branch in
force:

```ts
import {BaseNode, createEvent, Event} from '@google/adk';

class Report extends BaseNode {
  protected async *runImpl(): AsyncGenerator<Event, void, void> {
    yield createEvent({content: undefined});
  }
}
```

To redirect the branch, set it on an event:

```ts
class Relabel extends BaseNode {
  protected async *runImpl(): AsyncGenerator<Event, void, void> {
    yield createEvent({branch: 'audit', content: undefined});
    // Inherits 'audit'.
    yield createEvent({content: undefined});
  }
}
```

## The three cases

`branch` on an event is read three ways.

| `event.branch`      | Effect on the event       | Effect on later events    |
| ------------------- | ------------------------- | ------------------------- |
| `undefined`         | Gets the branch in force. | None.                     |
| `''` (empty string) | Cleared to `undefined`.   | They are unbranched too.  |
| any other string    | Kept as set.              | They inherit that string. |

The empty string is the only way to clear a branch. Assigning `undefined` means
"I did not set one", so the engine fills it in.

```ts
class LeaveRegion extends BaseNode {
  protected async *runImpl(): AsyncGenerator<Event, void, void> {
    yield createEvent({branch: '', content: undefined});
    // Also unbranched.
    yield createEvent({content: undefined});
  }
}
```

## What a redirect does not reach

A redirect lasts for the rest of the node's run and no longer.

- The parent's invocation context is untouched, so the parent and the node's
  siblings keep the branch they had.
- A later node inherits from the graph, not from whatever the previous node
  last set.
- A failed attempt's redirect is discarded. When a node retries, the branch goes
  back to the one the run started on.
- A value a node yields directly (rather than an `Event`) **reverts the
  redirect** for every event after it. `BaseNode.toEvent` turns the value into
  an event stamped with the node context's own branch, which is the branch the
  run started on, and that stamp becomes the new running branch. Yield `Event`s
  rather than plain values to keep a redirect.

This mirrors `adk-python`'s `NodeRunner._enrich_event`, with one deliberate
difference: `adk-python` clears the branch by writing `None` onto the context it
copied per child, while `adk-js` reuses the parent's `InvocationContext` when
nothing differs and so keeps the running branch beside the run instead.
