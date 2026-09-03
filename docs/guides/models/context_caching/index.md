# Gemini context caching

`GeminiContextCacheManager` stores the stable prefix of a Gemini request in an
explicit Gemini cache and rewrites later requests to read from it. Reach for it
when an agent sends the same large system instruction, tool set, or history on
turn after turn, and you want to cut prompt cost and response time.

## Introduction

A request to a model has two parts that behave very differently. The prefix —
the system instruction, the tool declarations, and the earlier turns — barely
changes between calls. The suffix — the newest user message — changes every
time. Gemini can hold the processed prefix in an explicit cache, so a later
request sends only the suffix plus the cache name.

Deciding whether a cache still serves a request is the hard part, and it is what
this manager owns. It fingerprints the cacheable prefix, checks the fingerprint
and the expiry against the cache the previous turn used, deletes a cache that no
longer matches, and creates a replacement. `Gemini.generateContentAsync` calls
it once per turn, inside a `handle_context_caching` span, and copies the
resulting `CacheMetadata` onto the response it yields.

Two rules shape the lifecycle and are worth knowing before you enable it. A
cache is never created on the first turn: with no prior metadata the manager
records a fingerprint and nothing else, because it has no accurate token count
to size the cache with. And a cache is never shared across a different model,
backend, project, or location, because all of them are inside the fingerprint.

`ContextCacheConfig` is the policy, and something has to put it on the request.
On this branch nothing does — `ContextCacheRequestProcessor`, which reads the
policy off the app and the metadata off the session, is not here yet. Until it
lands, the caching block is inert unless you set `LlmRequest.cacheConfig`
yourself, as the example below does.

## Get started

Set the policy on the request and run two turns. The first turn fingerprints the
prefix. The second turn carries that fingerprint back, so the manager can create
a cache and point the request at it.

```typescript
import {
  CacheMetadata,
  ContextCacheConfig,
  Gemini,
  LlmRequest,
} from '@google/adk';

const cacheConfig: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 2048,
};

const gemini = new Gemini({model: 'gemini-2.5-flash'});

const llmRequest: LlmRequest = {
  model: 'gemini-2.5-flash',
  contents: [{role: 'user', parts: [{text: 'What is the weather in Paris?'}]}],
  config: {systemInstruction: 'You are a helpful assistant.'},
  liveConnectConfig: {},
  toolsDict: {},
  cacheConfig,
};

let cacheMetadata: CacheMetadata | undefined;
for await (const response of gemini.generateContentAsync(llmRequest)) {
  cacheMetadata = response.cacheMetadata ?? cacheMetadata;
}
```

The metadata on the response is the whole state of the chain. Put it on the next
request as `cacheMetadata`, together with the prompt token count of the turn
that produced it as `cacheableContentsTokenCount`, and the manager takes it from
there.

## Configuration

| Field               | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `cacheIntervals`    | How many invocations may reuse one cache before it is refreshed.            |
| `ttlSeconds`        | How long the cache lives.                                                   |
| `minTokens`         | The previous prompt size below which caching is not worth its storage cost. |
| `createHttpOptions` | HTTP options for the cache-creation call, for example a longer timeout.     |

## What the manager does with a request

`handleContextCaching` returns metadata on every path, and mutates the request
only when a cache serves it.

| Situation                                      | What the manager does                                               |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| No prior metadata                              | Records a fingerprint over the cacheable prefix. Creates nothing.   |
| The cache is live and still matches            | Points the request at the cache and returns a copy of the metadata. |
| The cache expired, but the prefix is unchanged | Deletes the old cache, grows the prefix, and creates a new cache.   |
| The prefix itself changed                      | Starts a new chain with a fingerprint over the current prefix.      |

When a cache is applied, the manager clears `config.systemInstruction`,
`config.tools` and `config.toolConfig`, sets `config.cachedContent`, and drops
the cached contents. The final content is always sent, because the API rejects a
request with no contents.

## Two states of `CacheMetadata`

`CacheMetadata` is a union of two states rather than one record with optional
fields.

- `ActiveCacheMetadata` has a `cacheName`, an `expireTime` and an
  `invocationsUsed`.
- `FingerprintCacheMetadata` has none of them, and types all three as
  `undefined`.

So `metadata.cacheName` is the discriminator, and a half-populated record does
not compile.

## Failure modes

Caching is an optimisation, so the manager never fails a turn to protect it.

- `caches.create` throwing is logged at `warn` and the turn proceeds uncached.
  The returned metadata keeps the grown prefix, so the next turn retries with
  the same prefix rather than shrinking it.
- `caches.delete` throwing is logged at `warn` and ignored.
- A prefix estimated below the model's floor is skipped. `gemini-2.5-*` needs
  2048 tokens and `gemini-3*` needs 4096; a tuned-model or endpoint ID gets no
  client-side floor, because the server stays authoritative for it.

A missing `cacheConfig` or a missing `model`, in contrast, is a programming
error and throws.

## Tracing

Two spans report what happened.

- `handle_context_caching` wraps the decision. It carries `cache_action`, which
  is `active_cache` or `fingerprint_only`, and `cache_name` when a cache is
  active.
- `create_cache` wraps the creation call. It carries `cache_contents_count`,
  `model`, `ttl_seconds` and `cache_name`.
