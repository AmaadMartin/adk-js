# BaseNode names and serialization

`BaseNode` is the class every workflow node extends. This guide covers the two
parts of it a caller can observe: the rule a node name has to satisfy, and the
flattening applied to a value that passed a schema.

## Introduction

A node name is not only a label. It becomes a segment of the node path and the
author of every event the node emits, and `.` and `@` are the separators those
paths are split on. A name holding either character produces a path that
resolves back to the wrong node, silently. ADK therefore rejects such a name
when the node is built, where the stack trace still points at your code.

The second part concerns what a node's data looks like after it is stored. An
`inputSchema` or `outputSchema` may produce a live class instance, through
`.transform()` for example. A fresh run then holds the instance, while a
resumed run reads the dumped form back out of the session store, and the two
runs disagree on the type. ADK flattens the validated value so they agree.

## Get started

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
`Node name must be a non-empty string.` The check also runs when you rename a
node through `node(existingNode, {name})`, which does not call the constructor.

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

For an ordinary Zod schema this is close to a no-op, because
`z.object().parse()` already returns a plain object. It matters on the
`.transform()`, `z.instanceof()` and genai `Schema` paths, where a validated
value can be a live class instance.

Two limits are worth knowing. A node with no schema is left alone entirely, so
a raw value a node yields reaches its event untouched. And `LlmAgent` overrides
`validateOutput` with its own implementation, so an agent's `outputSchema`
output is not flattened.
