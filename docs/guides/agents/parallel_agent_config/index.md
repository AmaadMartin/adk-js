# ParallelAgent config documents

`parseParallelAgentYamlConfig` validates a `ParallelAgent` configuration
document. Reach for it when your code reads an agent config file and must know
whether the document is well formed before it acts on it.

## Introduction

ADK Python declares the YAML schema of a `ParallelAgent` as a pydantic model,
`ParallelAgentConfig`. The model forbids unknown keys, so a typo'd field name is
an error rather than a silently ignored line. ADK TypeScript had no counterpart,
so the same document passed through unchecked.

This module closes that gap. It ports the field set, the defaults and the strict
rejection of unknown keys, so both SDKs give the same verdict on the same
document. It validates a document; it does not build a `ParallelAgent` from one.
Construct the agent yourself from the validated fields.

A document on disk uses snake_case keys, which is the spelling ADK Python reads
and writes. `parseParallelAgentYamlConfig` converts the keys to camelCase before
it validates, so a document in either spelling produces the same result.

## Get started

Load the document, then validate it. Parsing the file is the caller's job, which
keeps the validator free of file system and format assumptions.

```ts
import {parseParallelAgentYamlConfig} from '@google/adk';

const config = parseParallelAgentYamlConfig({
  agent_class: 'ParallelAgent',
  name: 'research_fanout',
  description: 'Runs two researchers at once.',
  sub_agents: [
    {config_path: 'web_researcher.yaml'},
    {code: 'my_library.agents.paper_researcher'},
  ],
});

config.agentClass; // 'ParallelAgent'
config.name; // 'research_fanout'
config.subAgents; // [{configPath: 'web_researcher.yaml'}, {code: '...'}]
```

## Fields

| Key                    | Type         | Default           | Notes                                               |
| ---------------------- | ------------ | ----------------- | --------------------------------------------------- |
| `agentClass`           | `string`     | `'ParallelAgent'` | Identifies the agent class.                         |
| `name`                 | `string`     | required          | The name of the agent.                              |
| `description`          | `string`     | `''`              | The description of the agent.                       |
| `subAgents`            | `AgentRef[]` | absent            | Each entry sets `configPath` or `code`, never both. |
| `beforeAgentCallbacks` | `CodeRef[]`  | absent            | Each entry sets `name`, a fully qualified name.     |
| `afterAgentCallbacks`  | `CodeRef[]`  | absent            | Each entry sets `name`, a fully qualified name.     |

Any other key is an error, at the top level and inside every entry.

## Failures

`parseParallelAgentYamlConfig` throws `InputValidationError` when the document
does not validate. The message starts with `Invalid ParallelAgent config: ` and
lists every issue with its path.

```ts
import {InputValidationError, parseParallelAgentYamlConfig} from '@google/adk';

try {
  parseParallelAgentYamlConfig({name: 'a', sub_agent: []});
} catch (error: unknown) {
  if (error instanceof InputValidationError) {
    error.message; // Invalid ParallelAgent config: ✖ Unrecognized key: "subAgent"
  }
}
```

The key conversion runs before validation, so a message names the camelCase
spelling of the offending key. A file that writes `sub_agent:` is reported as
`Unrecognized key: "subAgent"`, as above. ADK Python names the key as written.

A sub-agent entry that sets both `code` and `config_path` reports `Only one of
\`code\` or \`config_path\` should be provided`. An entry that sets neither
reports `Exactly one of \`code\` or \`config_path\` must be provided`. Both
messages match ADK Python word for word.

To collect the issues instead of catching an exception, validate against the
schema directly. That path skips the key conversion, so give it camelCase keys.

```ts
import {parallelAgentYamlConfigSchema} from '@google/adk';

const result = parallelAgentYamlConfigSchema.safeParse({name: 42});
result.success; // false
```

## Feature gate and deprecation

The surface sits behind the experimental `AGENT_CONFIG` feature, which is on by
default. Disable it with `ADK_DISABLE_AGENT_CONFIG=1`, or with
`overrideFeatureEnabled(FeatureName.AGENT_CONFIG, false)`, and the call throws
`Feature AGENT_CONFIG is not enabled.`

The first call logs a deprecation warning, once per process. ADK Python
deprecated `ParallelAgentConfig`, and this port carries that deprecation
forward.
