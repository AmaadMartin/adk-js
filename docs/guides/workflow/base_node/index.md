# BaseNode

`BaseNode` is the class every workflow node extends, agents included. It holds
the rules that apply to all of them: what a node may be named, where a node
sits in a tree, and what a node's output looks like by the time it reaches an
event.

## Introduction

A workflow is a graph of nodes, and three things about a node are decided by
the base class rather than by the node you wrote.

A node's **name** identifies it. It is the author on every event the node
emits, and it is a segment of the node's path, so a name with a space or a dot
in it produces an event stream that cannot be read back reliably. `BaseNode`
rejects such a name when you construct the node, rather than letting the
problem surface several events later.

A node's **path** places it in the tree. An event carries the path of the node
that produced it, with a run id on each segment, so two runs of the same node
have different paths. `findStaticNodePath` gives you the path without the run
ids, which is what you want when you are asking "which node in the graph is
this", not "which run of it". A name is not unique on its own: two
sub-workflows can each mount a node called `worker`.

A node's **output** is persisted. It lands on an `Event`, the event lands in
the session, and a resumed run replays it from there. A value that only exists
in memory does not survive that trip. When a node declares an `outputSchema`,
`BaseNode` flattens the validated value into plain data first.

## Get started

Nothing here needs configuration. Name a node, build a graph, and read a node's
static path:

```ts
import {findStaticNodePath, node, Workflow} from '@google/adk';

const draft = node(() => 'a draft', {name: 'draft'});
const review = node((_ctx, input: string) => `${input}, reviewed`, {
  name: 'review',
});

const workflow = new Workflow({
  name: 'writer',
  edges: [
    ['START', draft],
    [draft, review],
  ],
});

findStaticNodePath(workflow, workflow); // 'writer'
```

## Node names

A node name must be a valid identifier. It starts with a letter or an
underscore, and continues with letters, digits, underscores or hyphens:

```ts
node(() => 'ok', {name: 'summarize_draft'}); // fine
node(() => 'ok', {name: 'summarize-draft'}); // fine
node(() => 'ok', {name: 'summarize draft'}); // throws
```

The rule is Unicode: the first character is any `ID_Start` character, `$` or
`_`, and a later character may also be a digit, a `-` or a `$`. So `café` and
`日本語` pass, and an emoji does not.

The rejection names the value, so the fix is visible in the message:

```
Found invalid node name: "summarize draft". Node name must be a valid
identifier. It should start with a letter (a-z, A-Z) or an underscore (_),
and can only contain letters, digits (0-9), underscores, and hyphens.
```

An empty or blank name keeps its own message, `Node name must be a non-empty
string.`, because that case has a clearer cause.

This is the same rule agent names already obey, which is why an agent — itself
a node — passes it unchanged. An agent name is stricter in one way: `BaseAgent`
also rejects the reserved name `user`.

Two node kinds derive a default name from something else: `ToolNode` uses the
tool's name, and `node(fn)` uses the function's name. A tool whose name holds a
dot or a space is rejected here. Pass an explicit `name` in that case.

## Static node paths

`findStaticNodePath(root, target)` walks down from `root` and returns the chain
of node names to `target`, joined by `.`. It returns `undefined` when `target`
is not reachable.

Identity decides the match, not the name, so two nodes sharing a name resolve
to different paths:

```ts
import {BaseNode, findStaticNodePath} from '@google/adk';

class Team extends BaseNode {
  constructor(
    name: string,
    readonly members: BaseNode[] = [],
  ) {
    super({name});
  }

  protected async *runImpl() {
    yield `${this.name} reporting`;
  }
}

const workerA = new Team('worker');
const workerB = new Team('worker');
const root = new Team('root', [
  new Team('team_a', [workerA]),
  new Team('team_b', [workerB]),
]);

findStaticNodePath(root, workerA); // 'root.team_a.worker'
findStaticNodePath(root, workerB); // 'root.team_b.worker'
findStaticNodePath(root, new Team('orphan')); // undefined
```

adk-python's `find_static_node_path` joins with `/`. adk-js joins with `.`
because every path it emits is dot-separated, including `BranchPath` and the
node runner's `nodePath`.

Two limits are worth knowing. A node is discovered through the properties of
its parent, one container deep: a node held in an array, `Set`, `Map` or plain
object field is found, but a node nested two containers down is not. And a
`Workflow`'s nodes live on its `graph`, which is not itself a node, so
`findStaticNodePath` does not reach them. Both limits match adk-python, so a
path means the same thing in both languages.

The walk keeps a set of visited nodes, so a child holding a back-reference to
its parent terminates instead of recursing forever.

## Output serialization

A node that declares an `outputSchema` gets its validated output flattened into
plain data before it reaches the event:

```ts
import {node} from '@google/adk';
import {z} from 'zod';

const tagger = node(() => ({tags: new Set(['ts', 'workflow'])}), {
  name: 'tagger',
  outputSchema: z.object({tags: z.set(z.string())}),
});

// The event's output is {tags: ['ts', 'workflow']} — JSON data, so a resumed
// run replays it.
```

`toSerializable(value)` does the flattening:

| Input                                         | Result                               |
| :-------------------------------------------- | :----------------------------------- |
| a primitive, a function                       | returned unchanged                   |
| an array                                      | a new array of flattened items       |
| a `Set`                                       | an array                             |
| a `Map`                                       | a plain object with stringified keys |
| a value carrying `toJSON()`, such as a `Date` | the result of `toJSON()`             |
| a plain object, or any other class instance   | a plain object of its own properties |

The result is a new value, so do not rely on the event holding the object the
node yielded. A circular structure terminates: the reference that closes the
cycle comes back as it is. A `toJSON()` that throws leaves its own value
unflattened, and the rest of the tree is still flattened.

A node with no `outputSchema` is untouched: its output reaches the event
exactly as yielded, whatever its type. Genai `Content` is untouched too, with
or without a schema.

## Limitations

- `findStaticNodePath` does not descend a nested container, and it does not look
  inside a non-node wrapper. A node reachable only through a `Workflow`'s graph
  is therefore not found. adk-python has the same blind spot.
- The static path is built from names, so two sibling nodes sharing both a name
  and a parent are still indistinguishable.
- `toSerializable` runs only when an `outputSchema` is set. A node without one
  can still put a live object on its event.
