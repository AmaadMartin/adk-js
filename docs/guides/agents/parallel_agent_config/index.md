# Validating a ParallelAgent config document

`parseParallelAgentYamlConfig` checks a `ParallelAgent` configuration document
and returns it as a typed object. Reach for it when an operator, a template or
a pipeline writes the document, and you want a clear error before the value
reaches your code.

## Introduction

A configuration document describes a `ParallelAgent` in data: its name, its
description, its sub-agents and its callbacks. adk-python declares that shape
as `ParallelAgentConfig` and validates it field by field. This module ports the
same shape to TypeScript, so a document written for one SDK is checked the same
way by the other.

The schema rejects an unknown key. A misspelled `sub_agent` is an error, not a
silently ignored line. This is the main reason to validate a document instead
of casting it.

Two names for one thing exist in adk-js, so keep them apart. `BaseAgentConfig`
and `LoopAgentConfig` are constructor options: you pass them to `new`. The
symbols here carry a `Yaml` infix because they describe a document on disk.

This module validates a document. It does not build an agent from one. adk-js
has no `fromConfig` hook yet, so you construct the `ParallelAgent` yourself
from the validated fields.

## Get started

Read the document, parse its YAML, then validate it.

```yaml
# code_pipeline.yaml
agent_class: ParallelAgent
name: CodePipelineAgent
description: Runs a code writer and a code reviewer side by side.
sub_agents:
  - config_path: code_writer.yaml
  - config_path: code_reviewer.yaml
before_agent_callbacks:
  - name: my_library.security_callbacks.beforeAgentCallback
```

```ts
import {parseParallelAgentYamlConfig} from '@google/adk';
import {readFileSync} from 'node:fs';
import {load} from 'js-yaml';

const config = parseParallelAgentYamlConfig(
  load(readFileSync('code_pipeline.yaml', 'utf8')),
);

config.agentClass; // 'ParallelAgent'
config.name; // 'CodePipelineAgent'
config.subAgents; // [{configPath: 'code_writer.yaml'}, …]
```

## Field names

A document on disk uses snake_case, matching adk-python. The parsed config uses
camelCase, matching the rest of adk-js. Both spellings are accepted on input,
and the camelCase spelling is what comes back.

| Field                    | Required | Default           |
| ------------------------ | -------- | ----------------- |
| `agent_class`            | no       | `'ParallelAgent'` |
| `name`                   | yes      | —                 |
| `description`            | no       | `''`              |
| `sub_agents`             | no       | absent            |
| `before_agent_callbacks` | no       | absent            |
| `after_agent_callbacks`  | no       | absent            |

`agent_class` is a plain string, so a fully qualified name such as
`google.adk.agents.ParallelAgent` is kept verbatim.

An omitted list stays absent rather than becoming `[]`. That keeps "no
callbacks declared" distinguishable from "an empty list of callbacks".

Each entry of `sub_agents` names exactly one of `config_path` or `code`.
Neither, or both, is an error. Each callback entry carries a `name`, the fully
qualified name of the function to call.

## Failure modes

`parseParallelAgentYamlConfig` throws `InputValidationError` when the document
does not satisfy the schema. The message starts with
`Invalid ParallelAgent config: `, followed by the failing fields.

An empty file loads as `null`, and `null` is rejected like any other
non-object. So are a string, an array and a number.

## Deprecation and the feature gate

adk-python marks `ParallelAgentConfig` deprecated: it loads config by
reflection now, so the separate class is going away. The first call to
`parseParallelAgentYamlConfig` logs that warning once per process.

The module sits behind the experimental `AGENT_CONFIG` feature, which is on by
default. Turning it off makes the parse throw
`Feature AGENT_CONFIG is not enabled.`:

```bash
ADK_DISABLE_AGENT_CONFIG=1
```
