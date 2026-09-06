# AutoTracingPlugin

`AutoTracingPlugin` replaces every public function an agent can reach with a
wrapper that opens an OpenTelemetry span, records the call's arguments and its
result, and closes the span. Reach for it when you want call-level traces
without editing the functions themselves.

## Introduction

ADK already traces the framework: an agent invocation, a tool call, an LLM
call. Those spans stop at the tool boundary. When a tool calls three helpers
and one of them is slow, the trace says only that the tool was slow.

`AutoTracingPlugin` closes that gap. On `beforeRunCallback` it walks the object
graph reachable from `invocationContext.agent`, finds the public functions, and
rebinds each one to a tracing wrapper. Your code is unchanged; the spans appear
because the property now holds a different function.

That mechanism has a cost you have to accept before you use it. **The plugin
mutates the objects and prototypes it reaches, process-wide, for the life of
the process.** A class the agent reaches stays wrapped for every other user of
that class, and there is no way to undo it. Use it in development, in a
debugging session, or in a process that serves only instrumented work. Do not
add it to a shared process and expect the rest of that process to be
unaffected.

It is opt-in and does nothing until you add it to an `App`. If no tracer
provider is registered, it does nothing at all.

## Get started

Register a tracer provider, then add the plugin.

```ts
import {
  App,
  AutoTracingPlugin,
  FunctionTool,
  LlmAgent,
  maybeSetOtelProviders,
} from '@google/adk';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {z} from 'zod';

maybeSetOtelProviders([
  {spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())]},
]);

const cityFacts = {
  lookupCity(city: string): string {
    return cityFacts.format(city, 2_100_000);
  },
  format(city: string, population: number): string {
    return `${city} has about ${population} residents`;
  },
};

const lookupCity = new FunctionTool({
  name: 'lookup_city',
  description: 'Returns the population of a city.',
  parameters: z.object({city: z.string()}),
  execute: async ({city}) => ({summary: cityFacts.lookupCity(city)}),
});

const agent = new LlmAgent({
  name: 'auto_tracing_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about cities by calling lookup_city.',
  tools: [lookupCity],
});

export const app = new App({
  name: 'auto_tracing',
  rootAgent: agent,
  plugins: [new AutoTracingPlugin({extraTargets: [cityFacts]})],
});
```

A call to `cityFacts.lookupCity('Paris')` now emits a span named
`lookupCity` with these attributes:

| Attribute         | Value                                 |
| ----------------- | ------------------------------------- |
| `adk.fn.arg.city` | `"Paris"`                             |
| `adk.fn.return`   | `"Paris has about 2100000 residents"` |

The `format` span nests under it.

A span takes the bare function name because `cityFacts` is a plain object. A
method the plugin finds on a class prototype is named `Owner.method` instead,
after the class — `CityFacts.lookupCity` had the example used a class.

The runnable version is
[`samples/plugins/auto_tracing/agent.ts`](../../../../samples/plugins/auto_tracing/agent.ts).

**Register the provider first.** The plugin asks the tracer whether it records
when it is constructed. Constructing it before `maybeSetOtelProviders` runs
leaves it permanently disabled.

## What the plugin reaches

The walk starts at `invocationContext.agent` and at each `extraTargets` entry,
and from there:

- it wraps an object's own, enumerable, public function properties;
- it wraps the public methods declared by an object's class and by its base
  classes;
- it descends into arrays, `Map` values, `Set` members, and an object's own
  public data properties.

It does not reach a function that only a closure holds. That is why the example
above passes `cityFacts` as an `extraTarget`: the tool's `execute` closes over
it, and a closure has no properties to walk.

Three things are never wrapped. A runtime prototype such as
`Array.prototype`, because wrapping `map` would change every value in the
process. A class constructor, because the wrapper is an ordinary function and
`new` on it builds the wrong thing. A `_`-prefixed name, matching the
public-only rule.

The wrapper keeps the wrapped function's call semantics: the same arguments,
the same `this`, the same return value, the same thrown error, and the same
`name` and `length`. It follows the function's shape, so a generator stays a
generator and an async function stays an async function.

One return value does change. A plain function that returns a thenable is
awaited inside its span, because otherwise the span closes before the work
does, and the caller gets a `Promise` in place of the thenable. This is what
keeps an `async` function a compiler downlevelled into a plain function
correctly traced.

## Attributes

| Attribute           | When              | Holds                        |
| ------------------- | ----------------- | ---------------------------- |
| `adk.fn.arg.<name>` | always            | one recorded argument        |
| `adk.fn.return`     | the call returned | the return value             |
| `adk.fn.exc_type`   | the call threw    | the error's constructor name |
| `adk.fn.exc_repr`   | the call threw    | the rendered error           |

Argument names come from the function source, read once when the wrapper is
built. An argument the parser cannot name is recorded as `arg<index>`.

A generator records a sample of what it yielded rather than the values
themselves, because the span has to close at a bounded size:

```
<generator: 100 items yielded; first 16: [0, 1, 2, ...] ... + 84 more>
```

## Credentials

Anything the plugin writes to a span is masked first, two ways.

**By name.** An argument whose name marks it as secret is dropped outright, so
no `adk.fn.arg.apiKey` attribute exists at all. A field nested inside a
recorded value is masked in place, so `{apiKey: <String>}` still shows the
shape. The names are matched case-insensitively as endings, which covers
`api_key`, `apiKey` and `serviceApiKey` alike.

**By type.** A value whose class, or one of its base classes, is named
`AuthCredential`, `OAuth2Auth`, `ServiceAccount` and so on renders as
`<AuthCredential>`.

The type check finds nothing in adk-js's own auth types, because
`AuthCredential` and its parts are TypeScript interfaces: their values are
plain objects at runtime and carry no class name. The name check is what
protects them, and it covers every secret-bearing field they declare. A
minifying bundler renames classes and defeats the type check for the same
reason; the name check survives, because parameter names survive in the
function source.

Rendering is bounded by depth, by a node budget, and by a cycle set. A subtree
the renderer refuses to enter is elided as `<Name ...>` rather than printed, so
reaching a bound can never uncover a secret. A rendering that throws part way
elides too.

## Options

| Option              | Type                | Default               |
| ------------------- | ------------------- | --------------------- |
| `name`              | `string`            | `'AutoTracingPlugin'` |
| `tracer`            | `Tracer`            | the global tracer     |
| `extraTargets`      | `readonly object[]` | `[]`                  |
| `maxReprLen`        | `number`            | `4096`                |
| `maxRecordedYields` | `number`            | `16`                  |
| `maxWalkDepth`      | `number`            | `30`                  |

- **`tracer`** defaults to `trace.getTracer('gcp.vertex.agent.auto_tracing')`,
  a scope of the plugin's own, so these spans are distinguishable from the
  framework spans ADK emits on `gcp.vertex.agent`. The reference does the same,
  with `trace.get_tracer(__name__)`.
- **`extraTargets`** adds roots the agent graph does not reach.
- **`maxReprLen`** caps one rendered value. A longer one is cut and marked
  `...[N more chars]`.
- **`maxRecordedYields`** caps how many yielded items a generator's span
  samples. The true count is always reported.
- **`maxWalkDepth`** caps how far the walk follows references from a root. A
  separate node budget caps how many objects one pass may visit, so a wide
  graph terminates too.

## Differences from adk-python

adk-python enumerates `sys.modules` by name prefix and rebinds module-level
functions. Node has no registry of loaded modules to enumerate, and a module
namespace object is sealed, so this port keeps the behaviour and drops the
mechanism: it wraps what the walk reaches. `extra_scope_prefixes`, a tuple of
module-name prefixes, becomes `extraTargets`, a list of objects.

Two guards exist only here. Runtime prototypes are excluded, and the walk has a
node budget, because a JavaScript object graph reachable from an agent is far
larger than the set of module names the reference collects.

That difference cuts the other way too, and it is the reason to keep the scope
in mind. The reference only ever touches modules whose names the agent graph
implies, so a third-party library stays untouched unless you name it. This walk
follows object references, so a client object an agent holds puts that
library's prototypes in scope as well.

A generator's span is not made the active span. Keeping an OpenTelemetry
context active across a `yield` means taking over the iteration protocol, which
would drop the source generator's own cleanup, so spans opened inside a wrapped
generator body are siblings of it rather than children. The reference gets the
nesting for free from `start_as_current_span`. Every other wrapper shape does
nest correctly.
