# BaseNode names, static paths and serializable output

Three `BaseNode` behaviours decide how a workflow names a node and how it stores
that node's output. Read this when a node name is rejected at construction, when
two nodes in one graph share a name, or when a node's output changes shape after
a resume.

## Introduction

A node name is not only a label. The node runner joins names with `.` to build a
node path, and it writes the name into `Event.author`. A name holding a space, a
dot or a slash corrupts both, so `BaseNode` rejects it in the constructor rather
than later.

A name is still not unique on its own. Two sub-workflows can each mount a node
called `worker`. `findStaticNodePath` tells them apart by position instead of by
name, and returns a path that carries no run id.

The third behaviour is about storage. An `outputSchema` can produce a live
object, such as a `Date` from `z.coerce.date()`. That object survives in memory
and dies in the session store, so a resumed run reads something different from
the fresh run. `toSerializable` flattens a validated output into plain data, and
`validateOutput` applies it for you.

## Get started

```ts
import {node, Workflow} from '@google/adk';
import {z} from 'zod';

const parseDate = node((_ctx, input: string) => ({when: input}), {
  name: 'parse_date',
  outputSchema: z.object({when: z.coerce.date()}),
});

const workflow = new Workflow({
  name: 'date_flow',
  edges: [['START', parseDate]],
});
```

The schema turns the input string into a `Date`. The event carries
`{when: '2026-01-02T03:04:05.000Z'}` — a plain string — so the session store
keeps the value a resumed run needs.

## Node names must be identifiers

A name starts with a Unicode `ID_Start` character, `$` or `_`. After the first
character it may also hold digits, `-` and `$`. `snake_case`, `camelCase`,
`_private`, `with-hyphen` and `n1` all pass. `my node`, `1abc`, `a.b` and `a/b`
all fail.

```ts
node(() => 'ok', {name: 'my node'});
// Error: Found invalid node name: "my node". Node name must be a valid
// identifier. ...
```

An empty or blank name keeps its own message, `Node name must be a non-empty
string.`, because that case has a clearer cause.

`Workflow`, `JoinNode`, `FunctionNode` and `ToolNode` all extend `BaseNode`, so
each one applies the same check. An agent name is stricter still: `BaseAgent`
also rejects the reserved name `user`.

## Telling two nodes with the same name apart

`findStaticNodePath(root, target)` returns the chain of names from `root` down
to `target`, joined with `.`. It returns `undefined` when `target` is not
reachable from `root`.

```ts
import {BaseNode, findStaticNodePath, node} from '@google/adk';

class Team extends BaseNode {
  constructor(
    name: string,
    readonly children: BaseNode[],
  ) {
    super({name});
  }

  protected runImpl(): AsyncGenerator<never, void, void> {
    throw new Error('not executed');
  }
}

const workerA = node(() => 'a', {name: 'worker'});
const workerB = node(() => 'b', {name: 'worker'});
const root = new Team('root', [
  new Team('team_a', [workerA]),
  new Team('team_b', [workerB]),
]);

findStaticNodePath(root, workerA); // 'root.team_a.worker'
findStaticNodePath(root, workerB); // 'root.team_b.worker'
findStaticNodePath(
  root,
  node(() => 'c', {name: 'orphan'}),
); // undefined
```

adk-python's `find_static_node_path` joins with `/`. adk-js joins with `.`
because every path it emits is dot-separated, including `BranchPath` and the
node runner's `nodePath`.

The search reads a node's own properties and descends one container level: a
node held directly, or one inside an array, a `Set`, a `Map` or a plain object.
It tracks visited nodes by identity, so a child holding a back-reference to its
parent terminates.

## Output that survives the session store

`toSerializable(value)` flattens one value into plain data:

| Input                                         | Result                               |
| :-------------------------------------------- | :----------------------------------- |
| a primitive, a function                       | returned unchanged                   |
| a plain object or array needing no conversion | returned by identity                 |
| a `Set`                                       | an array                             |
| a `Map`                                       | a plain object with stringified keys |
| a value carrying `toJSON()`, such as a `Date` | the result of `toJSON()`             |
| any other class instance                      | a plain object of its own properties |

It never throws. A value it cannot flatten comes back unchanged, and a circular
structure terminates where the cycle closes.

`validateOutput` calls it on the result of a successful schema parse, so a
transform that builds a class instance still stores plain data:

```ts
import {node} from '@google/adk';
import {z} from 'zod';

class Tags {
  constructor(readonly values: string[]) {}
}

const tagged = node(() => ['a', 'b'], {
  name: 'tagged',
  outputSchema: z.array(z.string()).transform((v) => new Tags(v)),
});
// The event output is {values: ['a', 'b']}.
```

A node with no `outputSchema` is not touched. Its event carries the very object
the handler returned.

## Limitations

- `findStaticNodePath` does not descend a nested container, and it does not look
  inside a non-node wrapper. A node reachable only through a `Workflow`'s graph
  is therefore not found. adk-python has the same blind spot.
- The static path is built from names, so two sibling nodes sharing both a name
  and a parent are still indistinguishable.
- `toSerializable` runs only when an `outputSchema` is set. A node without one
  can still put a live object on its event.
