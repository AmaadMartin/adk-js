# GCS tool settings

Declares what the Cloud Storage tools may do. Reach for it when you want an
agent to read objects and buckets, but not to create or delete them.

## Introduction

`GcsToolSettings` is the configuration surface the Cloud Storage tools read. It
carries one field, `capabilities`. The settings hold data only. They open no
connection and read no credentials.

The field is a list of `GcsCapabilities` members. `READ_ONLY` permits the read
tools. `READ_WRITE` permits the read tools and the write tools as well, so you
do not have to name both members. A list holding neither member permits
nothing.

You build the settings with `createGcsToolSettings` rather than an object
literal. The factory applies the read-only default, so the object you get back
always has a `capabilities` array. Each call returns a fresh object and a fresh
array, so a caller who mutates one result cannot affect the next.

The factory also checks the `GCS_TOOL_SETTINGS` feature flag. The flag is
experimental and on by default, which matches adk-python. Disabling it makes the
factory throw, so an operator can switch the surface off without a code change.

No Cloud Storage toolset in adk-js reads these settings yet. Use
`allowsGcsRead` and `allowsGcsWrite` to apply the rule in your own code until a
toolset lands.

## Get started

```ts
import {
  GcsCapabilities,
  allowsGcsRead,
  allowsGcsWrite,
  createGcsToolSettings,
} from '@google/adk';

const settings = createGcsToolSettings();
settings.capabilities; // ['read_only']
allowsGcsRead(settings); // true
allowsGcsWrite(settings); // false

const readWrite = createGcsToolSettings({
  capabilities: [GcsCapabilities.READ_WRITE],
});
allowsGcsRead(readWrite); // true
allowsGcsWrite(readWrite); // true
```

## What each capability permits

`allowsGcsRead` returns true for `READ_ONLY` and for `READ_WRITE`. It covers the
tools that only read:

- `get_object_data`, `get_object_metadata` and `list_objects` on the storage
  toolset.
- `get_bucket` and `list_buckets` on the admin toolset.

`allowsGcsWrite` returns true for `READ_WRITE` alone. It covers the tools that
change or remove data:

- `create_object` and `delete_objects` on the storage toolset.
- `create_bucket`, `update_bucket` and `delete_bucket` on the admin toolset.

These are the same two guards adk-python runs in `GCSToolset.get_tools` and
`GCSAdminToolset.get_tools`.

## The capability list

The factory stores the list you supply verbatim. It does not sort it, remove
duplicates, or add `READ_ONLY` alongside `READ_WRITE`. An empty list is a
decision, not a missing value, so the factory keeps it and both predicates
return false:

```ts
import {allowsGcsRead, createGcsToolSettings} from '@google/adk';

const locked = createGcsToolSettings({capabilities: []});
allowsGcsRead(locked); // false
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
