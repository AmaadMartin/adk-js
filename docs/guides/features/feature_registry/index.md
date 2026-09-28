# Feature flags

ADK gates behaviour that is not yet stable behind named feature flags. You turn
a flag on or off with the `ADK_ENABLE_<NAME>` and `ADK_DISABLE_<NAME>`
environment variables, or from TypeScript. `FeatureName` enumerates the flags,
`isFeatureEnabled` reads one, and `overrideFeatureEnabled` sets one.

## Introduction

You usually meet the registry because a warning appeared in your logs:

```
[EXPERIMENTAL] feature PROGRESSIVE_SSE_STREAMING is enabled.
```

The message says you are using a feature that works but whose API may still
change. Nothing is wrong, and ADK prints it once per flag per process.

The registry exists so ADK can ship a feature to the people who want it without
changing behaviour for everyone else. Each flag carries a default and one of
three lifecycle stages.

- **Stable** features are on and silent.
- **Experimental** features work, but the API may change. They may be on or off
  by default, and they warn once when they resolve to enabled.
- **Work in progress** features are off. They warn in the same way if you turn
  one on.

The flag set matches the Python SDK, so a flag you read about in the ADK
documentation has the same name and the same default here. A flag whose feature
has not been ported to TypeScript yet is still declared, so the name resolves
and the environment variable behaves the same way.

## Get started

Turn a feature on for a whole process with an environment variable, before you
start it:

```shell
export ADK_ENABLE_SNAKE_CASE_SKILL_NAME=1
```

Or turn one off:

```shell
export ADK_DISABLE_PROGRESSIVE_SSE_STREAMING=1
```

The variable name is `ADK_ENABLE_` or `ADK_DISABLE_` followed by the flag name,
spelled exactly as the `FeatureName` member is. Only the values `1` and `true`
count, and the comparison ignores case. Any other value, `0`, `yes` and `on`
included, reads as unset, so resolution falls through to the next rule instead
of forcing the flag off.

Where an environment variable is awkward, set the flag from TypeScript. Do it
before you construct anything that reads it:

```ts
import {
  FeatureName,
  isFeatureEnabled,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.SNAKE_CASE_SKILL_NAME, true);

isFeatureEnabled(FeatureName.SNAKE_CASE_SKILL_NAME); // true
```

`FeatureName` is a string enum, so `Object.values(FeatureName)` lists the flags
the installed version declares. The set changes between releases, so read it
from the version you have rather than from a document.

## How resolution works

`isFeatureEnabled` answers in three steps and stops at the first one that
applies.

1. **A programmatic override.** If `overrideFeatureEnabled` has set a value for
   this flag, that value wins outright.
2. **Environment variables.** `ADK_ENABLE_<NAME>` is read first and returns
   `true` when set. `ADK_DISABLE_<NAME>` is read next and returns `false`.
   Setting both means enable wins.
3. **The registry default.** Each flag carries a stage and a default, and that
   default is the answer.

Nothing is cached. Every call re-reads the override map and `process.env`, so
changing a variable inside a running process does take effect. Whether that
helps depends on when the flag is read, and that varies by feature. Some read it
on every call, some once when an object is constructed.

`ADK_DISABLE_X=1` cannot switch off a flag that an override has turned on, so a
library that calls `overrideFeatureEnabled` takes the decision away from whoever
deploys it. Pass `undefined` to give it back:

```ts
overrideFeatureEnabled(FeatureName.SNAKE_CASE_SKILL_NAME, undefined);
```

## Scope a flag to one block of work

`withTemporaryFeatureOverride` applies an override for the duration of a
callback and restores the previous state afterwards, including when the callback
throws:

```ts
import {FeatureName, withTemporaryFeatureOverride} from '@google/adk';

await withTemporaryFeatureOverride(
  FeatureName.PROGRESSIVE_SSE_STREAMING,
  false,
  async () => {
    // Code in here sees the flag as off.
  },
);
```

Use it in a test rather than a bare `overrideFeatureEnabled`, which stays in
effect for the rest of the process and leaks into the tests that follow.

## Reading and registering

`getFeatureConfig` returns the stage and default of a flag, or `undefined` when
the name is not registered:

```ts
import {FeatureName, getFeatureConfig} from '@google/adk';

getFeatureConfig(FeatureName.PROGRESSIVE_SSE_STREAMING);
// {stage: FeatureStage.EXPERIMENTAL, defaultOn: true}
```

`registerFeature` adds or replaces an entry. `defaultOn` is optional and
defaults to `false`:

```ts
import {FeatureName, FeatureStage, registerFeature} from '@google/adk';

registerFeature('MY_FEATURE' as FeatureName, {stage: FeatureStage.WIP});
```

## Failure modes

- `isFeatureEnabled`, `overrideFeatureEnabled` and
  `withTemporaryFeatureOverride` throw `Feature <name> is not registered.` for a
  name that is not in the registry. A `FeatureName` member is always registered,
  so this only happens for a bare string.
- `getFeatureConfig` never throws. It returns `undefined` instead.

## Limitations

- **`ADK_ENABLE_X=0` does not disable.** Only `1` and `true` read as set, so `0`
  reads as unset and resolution falls through to the registry default. Use
  `ADK_DISABLE_X=1` to turn something off.
- **The flag set is not stable across releases.** Members are added and removed
  as features graduate. A variable naming a flag that no longer exists is
  ignored, with no warning and no error.
- **When a flag is read is feature-specific.** Setting a variable after the
  object that reads it exists may have no effect.
- **The warning has no per-flag switch.** It goes through the ADK logger at the
  `warn` level, so silencing it means raising the log level or installing your
  own logger with `setLogger`.
