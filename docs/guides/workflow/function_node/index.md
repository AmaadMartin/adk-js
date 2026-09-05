# Function nodes and parameter binding

Any function, async function or generator can be a workflow node. Declare the
parameters it consumes and the framework reads them out of session state or out
of the upstream node's output, applies their defaults, and checks them before
the handler runs.

## Introduction

A function node's handler is called as `(ctx, input)`. Without a declaration,
`input` is the raw value the upstream node produced, and the handler reads
`ctx.state` by hand for anything else it needs.

Declaring `parameters` replaces the second argument with a bound arguments
object. That buys three things:

- **Defaults.** A parameter the source does not hold falls to the `default` its
  schema declares. A required parameter with no default raises a named error
  instead of arriving as `undefined`.
- **Checked values.** Each bound value is parsed by the Zod field that declares
  it, so a handler does not re-check what it was handed. The field itself does
  the work, so `z.coerce`, `.transform` and `.refine` all run.
- **One declaration.** In `'nodeInput'` mode the schema also becomes the node's
  `inputSchema`, so `NodeTool` can expose the node to a model without restating
  it.

ADK Python reads the parameter names, types and defaults off the function
signature with `inspect.signature`. TypeScript erases all three at runtime, so
adk-js takes them as an object schema — the same reason `FunctionTool` takes
one.

## Get started

Each declared key is read from `ctx.state`. This is the default,
`parameterBinding: 'state'`.

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

const setUp = (ctx: NodeContext) => {
  ctx.state.set('userName', 'Ada');
  return null;
};

export const rootAgent = new Workflow({
  name: 'greeter',
  edges: [
    [
      'START',
      node(setUp, {name: 'set_up'}),
      node(greet, {name: 'greet', parameters: greetParameters}),
    ],
  ],
});
```

`greet` receives `{userName: 'Ada', greeting: 'Hello'}`. Nothing wrote
`greeting`, so its declared default applies.

## Binding from the upstream node's output

Set `parameterBinding: 'nodeInput'` to read the parameters out of the object the
upstream node produced.

```ts
const addParameters = z.object({x: z.number(), y: z.number().default(10)});

const add = (_ctx: NodeContext, {x, y}: z.infer<typeof addParameters>) => x + y;

const addNode = node(add, {
  name: 'add',
  parameters: addParameters,
  parameterBinding: 'nodeInput',
});
```

The node's `inputSchema` becomes `addParameters`, so `new NodeTool(addNode)`
declares `x` and `y` to the model with no second declaration.

That schema is also enforced. `BaseNode.validateInput` checks the whole node
input against it before binding runs, so a node input that is not an object, or
one missing a required key, is rejected as a node input-schema failure rather
than reaching the per-parameter error below. ADK Python does not check it there:
its `input_schema` in this mode is a plain dictionary, which its validator
skips.

## The nodeInput parameter

In `'state'` mode the parameter named `nodeInput` is special: it receives the
raw node input rather than a state entry. This mirrors ADK Python's
`node_input`. Declaring it also gives the node an `inputSchema`, taken from that
one property.

```ts
const summarize = node(
  (_ctx: NodeContext, {nodeInput, style}: {nodeInput: string; style: string}) =>
    `[${style}] ${nodeInput}`,
  {
    name: 'summarize',
    parameters: z.object({
      nodeInput: z.string(),
      style: z.string().default('plain'),
    }),
  },
);
```

A `Content` reaching a parameter that expects a string is converted to its text
first, so the user's message from `START` arrives as a string. Non-text parts
are dropped and the framework logs one warning.

## Errors

| Condition                                        | Result                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| A required parameter has no value and no default | `Missing value for parameter "<p>" of function "<node>". It was not found in state and has no default value.` |
| A bound value fails its field schema             | `Invalid value for parameter "<p>" of function "<node>": <cause>`, with the validation failure on `cause`     |
| `authConfig` set without `rerunOnResume: true`   | Throws at construction                                                                                        |

An optional parameter with no default is left unbound, so the handler sees
`undefined`.

## Coercion

Zod does not coerce the way Pydantic does. Pydantic turns the string `'42'` into
the number `42`; a bare `z.number()` rejects it. Declare the coercion you want
and it runs, because the field you declared is the validator:

```ts
const parameters = z.object({count: z.coerce.number()});
// state {count: '42'} binds count as the number 42
```

## What is not checked

A parameter declared in a genai `Schema` rather than in Zod is checked only as
far as that schema compiles to a Zod type. A property Zod cannot express — a
pattern it cannot compile, say — passes its value through unchecked. That is
the same degradation `parseWithSchema` makes across ADK: refusing data because
the validator could not be built would reject values that are perfectly valid.

A Zod parameter is always checked by its own field, so this applies to the genai
dialect only.

A default is resolved once, when the node is built. A handler that mutates a
defaulted object therefore reaches the same object on the next run. ADK Python's
parameter defaults behave the same way.

## Configuring the node

`parameters` and `parameterBinding` are read when the node is built from its
function. `parameterBinding` does nothing on its own: without `parameters` there
is nothing to bind, and the handler keeps receiving the raw node input. They are not overridable through `node(existingNode, {...})`, because
the node compiles the parameters into descriptors and derives its `inputSchema`
from both keys at construction — grafting one onto a built node would leave it
binding one way and validating the other.

The node also takes its name from the wrapped function when you do not give one:

```ts
const classify = (_ctx: NodeContext, input: string) => input.length;

new FunctionNode(classify); // named 'classify'
```
