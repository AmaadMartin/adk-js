# InvocationContext state

The state one run of an agent carries: the credential service it resolves
against, and the schema its session writes must satisfy. Reach for it when a
value must outlive a single agent but must not leak into the next invocation.

## Introduction

An invocation starts with a user message and ends with a final response. The
runner builds one `InvocationContext` for it and clones that context for each
sub-agent, each transfer and each loop iteration. `clone()` copies own fields,
so a scalar decouples and an object stays shared. That is what makes the
context the right home for run-wide state: a map put there is the same map for
every agent in the run, and a new invocation gets a fresh one.

Two kinds of state matter here.

- **Services.** `credentialService` is the service the `Runner` was built with.
  A tool that exchanges a credential reads it from the invocation rather than
  taking its own.
- **The state schema.** `stateSchema` declares which session-state keys the run
  may write and their types. `Context` and `ReadonlyContext` hand it to the
  `State` they build, so an undeclared write raises `StateSchemaError` instead
  of landing silently.

## Get started

Declare a schema on the invocation and every state write in the run is checked
against it.

```ts
import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
  isStateSchemaError,
} from '@google/adk';
import {z} from 'zod/v4';

const invocationContext = new InvocationContext({
  invocationId: 'inv-1',
  agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
  session: createSession({
    id: 's1',
    appName: 'app',
    userId: 'u',
    lastUpdateTime: Date.now(),
  }),
  pluginManager: new PluginManager(),
  stateSchema: z.object({counter: z.number()}),
});

const context = new Context({invocationContext});

context.state.set('counter', 1); // Declared, and the type matches.

try {
  context.state.set('countr', 1); // A typo the schema does not declare.
} catch (err: unknown) {
  isStateSchemaError(err); // true
}
```

With no `stateSchema`, nothing is checked and any key is accepted. That is the
default, so adding a schema is opt-in.

## What the schema checks

A write is rejected when the key is not declared, and when the value does not
match the declared type. The error is a `StateSchemaError`, and its message
names the declared fields so the fix is visible.

Keys carrying a namespace prefix — `app:`, `user:`, `temp:`, or any other
`name:` form — are exempt. They belong to a scope wider than this session's
state, so the invocation's schema has no authority over them.

A workflow node that declares its own `stateSchema` uses that one. The
invocation's schema applies where no node declares one, which is every ordinary
agent, callback and tool.

## Cloning and lifetime

Both fields reach a cloned context, so a sub-agent resolves credentials against
the same service and writes under the same schema as its parent.

```ts
const child = invocationContext.clone({agent: subAgent});

child.credentialService === invocationContext.credentialService; // true
child.stateSchema === invocationContext.stateSchema; // true
```

Both mirror `InvocationContext` in
[google/adk-python](https://github.com/google/adk-python), where the schema is
the private `_state_schema`.
