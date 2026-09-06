# ToolConfig

`ToolConfig` is the declarative vocabulary a configuration file uses to name a
tool. Reach for it when a host loads tools from YAML or JSON instead of
constructing them in TypeScript.

## Introduction

A tool declaration arrives from a file, so the type system never sees it. A
misspelled key is therefore a typo, not an extension point, and dropping it in
silence gives the author a tool that runs with the wrong settings and no error.
`createToolConfig` validates the declaration at load time and throws
`InputValidationError` on the first problem it finds.

The module splits the declaration in two. The top level is strict: only `name`
and `args` are allowed. The `args` bag is free: its shape is whatever the
tool's own constructor accepts, so no key is rejected and no key is renamed.

adk-js has no configuration-file loader yet. `createToolConfig` validates the
declaration and carries `name` verbatim; the host that consumes the config
resolves that name to a tool.

## Get started

```ts
import {createToolConfig} from '@google/adk';
import yaml from 'js-yaml';

const declared = yaml.load(`
name: VertexAiSearchTool
args:
  searchEngineId: projects/p/locations/l/collections/c/engines/e
  maxResults: 10
`);

const config = createToolConfig(declared);
// config.name is 'VertexAiSearchTool'
// config.args is {searchEngineId: '...', maxResults: 10}
```

A typo fails at load time rather than at run time:

```ts
createToolConfig({name: 'google_search', arg: {}});
// InputValidationError: ToolConfig received unknown key(s): arg.
```

## Tool reference forms

`name` addresses the tool. There are five supported forms.

1. An ADK built-in tool instance or class, referenced by its bare name and
   optionally with `args`.

```yaml
tools:
  - name: google_search
  - name: AgentTool
    args:
      agent: ./another_agent.yaml
      skipSummarization: true
```

2. A user-defined tool instance. `name` is the fully qualified path to the
   instance.

```yaml
tools:
  - name: my_package.my_module.myTool
```

3. A user-defined tool class. `name` is the fully qualified path to the class,
   and `args` are the arguments for the tool.

```yaml
tools:
  - name: my_package.my_module.MyToolClass
    args:
      myToolArg1: value1
      myToolArg2: value2
```

4. A user-defined function that returns a tool instance. `name` is the fully
   qualified path to the function, and `args` are passed to it.

```yaml
tools:
  - name: my_package.my_module.myToolFunction
    args:
      myFunctionArg1: value1
```

The function must have this signature:

```ts
(args: ToolArgsConfig) => BaseTool | Promise<BaseTool>;
```

5. A user-defined function tool. `name` is the fully qualified path to the
   function.

```yaml
tools:
  - name: my_package.my_module.myFunctionTool
```

The arg keys are camelCase, because `args` reaches an adk-js constructor.

## Validation rules

| Declaration                       | Result                                 |
| --------------------------------- | -------------------------------------- |
| not an object, or `null`          | throws, `must be a non-null object`    |
| a key other than `name` or `args` | throws, naming every offending key     |
| `name` missing                    | throws, `` `name` is required ``       |
| `name` not a string               | throws, `` `name` must be a string ``  |
| `name: ''`                        | accepted                               |
| `args` omitted, or `args: null`   | `args` is `undefined`                  |
| `args: {}`                        | `args` is `{}`                         |
| `args` not an object              | throws, `` `args` must be an object `` |

Only the top level is key-checked. `args` and everything nested inside it pass
through untouched, and `args` is shallow-copied, so the returned config never
aliases the object you passed in.

This surface is experimental and can change.
