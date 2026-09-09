# ContextCacheConfig

`ContextCacheConfig` describes how an app reuses a Gemini context cache: how
many invocations one cache serves, how long it lives, and how large a request
must be before caching is worth it.

## Introduction

A long conversation resends the same system instruction, the same tool
declarations, and a growing history on every turn. A context cache lets the
model keep that prefix on the server, so later requests pay for it once instead
of every time. Caching is not free, though: the cache has storage cost and a
lifetime, so a good setup depends on three numbers rather than a single switch.

`ContextCacheConfig` holds those three numbers, and its defaults and bounds
match adk-python's `ContextCacheConfig`, so the same tuning transfers between
the two SDKs. It is a plain value object: adk-js does not perform context
caching yet, so nothing reads it today. Build it if you are porting a
configuration from adk-python or writing your own caching layer on top of ADK.

WARNING: This feature is experimental. Its API or behavior may change in a
future release.

## Get started

`createContextCacheConfig` fills in every field, so the result never has holes.
Pass only the fields you want to change.

```ts
import {createContextCacheConfig} from '@google/adk';

createContextCacheConfig();
// {cacheIntervals: 10, ttlSeconds: 1800, minTokens: 0}

createContextCacheConfig({
  cacheIntervals: 20,
  ttlSeconds: 7200,
  minTokens: 2048,
});
```

## Validation

The factory throws a plain `Error` naming the field and the bound it broke.

```ts
createContextCacheConfig({cacheIntervals: 0}); // greater than or equal to 1.
createContextCacheConfig({cacheIntervals: 101}); // less than or equal to 100.
createContextCacheConfig({ttlSeconds: 0}); // greater than 0.
createContextCacheConfig({minTokens: -1}); // greater than or equal to 0.
createContextCacheConfig({ttlSeconds: 1.5}); // must be an integer.
```

All three fields must be integers. adk-python declares them as `int`, so
pydantic rejects a fractional value; TypeScript `number` does not. The integer
check runs before the range check, so `{cacheIntervals: 0.5}` reports the
integer error. `Number.isInteger` also rejects `NaN` and `Infinity`.

An unknown key is a compile error rather than a runtime one, which is the
TypeScript counterpart of adk-python's `extra="forbid"`.

```ts
createContextCacheConfig({cacheIntervals: 10, bogus: 1});
// error TS2353: Object literal may only specify known properties.
```

## Limitations

- **No consumer yet.** adk-js has no context cache manager and no request
  processor that reads this config, and `App` has no `contextCacheConfig`
  field. Building a config changes no runtime behavior today.
- **Three fields only.** adk-python's default branch has since added a
  `createHttpOptions` field that only its cache manager reads. This port
  matches the v2.0.0 field set.
