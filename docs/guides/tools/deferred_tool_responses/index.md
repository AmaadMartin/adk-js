# Deferred tool responses

Lets an ADK-internal tool tell the function-call loop that its
`FunctionResponse` arrives later, from another orchestrator. Reach for it when
you write a framework tool that only dispatches work and never answers the
model itself.

## Introduction

When a tool runs, ADK builds the `FunctionResponse` from the value the tool
returns. A tool that delegates has no value to return: something else finishes
the work and appends the real response to the session later. Without a way to
say so, ADK builds a response anyway, and the model sees an empty answer for a
call that is still in flight.

`BaseTool.isLongRunning` already skips that build, but it does more than skip.
It also adds the call id to `Event.longRunningToolIds`, which A2A conversion,
plugin logging and interrupt tracking all read. A delegating tool is not a
long-running tool, and marking it as one changes behaviour far from the tool.

`BaseTool._defersResponse` separates the two. It skips the automatic
`FunctionResponse` build with the same rule as `isLongRunning` — only when the
tool returned nothing — and it never touches `longRunningToolIds`. The flag is
internal: ADK sets it, application code does not. It mirrors
`BaseTool._defers_response` in adk-python.

## Get started

A tool sets the flag in its own constructor, after `super(...)`. It is not a
constructor option, so no caller can turn it on from outside.

```ts
import {BaseTool, Context, RunAsyncToolRequest} from '@google/adk';

class DelegatingTool extends BaseTool {
  constructor() {
    super({name: 'delegate', description: 'Hands the task to a sub-agent.'});
    this._defersResponse = true;
  }

  override async runAsync({
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    dispatch(toolContext);
    return undefined;
  }
}

function dispatch(toolContext: Context): void {
  toolContext.state.set('handedOff', true);
}
```

The call emits no `functionResponse` part. The orchestrator that owns the work
appends the matching response to the session when it completes.

## What the flag guarantees

- **Skip only on an empty result.** A deferring tool that returns a value emits
  a normal response event, exactly like any other tool. Only `null` and
  `undefined` skip the build. `''`, `0` and `false` are real results.
- **No long-running mark.** The call id stays out of
  `Event.longRunningToolIds`, so A2A conversion and interrupt tracking treat
  the call as ordinary.
- **Actions survive.** State deltas, artifact deltas, auth requests,
  confirmation requests, transfers and `skipSummarization` recorded on the tool
  context still reach the session. ADK emits a content-less event that carries
  them.

## When to use `isLongRunning` instead

Use `isLongRunning` for a tool that starts work the _user_ must track — a job
whose id the model reports back, or a human-in-the-loop pause. The
long-running mark is what makes the pending call visible to A2A clients and to
the interrupt machinery. Use `_defersResponse` only when ADK itself supplies
the response later and nothing outside the framework needs to know the call is
open.
