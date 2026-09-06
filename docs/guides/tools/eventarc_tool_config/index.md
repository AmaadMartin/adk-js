# EventarcToolConfig

`EventarcToolConfig` holds the two settings an Eventarc tool needs: the project
it reports against, and how long a publish call may run. Reach for it when you
write a tool that publishes CloudEvents through Eventarc.

## Introduction

Eventarc publishing needs a small amount of configuration that is not part of
any single call. A tool needs a project id for telemetry and for the API
endpoint it addresses. It also needs an upper bound on a publish call, so a
stalled request fails instead of holding the agent turn open.

`EventarcToolConfig` carries exactly those two settings and nothing else. It is
inert data: it makes no network call, reads no file, and mints no credential.
Authentication is a separate concern and is not part of this configuration.

You build the configuration with `createEventarcToolConfig`, not with a
constructor. The factory validates its input at run time, fills the timeout
default, and returns a fresh object. That matters because the realistic source
of a bad value is a parsed JSON document, which TypeScript cannot check.

adk-js does not yet ship an Eventarc toolset, so today you read the
configuration inside a tool you write yourself. This mirrors
`integrations/eventarc/_config.py` in adk-python.

## Get started

```ts
import {createEventarcToolConfig} from '@google/adk';

const config = createEventarcToolConfig({projectId: 'my-project'});

config.projectId; // 'my-project'
config.publishTimeout; // 15
```

Both fields are optional. Call the factory with no arguments and you get an
unset project and the default timeout.

```ts
createEventarcToolConfig(); // {projectId: undefined, publishTimeout: 15}
```

## The publish timeout

`publishTimeout` is a number of **seconds**, and it defaults to
`EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS`, which is `15`. The unit matches
adk-python's `publish_timeout` field.

```ts
import {
  EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS,
  createEventarcToolConfig,
} from '@google/adk';

EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS; // 15

const slow = createEventarcToolConfig({publishTimeout: 30});
slow.publishTimeout; // 30
```

Client libraries usually want milliseconds. `google-gax` takes
`CallOptions.timeout` in milliseconds, so a caller multiplies by 1000. The
factory applies no range check, because the reference model applies none
either.

## Validation

The factory throws `InputValidationError` when a field has the wrong type. The
message starts with `Invalid EventarcToolConfig:`.

```ts
import {InputValidationError, createEventarcToolConfig} from '@google/adk';

try {
  createEventarcToolConfig(JSON.parse('{"projectId": 123}'));
} catch (error) {
  error instanceof InputValidationError; // true
}
```

An unknown key is accepted and dropped rather than rejected. This follows
pydantic's default `extra='ignore'` on the reference model. One consequence is
worth knowing: adk-js spells the field `projectId`, so the snake_case
`project_id` is an unknown key and leaves `projectId` unset.

```ts
createEventarcToolConfig(JSON.parse('{"region": "us-central1"}'));
// {projectId: undefined, publishTimeout: 15}

createEventarcToolConfig(JSON.parse('{"project_id": "my-project"}'));
// {projectId: undefined, publishTimeout: 15}
```

The returned object is always fresh. Mutating it never changes the object you
passed in.

## The feature gate

`EVENTARC_TOOL_CONFIG` is an experimental feature and is on by default. The
registry logs one warning per process the first time you use it.

The factory checks the gate before it validates the input, so a disabled
feature reports itself rather than reporting a value it never read.

```ts
import {
  FeatureName,
  createEventarcToolConfig,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.EVENTARC_TOOL_CONFIG, false);

createEventarcToolConfig();
// throws Error: Feature EVENTARC_TOOL_CONFIG is not enabled.
```

Setting `ADK_DISABLE_EVENTARC_TOOL_CONFIG=true` has the same effect. Pass
`undefined` to `overrideFeatureEnabled` to drop a programmatic override.

## How this maps to adk-python

| adk-python                                        | adk-js                                       |
| ------------------------------------------------- | -------------------------------------------- |
| `EventarcToolConfig(project_id=...)`              | `createEventarcToolConfig({projectId: ...})` |
| `project_id`                                      | `projectId`                                  |
| `publish_timeout` (seconds, `15.0`)               | `publishTimeout` (seconds, `15`)             |
| `pydantic.ValidationError`                        | `InputValidationError`                       |
| `@experimental(FeatureName.EVENTARC_TOOL_CONFIG)` | `isFeatureEnabled` check in the factory      |

One behaviour differs. pydantic's lax mode coerces the string `"15"` to `15.0`
for a float field; this port rejects it, because no adk-js configuration
accepts a string for a numeric option.
