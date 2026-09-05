# Bigtable tool settings

Caps how many rows a Bigtable query result returns. Reach for it when you
configure a Bigtable tool and the default cap of 50 rows does not suit your
agent.

## Introduction

`BigtableToolSettings` is the configuration surface the Bigtable tools read. It
carries one field, `maxQueryResultRows`. The settings hold data only. They open
no connection and read no credentials.

You build the settings with `createBigtableToolSettings` rather than an object
literal. The factory applies the default cap, so the object you get back always
has a `maxQueryResultRows` number. Each call returns a fresh object.

The factory also checks the `BIGTABLE_TOOL_SETTINGS` feature flag. The flag is
experimental and on by default, which matches adk-python. Disabling it makes the
factory throw, so an operator can switch the surface off without a code change.

## Get started

```ts
import {createBigtableToolSettings} from '@google/adk';

const settings = createBigtableToolSettings();
settings.maxQueryResultRows; // 50

const capped = createBigtableToolSettings({maxQueryResultRows: 10});
capped.maxQueryResultRows; // 10
```

## The row cap

The factory stores the value you supply verbatim, including `0` and negative
numbers. It does not clamp them. A Bigtable query tool substitutes its own limit
for a non-positive cap, so the decision stays with the tool that runs the query.

## Turning the feature off

Two switches disable the feature. The environment variable
`ADK_DISABLE_BIGTABLE_TOOL_SETTINGS` works from outside the process:

```bash
ADK_DISABLE_BIGTABLE_TOOL_SETTINGS=true node app.js
```

`overrideFeatureEnabled` works from inside it, and takes priority over the
environment:

```ts
import {
  FeatureName,
  createBigtableToolSettings,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.BIGTABLE_TOOL_SETTINGS, false);

createBigtableToolSettings();
// Error: Feature BIGTABLE_TOOL_SETTINGS is not enabled.
```

Pass `undefined` as the second argument to clear the override.
