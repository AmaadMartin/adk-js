# ReadonlyContext

`ReadonlyContext` is the read-only view of an invocation that ADK hands to
instruction providers, toolsets and plugins. Reach for it when a callback needs
to read what the invocation is doing — the session, the run config — without
being able to change it.

## Introduction

An `InvocationContext` carries everything about one agent run, including
mutable fields such as `endInvocation` and the plugin manager. Most extension
points do not need that power. An `InstructionProvider` builds a prompt string;
a `BaseToolset` decides which tools to expose. Both only read.

`ReadonlyContext` wraps the invocation and exposes the readable parts as
getters. The wrapper is what ADK passes to those extension points, so an
instruction provider cannot end the invocation by accident.

The view is shallow. `session` returns the live `Session` object, not a copy or
a frozen view, so a caller that reaches into it can still change it. The class
is a narrowed surface, not a security boundary.

## Get started

An instruction provider reads the session and the run config:

```ts
import {LlmAgent, ReadonlyContext, StreamingMode} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  instruction: (context: ReadonlyContext) => {
    const turns = context.session.events.length;
    const live = context.runConfig?.streamingMode === StreamingMode.BIDI;
    return `You are helping ${context.userId} in app ${context.session.appName}.
Turns so far: ${turns}. Keep answers short: ${live}.`;
  },
});
```

`runConfig` is `undefined` when the invocation was built without one, so read it
with `?.` as above.

## When there is no agent

`agentName` returns `'unknown'` instead of throwing when the invocation has no
agent. The `Runner` leaves the agent unset when its root is a bare `BaseNode` —
a `Workflow` handed straight to it — so a plugin or a custom node that reads
`agentName` on that path gets the sentinel rather than an error. This matches
adk-python, whose `ReadonlyContext.agent_name` returns `"unknown"` for the same
case.
