# FunctionTool parameters and the sync-callable runner

`FunctionTool` wraps a function and exposes it to the model. This guide covers
the two ways it learns what parameters the function takes, and how a host keeps
a blocking tool body off the event loop.

## Introduction

A tool tells the model what arguments it accepts through a function
declaration. `FunctionTool` builds that declaration from `parameters` when you
supply one, and from the signature of `execute` when you do not.

Supply `parameters` whenever you can. A Zod object or a genai `Schema` carries
types, descriptions and constraints, and ADK validates the model's arguments
against it before `execute` runs. Signature derivation carries none of that: it
recovers the parameter names and which of them have defaults, and nothing else.
It exists so that a tool written without a schema is still callable, instead of
advertising no parameters at all.

Derivation reads `Function.prototype.toString()`, so it only works when the
first parameter of `execute` is an object-destructuring pattern. TypeScript
erases parameter types before the program runs, so every derived property gets
the type `TYPE_UNSPECIFIED`. That is the same type adk-python emits for a Python
parameter with no annotation.

## Get started

A tool with no `parameters` whose `execute` destructures its first argument:

```ts
import {FunctionTool} from '@google/adk';

const forecast = new FunctionTool({
  name: 'forecast',
  description: 'Looks up a forecast.',
  execute: ({city, days = 3}) => `${city} for ${days} days`,
});

forecast._getDeclaration().parameters;
// {
//   type: 'OBJECT',
//   properties: {
//     city: {type: 'TYPE_UNSPECIFIED'},
//     days: {type: 'TYPE_UNSPECIFIED'},
//   },
//   required: ['city'],
// }
```

A parameter with a default is optional; every other one is required. Without a
schema, `execute` receives the model's argument object as
`Record<string, unknown>`, so each destructured value is `unknown`.

The same tool with an explicit schema is better: the model gets types and
descriptions, and `execute` gets typed arguments.

```ts
import {FunctionTool} from '@google/adk';
import {z} from 'zod/v4';

const forecast = new FunctionTool({
  name: 'forecast',
  description: 'Looks up a forecast.',
  parameters: z.object({
    city: z.string().describe('The city to look up.'),
    days: z.number().default(3).describe('How many days to report.'),
  }),
  execute: ({city, days}) => `${city} for ${days} days`,
});
```

## What derivation reads

`parameters` always wins. Derivation runs only when you omit it, and it runs
once, in the constructor.

| `execute` signature   | Derived declaration                         |
| --------------------- | ------------------------------------------- |
| `({a, b}) => …`       | `a` and `b`, both required                  |
| `({a, b = 2}) => …`   | `a` and `b`, only `a` required              |
| `({a: alpha}) => …`   | `a` — the source key, not the local binding |
| `({a, ...rest}) => …` | `a` only; a rest element is not a property  |
| `(input) => …`        | no properties                               |

The parser refuses anything it cannot read with certainty — a computed key
(`{[key]: value}`), a bound function, a parameter that is not a destructuring
pattern. In that case the tool declares `{type: OBJECT, properties: {}}`, which
is what it declared before derivation existed.

Bundling is safe for the node builds: object destructuring keeps the source key
and renames only the binding, so `({city, days = 3}, ctx)` minifies to
`({city:o,days:t=3},c)`. The browser build targets older engines, and esbuild
lowers a rest element (`...rest`) there into a helper call, which removes the
pattern from the parameter list. A tool that uses a rest element and no
`parameters` therefore declares no properties in the browser bundle. Supply
`parameters` if that matters to you.

## Keeping a blocking tool body off the event loop

A synchronous `execute` blocks the event loop for as long as it runs. A host
that wants to move such a body elsewhere binds a `SyncCallableRunner` around the
run:

```ts
import type {Event} from '@google/adk';
import {runWithSyncCallableRunner} from '@google/adk';

const events = await runWithSyncCallableRunner(
  async (call) => {
    await new Promise((resolve) => setImmediate(resolve));
    return call();
  },
  async () => {
    const collected: Event[] = [];
    for await (const event of runner.runAsync({
      userId,
      sessionId,
      newMessage,
    })) {
      collected.push(event);
    }
    return collected;
  },
);
```

The runner receives a thunk over the already-validated arguments and returns a
promise for the result. Argument validation, the confirmation gate and error
wrapping all stay on the caller's loop; only the function body goes through the
runner.

Consume the event stream inside the callback, as above. The binding covers the
callback and the calls it makes, so a run you only start inside it does not
keep the binding once the callback returns.

Three guarantees hold:

- An `async` or async-generator `execute` never goes through the runner. It
  already yields to the loop, so there is nothing to offload.
- The binding is cleared around the offloaded call, so a tool called from
  inside an offloaded body runs inline rather than offloading again.
- With no runner bound, `execute` runs inline, exactly as it did before.

A runner that rejects surfaces through the tool's normal error path, as
`Error in tool '<name>': <message>`.
