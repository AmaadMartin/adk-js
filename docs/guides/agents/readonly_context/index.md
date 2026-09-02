# ReadonlyContext

`ReadonlyContext` is the read-only view of an invocation that ADK hands to
instruction providers, toolsets and plugins. Reach for it when a callback needs
to read what the invocation is doing — the session, the run config, a resolved
credential — without being able to change it.

## Introduction

An `InvocationContext` carries everything about one agent run, including
mutable fields such as `endInvocation` and the plugin manager. Most extension
points do not need that power. An `InstructionProvider` builds a prompt string;
a `BaseToolset` decides which tools to expose. Both only read.

`ReadonlyContext` wraps the invocation and exposes the readable parts as
getters. The wrapper is what ADK passes to those extension points, so an
instruction provider cannot end the invocation by accident.

The view is shallow. `session` returns the live `Session` object, and
`getCredential` returns the live `AuthCredential`. Neither is copied or frozen,
so a caller that reaches into a returned object can still change it. The class
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

## What it exposes

| Member               | Returns                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userContent`        | The `Content` that started the invocation, or `undefined`.                                                                                                                      |
| `invocationId`       | The id of the invocation.                                                                                                                                                       |
| `userId`             | The user id of the session.                                                                                                                                                     |
| `sessionId`          | The id of the session.                                                                                                                                                          |
| `agentName`          | The name of the running agent, or `'unknown'` when there is none — a bare node, or a synthetic context such as the one `agent_card.ts` builds to resolve a dynamic instruction. |
| `state`              | The session state, as a `State` view.                                                                                                                                           |
| `a2aMetadata`        | Request metadata from an incoming A2A request, or `undefined`.                                                                                                                  |
| `session`            | The live `Session` object of the invocation.                                                                                                                                    |
| `runConfig`          | The `RunConfig` of the invocation, or `undefined`.                                                                                                                              |
| `getCredential(key)` | The credential resolved under `key`, or `undefined`.                                                                                                                            |

## Reading a resolved credential

`getCredential` returns `undefined` today. It reads the invocation-scoped
credential cache, which starts empty and stays empty until something writes to
it, and the writers live in the auth resolution path that adk-js does not port
yet.

Once a writer exists, a toolset reads the credential the invocation already
resolved for its `credentialKey` with
`const credential = context?.getCredential(this.credentialKey);`, instead of
running an auth exchange of its own.

The cache is shared by reference with every context
`InvocationContext.clone()` makes. A credential a sub-agent caches is therefore
visible to the parent invocation, and to any `ReadonlyContext` built over it.
