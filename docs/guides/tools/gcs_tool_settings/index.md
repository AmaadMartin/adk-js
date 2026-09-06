# GCS tool settings

Records what the Cloud Storage tools may do. Reach for it when you configure a
Cloud Storage tool and the read-only default does not suit your agent.

## Introduction

`GcsToolSettings` is the configuration surface for the Cloud Storage tools. It
carries one field, `capabilities`. The settings hold data only. They open no
connection and read no credentials.

The field is a list of `GcsCapabilities` members. `READ_ONLY` stands for read
operations, and `READ_WRITE` for read and write operations. adk-python's
toolsets read the list to decide which tools to expose.

You build the settings with `createGcsToolSettings` rather than an object
literal. The factory applies the read-only default, so the object you get back
always has a `capabilities` array. Each call returns a fresh object and a fresh
array, so a caller who mutates one result cannot affect the next.

The factory also checks the `GCS_TOOL_SETTINGS` feature flag. The flag is
experimental and on by default, which matches adk-python. Disabling it makes the
factory throw, so an operator can switch the surface off without a code change.

No Cloud Storage toolset in adk-js reads these settings yet, so nothing here
enforces a capability. This module carries the configuration surface only.

## Get started

```ts
import {GcsCapabilities, createGcsToolSettings} from '@google/adk';

const settings = createGcsToolSettings();
settings.capabilities; // ['read_only']

const readWrite = createGcsToolSettings({
  capabilities: [GcsCapabilities.READ_WRITE],
});
readWrite.capabilities; // ['read_write']
```

## The capability list

The factory stores the list you supply verbatim. It does not sort it, remove
duplicates, or add `READ_ONLY` alongside `READ_WRITE`. An empty list is a
decision, not a missing value, so the factory keeps it:

```ts
import {createGcsToolSettings} from '@google/adk';

const locked = createGcsToolSettings({capabilities: []});
locked.capabilities; // []
```

Only an absent or `undefined` `capabilities` field takes the read-only default.

## Turning the feature off

Two switches disable the feature. The environment variable
`ADK_DISABLE_GCS_TOOL_SETTINGS` works from outside the process:

```bash
ADK_DISABLE_GCS_TOOL_SETTINGS=true node app.js
```

`overrideFeatureEnabled` works from inside it, and takes priority over the
environment:

```ts
import {
  FeatureName,
  createGcsToolSettings,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS, false);

createGcsToolSettings();
// Error: Feature GCS_TOOL_SETTINGS is not enabled.
```

Pass `undefined` as the second argument to clear the override.
