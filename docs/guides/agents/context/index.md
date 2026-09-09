# Context and NodeContext

`Context` is the object a callback or a tool receives during an agent run. It
carries the session state, the event actions, and the services the run was
configured with. `NodeContext` is its counterpart inside a workflow: a node
receives one, and drives child nodes through it.

## Introduction

adk-python keeps one `Context` class for both roles. adk-js splits it in two,
because the two roles have almost no members in common:

| Role              | adk-js class  | File                                |
| ----------------- | ------------- | ----------------------------------- |
| Callback and tool | `Context`     | `core/src/agents/context.ts`        |
| Workflow node     | `NodeContext` | `core/src/workflow/node_context.ts` |

Reach for `Context` when you write a `beforeAgentCallback`, an
`afterToolCallback`, or a tool body. It gives you artifacts, credentials,
memory, auth, and tool confirmations, all on top of a delta-aware `state` whose
writes accumulate in `actions.stateDelta`.

Reach for `NodeContext` when you write a workflow node. It gives you the node's
path and run id, `emit(...)` to stream an event, `runNode(...)` to run a child,
and the `output` and `route` the engine reads back when the node finishes.

## Get started

A tool that saves the credential it just exchanged, and records the
conversation:

```ts
import {Context, AuthConfig} from '@google/adk';

async function persistLogin(authConfig: AuthConfig, ctx: Context) {
  await ctx.saveCredential(authConfig);
  await ctx.addSessionToMemory();
}
```

Both methods throw when the run has no such service, so wire them on the
`Runner`:

```ts
const runner = new Runner({
  appName: 'my_app',
  agent: myAgent,
  sessionService: new InMemorySessionService(),
  memoryService: new InMemoryMemoryService(),
  credentialService: myCredentialService,
});
```

A node that runs a child and takes its result as its own:

```ts
import {NodeContext, node} from '@google/adk';

const summarize = node(async (ctx: NodeContext, input: unknown) => {
  const child = await ctx.runNode(extract, input, {useAsOutput: true});
  return child.output;
});
```

## Services and their errors

Every service accessor on `Context` throws rather than returning `undefined`
when the service is missing, so a misconfigured run fails where the mistake is:

| Method                                                                | Message when the service is absent                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `loadArtifact`, `saveArtifact`, `listArtifacts`, `getArtifactVersion` | `Artifact service is not initialized.`                           |
| `saveCredential`, `loadCredential`                                    | `Credential service is not initialized.`                         |
| `searchMemory`                                                        | `Memory service is not initialized.`                             |
| `addSessionToMemory`                                                  | `Cannot add session to memory: memory service is not available.` |

`saveArtifact` takes optional metadata as a third argument and records the new
version in `actions.artifactDelta`:

```ts
const version = await ctx.saveArtifact('report.pdf', part, {origin: 'tool'});
```

## What a node may produce

A node produces at most one output. A second assignment to `ctx.output` throws
`Output already set. A node can produce at most one output.` A retry does not
count: the runner clears the output before each attempt, so an attempt that
failed after setting one leaves nothing behind.

The same rule covers delegation. `runNode(child, input, {useAsOutput: true})`
makes the child's output the caller's, so a second `useAsOutput` child throws
`Node <path> already has a use_as_output delegate.` A `Workflow` is exempt,
because it delegates on behalf of whichever of its nodes is terminal.

## Reading a child's failure

`runNode` throws when the child fails, and the child's context records what
happened before the throw propagates:

```ts
const child = await ctx.runNode(risky, input).catch(() => undefined);
// On failure, the child context carries `error` and `errorNodePath`.
```

`errorNodePath` names the node the failure came from, which is not always the
child you started: a failure raised deeper keeps the original path.

## Waiting children

A node with `waitForOutput`, and a `Workflow`, can finish a turn with no output
because it is still waiting for one. By default `runNode` returns that child
normally. Pass `raiseOnWait` to get a `NodeInterruptedError` instead, so the
caller is recorded as waiting rather than completed:

```ts
await ctx.runNode(approval, input, {raiseOnWait: true});
```

## Event authorship

The engine stamps an author on an event the node left author-less. It uses
`ctx.eventAuthor` when an orchestrator set one, and the node's own name
otherwise. A child context inherits `eventAuthor` from its parent, so setting it
once covers a whole subtree.
