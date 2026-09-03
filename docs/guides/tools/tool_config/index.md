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
`BaseToolConfig` and `validateToolConfigKeys` expose the strict half, so a
custom config type gets the same key checking.

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

`name` addresses the tool. An ADK built-in tool uses its bare name; a
user-defined tool uses the fully qualified path to the instance, the class, a
function that returns a tool, or a function tool.

```yaml
tools:
  - name: google_search
  - name: AgentTool
    args:
      agent: ./another_agent.yaml
      skipSummarization: true
  - name: my_package.my_module.myTool
  - name: my_package.my_module.MyToolClass
    args:
      myToolArg1: value1
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

## Custom tool configs

When the five reference forms do not suffice, declare your own config type and
reuse the same key checking. Type the allowlist as
`Record<keyof MyToolConfig, true>` so a new field fails to compile until it is
listed.

```ts
import {validateToolConfigKeys} from '@google/adk';
import type {BaseToolConfig} from '@google/adk';

type MyToolConfig = BaseToolConfig & {endpoint: string};

const MY_TOOL_CONFIG_KEYS: Record<keyof MyToolConfig, true> = {endpoint: true};

const config: MyToolConfig = {endpoint: 'https://example.test'};
validateToolConfigKeys(config, MY_TOOL_CONFIG_KEYS, 'MyToolConfig');

validateToolConfigKeys({typo: 1}, MY_TOOL_CONFIG_KEYS, 'MyToolConfig');
// InputValidationError: MyToolConfig received unknown key(s): typo.
```

This surface is experimental and can change.
