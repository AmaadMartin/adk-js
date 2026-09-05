# AutoTracingPlugin

`AutoTracingPlugin` opens an OpenTelemetry span for every function your agent can reach, and records the call's arguments and its result on that span. Reach for it when the framework's own spans tell you that a tool took four seconds, but not which of your helpers spent them.

## Introduction

ADK already traces its own boundaries: `invoke_agent`, `execute_tool` and `call_llm`. Those spans stop where your code starts. A tool that reads a file, normalizes a record and calls a pricing helper is one `execute_tool` span, whatever happens inside it.

This plugin closes that gap. On `beforeRunCallback` it walks the object graph reachable from the invocation's agent and replaces each function it finds with a wrapper. Calling a wrapped function opens a span named after it and writes four kinds of attribute:

| Attribute           | Written when                                            |
| :------------------ | :------------------------------------------------------ |
| `adk.fn.arg.<name>` | Per recorded argument, unless the name marks it secret. |
| `adk.fn.return`     | The call returned.                                      |
| `adk.fn.exc_type`   | The call threw. Holds the error's constructor name.     |
| `adk.fn.exc_repr`   | The call threw. Holds the rendered error.               |

**The plugin mutates the objects and prototypes it reaches, process-wide.** That is what instrumentation is, and it is what adk-python's `AutoTracingPlugin` does, but it is worth stating plainly: a class the agent reaches stays wrapped for the life of the process, for every other user of that class too. Constructing the plugin is not enough to do this; the first `beforeRunCallback` is.

Two neighbours are worth knowing about:

- **`core/src/telemetry/tracing.ts`** produces the framework's boundary spans under the `gen_ai.*` conventions. The `adk.fn.*` namespace here is deliberately separate, so you can drop these spans at the collector without losing the framework's.
- **`LoggingPlugin`** logs the same lifecycle points to the console. It observes ADK's callbacks; this plugin observes your own functions.

## Get started

```typescript
import {App, AutoTracingPlugin, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'pricing_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer pricing questions.',
  tools: [convertTool],
});

export const app = new App({
  name: 'pricing',
  rootAgent: agent,
  plugins: [new AutoTracingPlugin()],
});
```

The plugin needs a tracer that records. If no tracer provider is registered, `trace.getTracer` hands back one that never records, the plugin detects that in its constructor, and it instruments nothing at all.

With a console exporter registered, a call to a wrapped `Rates.lookup(currency)` prints:

```text
name: 'Rates.lookup',
attributes: { 'adk.fn.arg.currency': "'EUR'", 'adk.fn.return': '0.92' }
```

A runnable version is in [`samples/plugins/auto_tracing/agent.ts`](../../../../samples/plugins/auto_tracing/agent.ts). It wires the console exporter and runs offline:

```bash
npm run sample -- samples/plugins/auto_tracing/agent.ts
```

The CLI bundles and minifies the file it runs, so the sample prints shortened owner and parameter names. See the two limits at the end of the next-but-one section.

## Credentials never reach a span

A span attribute goes to a third-party trace backend, so redaction here is a correctness requirement rather than hardening. Two rules run, and both are always on.

**By name.** A parameter or field whose name marks it as secret is masked. The name is folded to snake case first, so `accessToken`, `access-token` and `access_token` match the same rule. A `_token` suffix matches, a substring does not, so `refresh_token` is a secret and `tokenizer`, `user_token_count` and `authorization_url` are not.

**By shape.** adk-js declares its credential types as interfaces, which are erased at run time, so a value is matched on structure instead. A value shaped like an `AuthCredential`, `ServiceAccountCredential`, `ServiceAccount`, `HttpAuth`, `HttpCredentials` or `OAuth2Auth` is replaced wholesale by `<Name>`, wherever it sits.

A **top-level argument** with a secret name is dropped from the span entirely. A secret **nested inside** a recorded value is masked in place, so the shape of the traced value is still reported. Calling a wrapped `login(user, token)` records the user and nothing else:

```text
name: 'login',
attributes: { 'adk.fn.arg.user': "'alice'", 'adk.fn.return': "'alice'" }
```

A returned `{accessToken, rows}` keeps its shape and loses only the token: `{accessToken: <String>, rows: [1]}`.

The renderer is bounded three ways: nesting depth, a node budget, and a cycle set. A value that hits a bound is elided to `<Name ...>` rather than rendered, and a rendering that throws elides the whole value the same way. A bound can therefore never uncover a secret. A class instance is summarized from its **public** fields only; its own `toString` is never consulted, because it may print private state.

### The one case the name rule cannot cover

The name rule needs a name. Each parameter is read on its own, so a default value, a rest parameter or a destructuring pattern on one of them costs only that one its name — and a rest parameter names every argument it collects, so `...credentials` masks all of them. But two things still erase a name, and where a name is gone only shape masking is left:

- a **destructured** parameter, which declares no name at all;
- a **minified** build, which renames parameters to single letters.

An argument with no name is recorded as `arg0`, `arg1` and so on, and no `arg<i>` matches the secret table. A bare scalar secret in such a position is written to the span in full. Its fields are still masked if it is an object, and it is still masked wholesale if it is credential-shaped — but a lone token string in a destructured or minified position is not. Name the parameter, or keep the secret inside an object, if the trace leaves your process.

## What gets instrumented

The walk starts at `invocationContext.agent`, plus any object in `extraTargets`. From each root it descends through arrays, `Map` values, `Set` members and public data properties, and it wraps:

- a function held on a reachable object, under its own name;
- a function on the prototype of a reachable object, under `Owner.method`.

It deliberately does not touch:

- **accessor properties.** The walk reads property _descriptors_, so a getter never fires during discovery.
- **methods the runtime owns.** Every prototype reachable from a global, plus the iterator and generator prototypes, stops the prototype chain. The set is derived from the runtime rather than listed, because a list would miss `URL.prototype` or the async generator prototype, and wrapping one of those changes every value in the process.
- **class constructors**, symbol-keyed methods, and names starting with `_`.
- **anything already wrapped.** The marker is `Symbol.for('adk.auto_tracing.wrapped')`, taken from the global symbol registry so that two copies of `@google/adk` in one runtime agree. A second pass, or a second plugin, re-wraps nothing.

A wrapped function is observationally identical to the original: same return value, same thrown error, same yields in the same order, the same `name`, the same arity, and any property attached to it. A generator's yields all pass through; only the sample recorded on the span is capped. Failing to wrap one property is logged at debug level and never aborts the pass.

Two limits are worth knowing before you read a trace:

- **A bundler renames parameters.** `esbuild` keeps function names, so span names survive a build, but parameter names do not. An argument whose name is lost is recorded as `arg0`, `arg1` and so on, which also costs it the name-based redaction described above.
- **The reach is the object graph, not the module.** adk-python rebinds module attributes through `sys.modules`. ES module bindings are immutable and there is no writable registry of loaded modules, so a function that no reachable object holds is not instrumented. Pass it in `extraTargets` if you need it.

## Configuration options

| Option              | Type                | Default               | Description                                                                                           |
| :------------------ | :------------------ | :-------------------- | :---------------------------------------------------------------------------------------------------- |
| `name`              | `string`            | `'AutoTracingPlugin'` | Plugin instance identifier.                                                                           |
| `tracer`            | `Tracer`            | the ADK tracer        | Tracer the spans are opened on.                                                                       |
| `extraTargets`      | `readonly object[]` | `[]`                  | Extra roots to walk, for objects the agent does not reach.                                            |
| `maxReprLen`        | `number`            | `4096`                | Length cap on a rendered value. Past it, the text is truncated and `...[<n> more chars]` is appended. |
| `maxRecordedYields` | `number`            | `16`                  | How many of a generator's yields are sampled into `adk.fn.return`.                                    |
| `maxWalkDepth`      | `number`            | `30`                  | How deep the walk descends from each root.                                                            |

The walk also stops after 10,000 objects. That bound is not an option: an agent's object graph reaches the whole framework, and an unbounded walk in a long-running process is a leak.

## Differences from adk-python

Recorded here because they are visible in a trace:

- **A generator's span does not parent the work inside it.** The sync and async wrappers open their span with `startActiveSpan`, so anything they call nests under it. A generator suspends at every `yield`, and a span cannot stay context-active across that suspension without leaking the context into the consumer's frame, so the generator wrappers open a plain span instead. Spans created inside a generator body therefore land beside it, not under it — and if the generator is the outermost call, in a different trace.
- Rendered values follow JavaScript, not Python: `true` rather than `True`, `{a: 1}` rather than `{'a': 1}`, `<Array ...>` rather than `<list ...>` for an elided value.
- There are no keyword arguments. A trailing options object is recorded as one argument, with its secret-named fields masked in place.
- `__slots__` has no analogue, so the helpers that read it are not ported.
- The reference decides whether a value is a credential by class name over the MRO. That is impossible against erased interfaces, hence the structural match described above.
