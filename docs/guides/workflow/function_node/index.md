# Function Nodes

Any function, async function, or generator can be a workflow node. `node()`
wraps it as a `FunctionNode`, so a graph step is a function rather than a class.

## Introduction

A function node is the lightest way to put logic in a workflow. The handler
takes the execution context and the upstream node's output, and returns a value,
a genai `Content`, or an `Event`.

Reading everything the step needs out of `ctx.state` by hand gets repetitive,
and nothing checks the types. Declaring the parameters instead makes the node
say what it consumes: each declared key is read from its source, validated
against its own schema, and filled from its default when the source has no
value. A missing required value fails at the node rather than as `undefined`
somewhere downstream.

TypeScript erases types and cannot read parameter names at runtime, so the
parameters are declared as a Zod or genai object schema. This is the same idiom
`FunctionTool` uses. adk-python reads the same information from the function
signature; the behaviour matches, the declaration does not.

## Get started

```ts
import {node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

const greetParameters = z.object({
  userName: z.string(),
  greeting: z.string().default('Hello'),
});

const greet = (
  _ctx: NodeContext,
  {userName, greeting}: z.infer<typeof greetParameters>,
) => `${greeting}, ${userName}!`;

export const rootAgent = new Workflow({
  name: 'greeter',
  edges: [['START', node(greet, {name: 'greet', parameters: greetParameters})]],
});
```

`userName` is read from `ctx.state`. `greeting` is read from `ctx.state` too,
and falls back to `'Hello'` when the key is absent.

## Where parameters come from

`parameterBinding` chooses the source. It defaults to `'state'`.

### `'state'` — read from session state

Each declared parameter is read from `ctx.state` by its own name. One name is
special: `nodeInput` receives the upstream node's output verbatim.

```ts
const summarizeParameters = z.object({
  nodeInput: z.string(),
  tone: z.string().default('neutral'),
});
```

### `'nodeInput'` — read from the upstream output

Each declared parameter is read from the upstream node's output object. A node
input that is not an object binds nothing, so every parameter falls back to its
default or fails.

```ts
const addParameters = z.object({x: z.number(), y: z.number().default(10)});

const add = node(
  (_ctx: NodeContext, {x, y}: z.infer<typeof addParameters>) => x + y,
  {name: 'add', parameterBinding: 'nodeInput', parameters: addParameters},
);
```

This mode also sets the node's `inputSchema` from `parameters`, which is what
lets an agent call the node as a tool:

```ts
import {NodeTool} from '@google/adk';

const tool = new NodeTool(add); // `x` and `y` become the tool's parameters.
```

In `'state'` mode, a declared `nodeInput` parameter supplies the `inputSchema`
instead. An `inputSchema` you set yourself is never overwritten.

## Validation and coercion

A bound value is checked against its own field schema before the handler runs.

- A value that does not match its schema fails with
  `Invalid value for parameter "<name>" of function "<node>"`, keeping the
  schema error as the `cause`.
- A required parameter with no value and no default fails with
  `Missing value for parameter "<name>" of function "<node>"`.
- A genai `Content` reaching a string parameter is converted to the joined text
  of its parts. Non-text parts are dropped and logged as a warning. This is how
  the user's first message reaches a string parameter on the first node.
- A field whose schema has no Zod equivalent passes its value through unchecked
  rather than failing.

Zod does not widen types the way Pydantic does. `'42'` is rejected by
`z.number()`; use `z.coerce.number()` if you want the conversion.

## Output schemas stay explicit

adk-python infers `outputSchema` from the return type hint. TypeScript keeps no
return type at runtime, so set it yourself:

```ts
node(produce, {name: 'produce', outputSchema: z.object({name: z.string()})});
```

## Authentication

A node with an `authConfig` must also set `rerunOnResume: true`. The node has to
run again once the credential arrives, otherwise the handler never sees it. The
constructor rejects the combination rather than failing silently at run time.

```ts
node(fetchData, {name: 'fetch', authConfig, rerunOnResume: true});
```
