# Gemini context caching

`GeminiContextCacheManager` owns the lifecycle of a Gemini explicit context
cache: it decides when to create one, when to reuse it, and when to delete it.
Reach for it when an agent sends the same large prefix — a long system
instruction, a large tool set, a long history — turn after turn, and you want
to stop paying to re-process it.

## Introduction

A request has two parts that behave very differently. The prefix — the system
instruction, the tool declarations and the earlier turns — barely changes
between calls. The suffix — the newest user message — changes every time. A
Gemini explicit cache stores the processed prefix as a server-side resource, so
a later request references it by name instead of re-sending it.

That resource costs storage while it lives, so creating one is a judgement
call. The manager makes it from three facts: whether the prefix is the same as
last turn, how large last turn's prompt measured, and how many invocations the
current cache has already served. It never creates a cache on the first sight
of a prefix. It fingerprints the prefix, and only creates a cache on the next
call, once the same fingerprint comes back — which is the evidence that the
prefix has settled.

The manager is one half of the feature. The other half is the request
processor, which reads the app's `ContextCacheConfig` and the previous turn's
metadata off the session and stages them on the request. This guide covers the
manager. Nothing in `adk-js` wires the manager into `Gemini` yet, so a model
does not call it on your behalf: you construct it and call it yourself.

## Get started

```typescript
import {GoogleGenAI} from '@google/genai';
import {GeminiContextCacheManager, LlmRequest} from '@google/adk';

const manager = new GeminiContextCacheManager(new GoogleGenAI({}));

const llmRequest: LlmRequest = {
  model: 'gemini-2.5-flash',
  contents: [{role: 'user', parts: [{text: 'What changed in the report?'}]}],
  config: {systemInstruction: 'You are a financial analyst.'},
  liveConnectConfig: {},
  toolsDict: {},
  cacheConfig: {cacheIntervals: 5, ttlSeconds: 600, minTokens: 2048},
};

const cacheMetadata = await manager.handleContextCaching(llmRequest);
```

`handleContextCaching` rewrites `llmRequest` in place when a cache applies, so
send the request after the call, not before. Keep the returned metadata: put it
on the next request as `cacheMetadata`, and put the prompt token count the
model reported on it as `cacheableContentsTokenCount`. Without those two fields
the manager starts from scratch every turn and never creates a cache.

## Configuration

The request carries a `ContextCacheConfig`.

| Field               | Meaning                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `cacheIntervals`    | How many invocations may reuse one cache before it is refreshed.    |
| `ttlSeconds`        | How long the cache lives.                                           |
| `minTokens`         | The measured prompt size below which a cache is not worth its cost. |
| `createHttpOptions` | HTTP options for the `caches.create` call, such as a timeout.       |

`handleContextCaching` throws when the request carries no `cacheConfig`, and
when it carries no `model`. Both are programmer errors, not runtime conditions.

## What the returned metadata means

The result is a discriminated union with two states.

- **Active**: `cacheName`, `expireTime` and `invocationsUsed` are all present.
  A cache exists and the request now points at it.
- **Fingerprint-only**: none of those three are present. No cache exists, and
  `fingerprint` plus `contentsCount` describe the prefix that a later call may
  cache.

Record the metadata on the response with
`populateCacheMetadataInResponse(llmResponse, cacheMetadata)`. That method does
not increment `invocationsUsed`; the request processor owns that count.

## How a cache is decided

The prefix that gets cached is everything before the last unbroken run of user
contents, so the request always keeps a user turn to send. On a fresh
conversation of one user message that prefix is empty, and only the system
instruction and the tools are cached.

The fingerprint covers the model name, the backend namespace, the system
instruction, the tools, the tool config and the cached content prefix. A
reordered tool list does not change it, because the tools and their function
declarations are both sorted first. Anything else on that list changes it, the
old cache is deleted, and the cycle restarts.

A cache stops being valid when it expires, when it has served more than
`cacheIntervals` invocations, or when the fingerprint no longer matches.

## Cache scope

An explicit cache belongs to one backend namespace. The constructor's second
argument names it:

```typescript
const manager = new GeminiContextCacheManager(
  new GoogleGenAI({
    vertexai: true,
    project: 'my-project',
    location: 'us-central1',
  }),
  {project: 'my-project', location: 'us-central1'},
);
```

The manager reads the backend (Vertex AI or the Gemini API) from the client,
which publishes it. It cannot read the project, the location or the base URL,
because the client keeps them private, so the caller supplies them. Leaving
them out is safe on a single-project process; supply them if one process talks
to more than one project, so a cache from one is not reused by the other.

## Failure modes

Caching is an optimisation, so a transport failure never fails your request.

- `caches.create` fails, or returns no cache name: the manager logs a warning
  and returns fingerprint-only metadata. The request is unchanged and still
  carries its full prefix.
- `caches.delete` fails: the manager logs a warning. The stale cache costs
  storage until it expires.
- The measured prompt clears `minTokens` but the cacheable prefix is small:
  the manager skips creation. `gemini-2.5-*` needs 2048 tokens and `gemini-3*`
  needs 4096, and sending less makes the service reject the call. A model name
  outside those families gets no such check, so the service stays
  authoritative for a tuned model or an endpoint id.
