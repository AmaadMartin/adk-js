# BaseNode names, paths and serialization

`BaseNode` is the class every workflow node extends. This guide covers the
three parts of it that decide how a node is identified and how its data is
stored: the name rule, the static node path, and the flattening applied to a
schema-validated value.

## Introduction

A node name is not only a label. It becomes a segment of the node path and the
author of every event the node emits, and `.` and `@` are the separators those
paths are split on. A name holding either character produces a path that
resolves back to the wrong node, silently. ADK therefore rejects such a name
when the node is built, where the stack trace still points at your code.

A name alone does not identify a node, because two copies of one sub-agent can
be mounted under two parents and share a name. `findStaticNodePath` answers the
other question — where a node sits in the tree — by returning the chain of
names that reaches it.

The third part concerns what a node's data looks like after it is stored. An
`inputSchema` or `outputSchema` may produce a live class instance, through
`.transform()` for example. A fresh run then holds the instance, while a
resumed run reads the dumped form back out of the session store, and the two
runs disagree on the type. ADK flattens the validated value so they agree.

## Get started

`findStaticNodePath(root, target)` returns the dot-joined chain of names from
`root` down to `target`, or `undefined` when `target` is not reachable.

```ts
import {LlmAgent, findStaticNodePath} from '@google/adk';

const workerA = new LlmAgent({name: 'worker', model: 'gemini-flash-latest'});
const workerB = new LlmAgent({name: 'worker', model: 'gemini-flash-latest'});

const root = new LlmAgent({
  name: 'root',
  model: 'gemini-flash-latest',
  subAgents: [
    new LlmAgent({
      name: 'team_a',
      model: 'gemini-flash-latest',
      subAgents: [workerA],
    }),
    new LlmAgent({
      name: 'team_b',
      model: 'gemini-flash-latest',
      subAgents: [workerB],
    }),
  ],
});

findStaticNodePath(root, workerA); // 'root.team_a.worker'
findStaticNodePath(root, workerB); // 'root.team_b.worker'
```

The two workers share a name and get different paths, so a caller resolving
"which node emitted this event" can tell them apart by position.

### What the walk reaches

The search is depth-first and matches on object identity, not on name. It
starts at `root` and reads the node's own properties, taking a property that
holds a node, and an array, `Set`, `Map` or plain object holding nodes one
level deep. A cycle terminates: a child holding a back-reference to its parent
is visited once.

Any other class instance is opaque. A `Workflow` keeps its nodes inside a
`Graph`, and a `Graph` is not a node, so the walk does not reach them:

```ts
findStaticNodePath(myWorkflow, aNodeInsideIt); // undefined
```

The practical subject of this helper is an agent tree reached through
`subAgents`.

## Node names must be identifiers

A name has to start with a letter or `_` and may then contain letters, digits,
`_` and `-`. The rule is Unicode-aware, so `café` is a valid name. It is the
same rule ADK already applies to agent names.

```ts
import {node} from '@google/adk';

node((ctx, input) => input, {name: 'draft-report'}); // fine
node((ctx, input) => input, {name: 'my node'}); // throws
node((ctx, input) => input, {name: '2fast'}); // throws
```

The error names the offending value:

```
Found invalid node name: "my node". Node name must be a valid identifier. It
should start with a letter (a-z, A-Z) or an underscore (_), and can only
contain letters, digits (0-9), underscores, and hyphens.
```

Surrounding whitespace is trimmed rather than rejected, so `'  draft  '`
becomes `'draft'`. A name that is empty or only whitespace is rejected with
`Node name must be a non-empty string.`

## Validated data is flattened

When a node declares an `inputSchema` or an `outputSchema`, ADK validates the
value and then flattens it into plain data. An object exposing `toJSON()` is
dumped through it; arrays and plain objects are rebuilt with their members
flattened; everything else is returned as it is. The input is never mutated.

```ts
import {node} from '@google/adk';
import {z} from 'zod';

class Report {
  constructor(readonly title: string) {}
  toJSON(): {title: string} {
    return {title: this.title};
  }
}

const draft = node((ctx, input: string) => ({title: input.toUpperCase()}), {
  name: 'draft-report',
  outputSchema: z
    .object({title: z.string()})
    .transform((v) => new Report(v.title)),
});
```

The event `draft-report` emits carries `{title: 'QUARTERLY NUMBERS'}`, a plain
object, not a `Report`. A resumed run reads back the same shape.

Two limits are worth knowing. A node with no schema is left alone entirely, so
a raw value a node yields reaches its event untouched. And `LlmAgent` overrides
`validateOutput` with its own implementation, so an agent's `outputSchema`
output is not flattened.
