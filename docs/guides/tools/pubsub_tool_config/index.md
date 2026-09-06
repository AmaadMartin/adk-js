# Pub/Sub tool config

Names the Google Cloud project that the Pub/Sub tools operate on. Reach for it
when the project you want is not the one your credentials resolve to.

## Introduction

`PubSubToolConfig` is the configuration surface for the Pub/Sub tools. It
carries one optional field, `projectId`. The config holds data only. It opens no
connection, reads no credentials and starts no network call.

You build the config with `createPubSubToolConfig` rather than an object
literal. The factory validates its input and returns a fresh object, so a later
change to the object you passed in cannot reach a config you already built.

The factory also checks the `PUBSUB_TOOL_CONFIG` feature flag. The flag is
experimental and on by default, which matches adk-python. Disabling it makes the
factory throw, so an operator can switch the surface off without a code change.

## Get started

```ts
import {createPubSubToolConfig} from '@google/adk';

// Pin the Pub/Sub operations to one project.
const config = createPubSubToolConfig({projectId: 'my-project'});
config.projectId; // 'my-project'

// Or let the environment decide.
const inferred = createPubSubToolConfig();
inferred.projectId; // undefined
```

## The projectId field

`projectId` is optional. When you leave it out, the project is inferred from the
environment or from the credentials, which is the usual setup on Google Cloud.
Set it when one process talks to a project other than the one its Application
Default Credentials resolve to.

## Unknown keys are rejected

The factory rejects any key it does not know, and it rejects a `projectId` that
is not a string. Both raise an `InputValidationError`. This mirrors the
`extra='forbid'` setting on the adk-python model, and it catches a typo in a
config that arrives from JSON or YAML at the point it enters your code.

The two SDKs disagree on the spelling, and the disagreement is deliberate.
adk-python accepts `project_id`, because that is the Python convention. adk-js
accepts `projectId` and rejects `project_id`:

```ts
import {createPubSubToolConfig} from '@google/adk';

createPubSubToolConfig(JSON.parse('{"project_id": "my-project"}'));
// InputValidationError: Invalid PubSubToolConfig: ...
```

## Turning the feature off

Two switches disable the feature. The environment variable
`ADK_DISABLE_PUBSUB_TOOL_CONFIG` works from outside the process:

```bash
ADK_DISABLE_PUBSUB_TOOL_CONFIG=true node app.js
```

`overrideFeatureEnabled` works from inside it, and takes priority over the
environment:

```ts
import {
  FeatureName,
  createPubSubToolConfig,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.PUBSUB_TOOL_CONFIG, false);

createPubSubToolConfig();
// Error: Feature PUBSUB_TOOL_CONFIG is not enabled.
```

Pass `undefined` as the second argument to clear the override.
