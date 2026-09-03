# CacheMetadata

`CacheMetadata` describes the context cache that served an LLM response. Reach
for it when you track a cache across invocations: to decide whether to refresh
the cache, to detect that the cached content changed, or to log what the cache
did.

## Introduction

A context cache saves the model from re-reading the same system instruction,
tools and leading contents on every turn. Two facts decide what a caller does
next. The first is whether a cache exists at all. The second, when one exists,
is how long it has left.

`CacheMetadata` is a union of exactly those two states.

- **Active.** A cache exists. `cacheName`, `expireTime` and `invocationsUsed`
  are set alongside `fingerprint` and `contentsCount`.
- **Fingerprint-only.** No cache exists. Only `fingerprint` and `contentsCount`
  are set. The fingerprint still identifies the content prefix, so a caller can
  tell that the cacheable content changed.

The union rules out a half-populated record at compile time, so
`if (metadata.cacheName === undefined)` narrows to one state or the other.

Token counts do not live here. Read `cachedContentTokenCount` and the rest from
`LlmResponse.usageMetadata`, where the model reports them.

All timestamps in this module are Unix seconds, not milliseconds. `Date.now()`
returns milliseconds, so divide by 1000 before you compare a value against
`expireTime` yourself.

## Get started

`createCacheMetadata` validates the field values and freezes the result.

```typescript
import {
  createCacheMetadata,
  expireSoon,
  formatCacheMetadata,
} from '@google/adk';

const metadata = createCacheMetadata({
  cacheName: 'projects/123/locations/us-central1/cachedContents/456',
  expireTime: Date.now() / 1000 + 1800,
  fingerprint: 'abc123def456',
  invocationsUsed: 5,
  contentsCount: 3,
});

if (expireSoon(metadata)) {
  // Create a new cache before the next invocation.
}

const line = formatCacheMetadata(metadata);
// 'Cache 456: used 5 invocations, cached 3 contents, expires in 30.0min'
```

A fingerprint-only record needs two fields.

```typescript
const prefixOnly = createCacheMetadata({
  fingerprint: 'abc123def456',
  contentsCount: 3,
});

expireSoon(prefixOnly); // false: no cache, so nothing expires.
formatCacheMetadata(prefixOnly);
// Fingerprint-only: 3 contents, fingerprint=abc123de...
```

## Expiry

`expireSoon` allows a two-minute buffer for processing time. It returns `true`
once the current time passes `expireTime - 120`, so a caller that acts on it
still has time to build a replacement cache before the old one goes away. At
exactly `expireTime - 120` it returns `false`.

On a fingerprint-only record `expireSoon` returns `false`.

## Validation

`createCacheMetadata` throws an `Error` in three cases.

| Condition                                                      | Message                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `contentsCount` is negative or fractional                      | `contentsCount must be a non-negative integer.`                                                                          |
| `invocationsUsed` is negative or fractional                    | `invocationsUsed must be a non-negative integer.`                                                                        |
| `cacheName`, `expireTime` and `invocationsUsed` are partly set | `cacheName, expireTime and invocationsUsed must all be set (active cache) or all be undefined (fingerprint-only state).` |

The last check repeats at runtime what the union already guarantees at compile
time. It earns its place when a record arrives from outside the type system,
such as a metadata object parsed back out of serialized session JSON.

The factory copies each field by name, so an unknown key on the input is
dropped rather than carried onto the result. The returned object is frozen: an
assignment to one of its fields throws a `TypeError` in strict mode.

## Relationship to adk-python

This module ports `google.adk.models.cache_metadata.CacheMetadata`. Two
differences are deliberate.

- Python raises a pydantic `ValidationError`; this module throws a plain
  `Error` with the messages above, which is the convention in `core/src`.
- Python exposes `expire_soon` as a property and the log line through
  `__str__`. A TypeScript interface carries neither, so both are module-level
  functions.
