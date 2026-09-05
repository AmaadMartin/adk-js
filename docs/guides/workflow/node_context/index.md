# NodeContext

`NodeContext` is what a workflow node is handed while it runs. It carries the
node's session state, its result, and `ctx.runNode(...)` — the call that runs
another node from inside this one.

## Introduction

A static graph (`new Workflow({edges: [...]})`) fixes the order of the nodes
when you build it. Some work cannot be written that way: a loop that repeats
until a reviewer is satisfied, a fan-out whose width depends on the input, a
branch chosen by logic no edge can express. For those, a node calls
`ctx.runNode(child, input)` and awaits the child's result, and the workflow
shape follows your ordinary control flow.

`NodeContext` is the TypeScript counterpart of the workflow half of
adk-python's `Context` (`google/adk/agents/context.py`). adk-js splits that one
Python class in two: `Context` (`core/src/agents/context.ts`) is what a callback
or a tool sees, and `NodeContext` is what a workflow node sees. Everything on
this page is on `NodeContext`.

## Get started

A parent node runs a child and returns the child's result as its own.

```ts
import {node, NodeContext, Workflow} from '@google/adk';

const summarize = node(
  (_ctx: NodeContext, text: string) => `summary of: ${text}`,
  {name: 'summarize'},
);

const orchestrate = node(
  async (ctx: NodeContext, input: string) => {
    const child = await ctx.runNode(summarize, input);
    return child.output;
  },
  {name: 'orchestrate', rerunOnResume: true},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', orchestrate]],
});
```

`ctx.runNode()` resolves to the child's **result**, so read `.output` off it.
The result is a full `NodeContext` for a child that ran, and a bare
`NodeResult` for one that was answered from a checkpoint on resume. Both carry
`output`, `route`, `branch` and `interruptIds`; only a `NodeContext` also offers
`emit`, `state` and a nested `runNode`.

Give an orchestrator `rerunOnResume: true`. Its body then re-runs when the
workflow resumes, and each `ctx.runNode()` call it already completed is answered
from that child's checkpoint instead of running again. adk-python refuses to run
a dynamic child from a parent without the flag; adk-js does not refuse, because
its scheduler replays a completed child either way.

## Delegating the output

Pass `useAsOutput` to make a child's output this node's output as well. The
child's event is then annotated as answering for both, so the result is not
reported twice.

```ts
const wrapper = node(
  async (ctx: NodeContext, input: string) => {
    await ctx.runNode(summarize, input, {useAsOutput: true});
  },
  {name: 'wrapper', rerunOnResume: true},
);
```

A node may hand its output to one child only. A second `useAsOutput` call throws
`Node <path> already has a use_as_output delegate.` The claim is made before the
child runs, so a child that fails still counts. A `Workflow` is exempt: it
delegates to each of its own nodes in turn.

## Agent transfer

An agent run as a node can ask for another agent to take over, by setting
`ctx.actions.transferToAgent`. `ctx.runNode()` resolves that name against the
agent tree and runs the target in place, so the call returns the target's
result.

```ts
class Triage extends BaseAgent {
  protected override async *runImpl(
    ctx: NodeContext,
  ): AsyncGenerator<Event, void, void> {
    ctx.actions.transferToAgent = 'billing';
  }
  // runAsyncImpl / runLiveImpl omitted
}
```

Where the target runs depends on how the two agents are related:

| Relationship                    | Where the target runs                 |
| ------------------------------- | ------------------------------------- |
| a sub-agent of the caller       | under the caller's own context        |
| a sibling under the same parent | under the caller's parent context     |
| the caller's parent             | under the context that ran the parent |
| anything else in the tree       | nowhere — the transfer is rejected    |

`disallowTransferToPeers` and `disallowTransferToParent` on an `LlmAgent` reject
the matching transfer. A transfer to the agent itself, to a name that is not in
the tree, or to an agent with no routing relationship all throw. A chain of
transfers is capped at 50 hops, so two agents that hand back and forth forever
fail instead of hanging.

This is the workflow node-level transfer. It is separate from the agent-level
one an `LlmAgent` performs when a model calls `transfer_to_agent`; that one
`LlmAgent` runs itself, and it does not reach `ctx.runNode`.

## Interrupts and waiting

A child that stops to ask the user leaves the caller unable to finish. When a
node body calls `ctx.runNode()` and the child comes back with unanswered
interrupt ids, the call throws `NodeInterruptedError` after copying those ids
onto the calling context — so the engine records the caller as waiting, and the
rest of the caller's body does not run on a missing answer.

A child that finishes without asking anything, but also without producing a
result, does not unwind the caller. Read `child.output` and decide what to do.
A `Workflow` and a node declaring `waitForOutput` are already recorded as
waiting by the engine when they produce nothing.

A root context built by a driver rather than by the engine — what
`runNodeAsInvocation` and `NodeTool` build — is exempt from all of this. Such a
driver awaits the child and reads `interruptIds` itself, so raising there would
turn a paused run into a failed one.

## What the context records

Three fields say what happened during the run.

- `error` and `errorNodePath` — the failure that ended the node, and the path of
  the node that actually raised it. A failure that started in a `ctx.runNode`
  child keeps that child's path as it travels up, so an ancestor reports where
  the run really broke rather than reporting itself. Both are cleared before a
  retry.
- `eventAuthor` — the author stamped on events the node leaves unattributed. An
  agent run as a node records its own author here, so a later event it emits
  without one is still attributed to the agent rather than to the node it was
  registered under. Child contexts inherit the value. An event that already
  carries an author keeps it. adk-python also has `Workflow` set this to its own
  name; adk-js does not, because it attributes events to the node that emitted
  them.
  `parentCtx` and `node` link a context back to the context that ran it and to the
  node it belongs to. The transfer resolver walks that chain; both are `undefined`
  on a root context.
