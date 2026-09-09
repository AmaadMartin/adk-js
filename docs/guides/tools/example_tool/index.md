# ExampleTool.fromConfig

Builds an `ExampleTool` from a plain configuration record. Reach for it when the
few-shot examples come from a file rather than from a constructor call.

## Introduction

`ExampleTool` adds few-shot examples to every LLM request. The constructor takes
either the examples themselves or a `BaseExampleProvider` that returns examples
for a query. Both are objects, so a configuration file cannot express the second
one.

`fromConfig` closes that gap. It reads a record whose `examples` field is either
a list of examples or a **fully-qualified name**, and it resolves that name to a
provider your code exports. The method mirrors `ExampleTool.from_config` in
adk-python, so an agent definition means the same thing in both SDKs.

Two things differ from adk-python, because JavaScript loads modules differently
from Python. `fromConfig` is asynchronous, since `import()` is. And a name is
written `<module specifier>#<export>` instead of splitting on the last dot: a
JavaScript specifier contains dots of its own, so `./providers.js` would
otherwise resolve to module `./providers` and export `js`.

## Get started

Export a provider from your own module.

```ts
// my_examples.ts
import {BaseExampleProvider, Example} from '@google/adk';

class CustomerSupportProvider extends BaseExampleProvider {
  override getExamples(_query: string): Example[] {
    return [
      {
        input: {parts: [{text: 'How do I reset my password?'}]},
        output: [
          {role: 'model', parts: [{text: 'Open Settings, then Security.'}]},
        ],
      },
    ];
  }
}

export const customerSupportProvider = new CustomerSupportProvider();
```

Name it from the configuration, and give `fromConfig` the absolute path of the
file the configuration came from.

```ts
import {ExampleTool} from '@google/adk';

const tool = await ExampleTool.fromConfig(
  {examples: './my_examples.js#customerSupportProvider'},
  '/abs/path/to/root_agent.yaml',
);
```

Supplying the examples inline needs no module at all.

```ts
const tool = await ExampleTool.fromConfig(
  {
    examples: [
      {
        input: {parts: [{text: 'What is 2+2?'}]},
        output: [{role: 'model', parts: [{text: '4'}]}],
      },
    ],
  },
  '/abs/path/to/root_agent.yaml',
);
```

## Writing a fully-qualified name

A name has two parts, separated by `#`.

| Name                               | Module                           | Export     |
| ---------------------------------- | -------------------------------- | ---------- |
| `./my_examples.js#provider`        | the file next to the config file | `provider` |
| `/srv/agents/examples.js#provider` | that absolute path               | `provider` |
| `my-package/examples#provider`     | the installed package            | `provider` |
| `./my_examples.js`                 | the file next to the config file | `default`  |

A relative specifier resolves against the directory of the second argument, so
the path in a config file is read the way a person writing that file expects. An
absolute or bare specifier ignores it and resolves the way `import()` normally
does.

## Failure modes

Importing a named module runs that module's top-level code, so trust a name as
far as you trust the file it came from. Node built-in modules are refused, so a
configuration file cannot reach `node:child_process`.

| Configuration                                                        | Error                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| A name that resolves to something other than a `BaseExampleProvider` | `ToolExecutionError`, error type `BAD_REQUEST`               |
| `examples` that is neither a name nor a list of examples             | `ToolExecutionError`, error type `BAD_REQUEST`               |
| A module that fails to load, or that has no such export              | `InputValidationError`, with the load failure as its `cause` |
| A Node built-in module                                               | `InputValidationError`, with the refusal as its `cause`      |

`fromConfig` either returns a usable tool or throws. It never returns a tool
that is half-configured.
