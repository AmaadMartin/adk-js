# Validating a LoopAgent config document

`parseLoopAgentYamlConfig` checks a `LoopAgent` configuration document and
returns it as a typed object. Reach for it when an operator, a template or a
pipeline writes the document, and you want a clear error before the value
reaches your code.

## Introduction

A configuration document describes a `LoopAgent` in data: its name, its
description, how many times it repeats, its sub-agents and its callbacks.
ADK Python declares that shape as `LoopAgentConfig` and validates it field by
field. This module ports the same shape to TypeScript, so a document written
for one SDK is checked the same way by the other.

The schema rejects an unknown key. A misspelled `max_iteration` is an error,
not a silently ignored line. This is the main reason to validate a document
instead of casting it.

Two names for one thing exist in adk-js, so keep them apart. `LoopAgentConfig`
is the constructor options of a `LoopAgent`: you pass it to `new`. The symbols
here carry a `Yaml` infix because they describe a document on disk.

This module validates a document. It does not build an agent from one. adk-js
has no `fromConfig` hook yet, so you construct the `LoopAgent` yourself from the
validated fields.

## Get started

Read the document, parse its YAML, then validate it.

```yaml
# refinement_loop.yaml
agent_class: LoopAgent
name: RefinementLoopAgent
description: Refines a draft until the critic is satisfied.
max_iterations: 5
sub_agents:
  - config_path: critic_agent.yaml
  - config_path: refiner_agent.yaml
before_agent_callbacks:
  - name: my_library.callbacks.beforeAgentCallback
```

```ts
import {parseLoopAgentYamlConfig} from '@google/adk';
import {load} from 'js-yaml';
import {readFileSync} from 'node:fs';

const config = parseLoopAgentYamlConfig(
  load(readFileSync('refinement_loop.yaml', 'utf8')),
);

config.agentClass; // 'LoopAgent'
config.name; // 'RefinementLoopAgent'
config.maxIterations; // 5
config.subAgents; // [{configPath: 'critic_agent.yaml'}, …]
```

## Field names

A document on disk uses snake_case, matching ADK Python. The parsed config uses
camelCase, matching the rest of adk-js. Both spellings are accepted on input,
and the camelCase spelling is what comes back.

| Field                    | Required | Default       |
| ------------------------ | -------- | ------------- |
| `agent_class`            | no       | `'LoopAgent'` |
| `name`                   | yes      | —             |
| `description`            | no       | `''`          |
| `max_iterations`         | no       | absent        |
| `sub_agents`             | no       | absent        |
| `before_agent_callbacks` | no       | absent        |
| `after_agent_callbacks`  | no       | absent        |

`agent_class` is a plain string, so a fully qualified name such as
`google.adk.agents.LoopAgent` is kept verbatim.

`max_iterations` must be an integer. `'5'` and `1.5` are both rejected.
`0` is a valid value and survives the round trip, so the caller can tell it
apart from an absent key.

An omitted list stays absent rather than becoming `[]`. That keeps "no
callbacks declared" distinguishable from "an empty list of callbacks".

Each entry of `sub_agents` names exactly one of `config_path` or `code`.
Neither, or both, is an error. Each callback entry carries a `name`, the fully
qualified name of the function to call.

## Failure modes

`parseLoopAgentYamlConfig` throws `InputValidationError` when the document does
not satisfy the schema. The message starts with `Invalid LoopAgent config: `,
followed by the failing fields.

An empty file loads as `null`, and `null` is rejected like any other non-object.
So are a string, an array and a number.

## Deprecation and the feature gate

ADK Python marks `LoopAgentConfig` deprecated: it loads config by reflection
now, so the separate class is going away. The first call to
`parseLoopAgentYamlConfig` logs that warning once per process.

The module sits behind the experimental `AGENT_CONFIG` feature, which is on by
default. Turning it off makes the parse throw
`Feature AGENT_CONFIG is not enabled.`:

```bash
ADK_DISABLE_AGENT_CONFIG=1
```
