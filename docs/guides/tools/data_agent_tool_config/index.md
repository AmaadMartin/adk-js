# DataAgentToolConfig

`DataAgentToolConfig` holds the settings the Data Agent tools read: the row cap
on a query result, the Google Cloud location and API endpoint to call, and the
three settings that gate mutation of a data agent. Build one with
`createDataAgentToolConfig()`, which validates the input and fills the defaults.

## Introduction

A data agent lives in a Google Cloud region and answers questions about a
dataset. The tools that talk to it need three kinds of decision made before the
first call: where the agent is, how much of a query result to bring back, and
whether the tools may change the agent at all.

Those decisions do not belong in each tool call. A location argument on a single
call overrides the configured one, but the config is what a caller sets once for
a whole toolset. Splitting the settings into their own object also keeps the
read-only case explicit: `enableDataAgentModification` is `false` unless you ask
for it, so a toolset built from a default config cannot create, update or delete
a data agent.

`createDataAgentToolConfig()` is the only way to build one. It rejects an
unknown key, a value of the wrong type, and a non-positive mutation timer, so a
config parsed from a JSON or YAML document fails at the boundary rather than
inside a tool call. This mirrors adk-python's `DataAgentToolConfig`, a pydantic
model declared with `extra="forbid"`.

The consumer of this config, `DataAgentToolset`, is not in adk-js yet. The
config module lands first so the two ports stay reviewable on their own.

## Get started

```ts
import {createDataAgentToolConfig} from '@google/adk';

const config = createDataAgentToolConfig();

config.maxQueryResultRows; // 50
config.enableDataAgentModification; // false
config.location; // undefined
```

Name only the settings you want to change. The rest keep their defaults.

```ts
import {createDataAgentToolConfig} from '@google/adk';

const config = createDataAgentToolConfig({
  location: 'eu',
  maxQueryResultRows: 100,
  enableDataAgentModification: true,
  dataAgentModificationTimeoutSeconds: 120,
});
```

## Settings

| Setting                                    | Type      | Default |
| ------------------------------------------ | --------- | ------- |
| `maxQueryResultRows`                       | `number`  | `50`    |
| `location`                                 | `string`  | unset   |
| `apiEndpoint`                              | `string`  | unset   |
| `dataAgentModificationTimeoutSeconds`      | `number`  | `60`    |
| `dataAgentModificationPollIntervalSeconds` | `number`  | `2`     |
| `enableDataAgentModification`              | `boolean` | `false` |

`location` is the region of the data agent, such as `eu`, `us` or `global`. When
it is unset, a tool parses the region out of the data agent resource name and
falls back to `global`.

`apiEndpoint` overrides the Gemini Data Analytics endpoint, including the one
derived from `location`.

The two `dataAgentModification*Seconds` settings bound the wait after a create,
update or delete: the first is the total budget, the second is the gap between
two polls.

The three defaults are exported, so you can compare against them:

```ts
import {
  DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS,
  DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS,
  DEFAULT_MAX_QUERY_RESULT_ROWS,
} from '@google/adk';
```

## Validation

`createDataAgentToolConfig()` throws `InputValidationError` on invalid input. It
never returns a partly-built config.

```ts
import {createDataAgentToolConfig} from '@google/adk';

// Unknown key.
createDataAgentToolConfig(JSON.parse('{"region": "us-central1"}'));
// InputValidationError: Invalid DataAgentToolConfig: ...

// A non-positive mutation timer.
createDataAgentToolConfig({dataAgentModificationTimeoutSeconds: 0});
// InputValidationError: Invalid DataAgentToolConfig: ...
```

Three rules are easy to trip over:

- Keys are camelCase. `max_query_result_rows` is an unknown key and throws.
- There is no type coercion. `"true"` is not `true`, and `60.5` is not an
  integer.
- `null` is rejected. Omit a setting, or pass `undefined`. A config document
  serialized from an adk-python model carries `"location": null` and needs that
  key removed.

`maxQueryResultRows` has no lower bound: `0` and a negative value are stored as
given. adk-python places no constraint there either, and a tool substitutes its
own limit for such a value.

The returned object is a plain object, not a validated model. A later
`config.dataAgentModificationTimeoutSeconds = 0` is not checked again.
