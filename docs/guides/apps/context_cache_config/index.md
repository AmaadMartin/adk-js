# ContextCacheConfig

`ContextCacheConfig` describes how an app reuses a Gemini context cache: how
many invocations one cache serves, how long it lives, and how large a request
must be before caching is worth it. Reach for it when you plan to enable
context caching and want the settings in one validated value.

## Introduction

A long conversation resends the same system instruction, the same tool
declarations, and a growing history on every turn. A context cache lets the
model keep that prefix on the server, so later requests pay for it once instead
of every time. Caching is not free, though: the cache has storage cost and a
lifetime, so a good setup depends on three numbers rather than a single switch.

`ContextCacheConfig` holds those three numbers. `cacheIntervals` bounds how
many invocations reuse one cache before it is refreshed, `ttlSeconds` bounds how
long the cache lives, and `minTokens` sets the request size below which caching
is skipped. The values and their bounds match adk-python's
`ContextCacheConfig`, so the same tuning transfers between the two SDKs.

The config is a plain value object. adk-js does not perform context caching
yet, so nothing reads it today: it is the unit the Gemini cache manager will
consume when that lands. Build it now if you are porting a configuration from
adk-python or writing your own caching layer on top of ADK.

WARNING: This feature is experimental. Its API or behavior may change in a
future release.

## Get started

`createContextCacheConfig` fills in every field, so the result never has holes.

```ts
import {createContextCacheConfig} from '@google/adk';

const config = createContextCacheConfig();
// {cacheIntervals: 10, ttlSeconds: 1800, minTokens: 0}
```

Pass only the fields you want to change. The rest keep their defaults.

```ts
import {createContextCacheConfig} from '@google/adk';

const production = createContextCacheConfig({
  cacheIntervals: 20,
  ttlSeconds: 7200,
  minTokens: 2048,
});
```

## Fields

| Field            | Type     | Default | Bounds           | Description                                                                                                                                         |
| ---------------- | -------- | ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cacheIntervals` | `number` | `10`    | `1` to `100`     | Maximum number of invocations to reuse the same cache before refreshing it.                                                                         |
| `ttlSeconds`     | `number` | `1800`  | greater than `0` | Time-to-live for cache in seconds.                                                                                                                  |
| `minTokens`      | `number` | `0`     | `0` or more      | Minimum estimated request tokens required to enable caching. Set it higher to skip small requests, where the cache overhead can exceed the benefit. |

Every field is required on the `ContextCacheConfig` interface. Optionality
lives in the factory parameter, which takes a `Partial<ContextCacheConfig>`.

## Validation

The factory validates each field and throws a plain `Error` naming the field
and the bound it broke.

```ts
import {createContextCacheConfig} from '@google/adk';

createContextCacheConfig({cacheIntervals: 0}); // cacheIntervals must be greater than or equal to 1.
createContextCacheConfig({cacheIntervals: 101}); // cacheIntervals must be less than or equal to 100.
createContextCacheConfig({ttlSeconds: 0}); // ttlSeconds must be greater than 0.
createContextCacheConfig({minTokens: -1}); // minTokens must be greater than or equal to 0.
```

All three fields must be integers. adk-python declares them as `int`, so
pydantic rejects a fractional value; TypeScript `number` does not, and a
fractional time-to-live would reach the cache API as `"1.5s"`. The integer
check runs before the range check, so `{cacheIntervals: 0.5}` reports the
integer error.

```ts
createContextCacheConfig({ttlSeconds: 1.5}); // ttlSeconds must be an integer.
```

`Number.isInteger` also rejects `NaN` and `Infinity`.

An unknown key is a compile error rather than a runtime one, because
`Partial<ContextCacheConfig>` triggers excess-property checking on an object
literal. This is the TypeScript counterpart of adk-python's
`extra="forbid"`.

```ts
createContextCacheConfig({cacheIntervals: 10, bogus: 1});
// error TS2353: Object literal may only specify known properties.
```

## Formatting helpers

`contextCacheTtlString` renders the time-to-live in the duration format the
Gemini cache-creation API accepts.

```ts
import {contextCacheTtlString, createContextCacheConfig} from '@google/adk';

contextCacheTtlString(createContextCacheConfig()); // '1800s'
```

`formatContextCacheConfig` renders the whole config as one log line. The field
names inside the string stay snake_case, so an adk-js log line matches the
adk-python one it is compared against.

```ts
import {createContextCacheConfig, formatContextCacheConfig} from '@google/adk';

formatContextCacheConfig(createContextCacheConfig());
// 'ContextCacheConfig(cache_intervals=10, ttl=1800s, min_tokens=0)'
```

## Limitations

- **No consumer yet.** adk-js has no context cache manager and no request
  processor that reads this config, and `App` has no `contextCacheConfig`
  field. Building a config changes no runtime behavior today.
- **Three fields only.** adk-python's default branch has since added a
  `createHttpOptions` field that only its cache manager reads. This port
  matches the v2.0.0 field set.
