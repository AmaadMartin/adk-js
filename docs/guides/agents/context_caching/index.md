# Context caching

Context caching reuses a processed prefix of a request across turns, so a long
system instruction, a large tool set, or a long history is not re-processed on
every call. Reach for it when an agent sends the same large prefix on turn after
turn and you want to cut cost and response time.

## Introduction

An agent's request has two parts that behave very differently. The prefix — the
system instruction, the tool declarations, and the earlier turns — barely
changes between calls. The suffix — the newest user message — changes every
time. A model that supports context caching can keep the processed prefix and
charge you only for the suffix.

Deciding whether to reuse a cache is not something a request processor can do on
its own. It needs three facts that live in different places: the policy the app
set, the identity and age of the cache the previous turn used, and how large
that turn's prompt was. `ContextCacheRequestProcessor` collects all three onto
the `LlmRequest`, and the model layer decides from there whether to reuse,
refresh, or skip the cache.

The processor is inert unless the invocation carries a `ContextCacheConfig`. An
agent with no config produces exactly the request it produced before, so
enabling caching is opt-in and costs nothing when it is off.

`adk-js` does not yet ship a model-side cache manager, and neither `App` nor
`Runner` sets `contextCacheConfig` for you. Today the processor stages the
request fields and a caller supplies the config on the invocation context.

## Get started

There is nothing to switch on yet. `ContextCacheConfig` is staged on
`InvocationContext.contextCacheConfig`, and `App` and `Runner` will surface it
once the model-side cache manager lands. Until then no model reads the fields
the processor writes, so setting the config changes no request the model
answers.

## Configuration

| Field               | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `cacheIntervals`    | How many invocations may reuse one cache before it is refreshed.              |
| `ttlSeconds`        | How long the cache lives.                                                     |
| `minTokens`         | The estimated request size below which caching is not worth its storage cost. |
| `createHttpOptions` | HTTP options for the cache-creation call.                                     |

## What the processor writes

The processor walks the session backwards, skipping every event authored by
another agent, and stops as soon as it has both of the things it looks for.

- `cacheConfig` — the invocation's config, always set when one is present.
- `cacheMetadata` — a **copy** of the newest cache metadata this agent recorded.
  When that metadata describes a live cache and came from an earlier
  invocation, the copy's `invocationsUsed` is one higher, because this
  invocation is about to use it again. The session's own event is never
  modified.
- `cacheableContentsTokenCount` — the newest `usageMetadata.promptTokenCount`
  this agent recorded. The two values can come from different events.

`CacheMetadata` is a union of two states. A live cache carries `cacheName`,
`expireTime` and `invocationsUsed`; a fingerprint with no cache behind it
carries none of them. A half-populated record does not type-check.

## Failure modes

- An invocation that carries a config but no agent throws. Context caching is
  scoped to one agent's events, so there is nothing to scope to. An invocation
  with no config returns before that check and never throws.
- A session restored from storage is not type-checked. If it holds metadata
  with a `cacheName` but no `invocationsUsed`, the processor throws
  `Active cache metadata must include invocations_used.` rather than sending a
  request whose use count is wrong.
