# ReadonlyContext

`ReadonlyContext` is the read-only view of an invocation that ADK hands to
instruction providers, toolsets and plugins. Reach for it when a callback needs
to read what the invocation is doing — the session, the state, the run config —
without being able to change it.

## Introduction

An `InvocationContext` carries everything about one agent run, including
mutable fields such as `endInvocation` and the plugin manager. Most extension
points do not need that power. An `InstructionProvider` builds a prompt string;
a `BaseToolset` decides which tools to expose. Both only read.

`ReadonlyContext` wraps the invocation and exposes the readable parts as
getters. The wrapper is what ADK passes to those extension points, so an
instruction provider cannot end the invocation by accident.

`Context` (and through it `ToolContext` and `CallbackContext`) extends
`ReadonlyContext` and adds the write surface. A tool that must change state
receives one of those, not this one.

## Get started

An instruction provider reads the state, the session and the run config:

```ts
import {LlmAgent, ReadonlyContext, StreamingMode} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  instruction: (context: ReadonlyContext) => {
    const tone = context.state.get<string>('tone', 'neutral');
    const turns = context.session.events.length;
    const live = context.runConfig?.streamingMode === StreamingMode.BIDI;
    return `You are helping ${context.userId} in app ${context.session.appName}.
Tone: ${tone}. Turns so far: ${turns}. Keep answers short: ${live}.`;
  },
});
```

`runConfig` is `undefined` when the invocation was built without one, so read it
with `?.` as above.

## The state view

`state` returns a read-only view of the session state. Reads pass through to the
live session, so a value a tool commits after the view was taken is visible
through it:

```ts
const view = readonlyContext.state;

view.get<string>('preferred_model'); // reads the live session state
view.has('preferred_model');
view.toRecord();
```

The view has no `set` and no `update` in its type. A JavaScript caller that
reaches one anyway gets a `ReadonlyStateError`, which extends `TypeError`:

```ts
import {isReadonlyStateError} from '@google/adk';

try {
  writeThroughTheView();
} catch (e: unknown) {
  if (isReadonlyStateError(e)) {
    // The session state is unchanged.
  }
}
```

The view is shallow. A nested object returned by `get` is the live object and
stays mutable, so a caller that reaches into it can still change it. The class
is a narrowed surface, not a security boundary. To write state, use a `Context`:
`toolContext.state.set('preferred_model', 'gemini-2.5-flash')`.

## Resolved credentials

`getCredential(key)` returns a credential that this invocation already resolved,
keyed by the credential key of the auth config that produced it. It returns
`undefined` for a key that no credential was resolved for:

```ts
const credential = readonlyContext.getCredential(authConfig.credentialKey);
```

The store lives on the `InvocationContext`, not in session state, so a
credential resolved for one invocation cannot leak into another. It is shared by
reference with every child context, so a credential resolved on a sub-agent
branch is visible to the parent.

## When there is no agent

`agentName` returns `'unknown'` instead of throwing when the invocation has no
agent. The `Runner` leaves the agent unset when its root is a bare `BaseNode` —
a `Workflow` handed straight to it — so a plugin or a custom node that reads
`agentName` on that path gets the sentinel rather than an error. This matches
adk-python, whose `ReadonlyContext.agent_name` returns `"unknown"` for the same
case.
