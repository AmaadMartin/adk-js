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
the two SDKs. `ContextCacheRequestProcessor` reads it off the invocation and
copies it onto the request; see the
[context cache carry-over guide](../../models/context_cache/index.md). adk-js
performs no caching yet, so nothing acts on the copied config.

Caching begins on the second turn of a session at the earliest. `minTokens`
gates on the previous request's measured prompt token count, so the first
request of a session has no count to compare. Gemini's own minimum applies on
top: 2048 tokens for Gemini 2.5, 4096 tokens for Gemini 3. A short or
single-turn session is therefore never cached.

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

- **No cache manager yet.** `ContextCacheRequestProcessor` reads this config,
  but no adk-js model acts on it, so building a config changes no model call
  today.
- **No public switch.** `App` has no `contextCacheConfig` field.
  `InvocationContext.contextCacheConfig` is the only way to set the policy.
- **Three fields only.** adk-python's default branch has since added a
  `createHttpOptions` field that only its cache manager reads. This port
  matches the v2.0.0 field set.
