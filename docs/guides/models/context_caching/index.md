# GeminiContextCacheManager

`GeminiContextCacheManager` owns the Gemini explicit context cache for one
conversation. Reach for it when a long, stable prompt prefix — a large system
instruction, a fixed tool set, a settled conversation — is re-sent on every
turn.

## Introduction

A Gemini request carries its whole prompt each time. In a support agent whose
system instruction runs to thousands of tokens, most of that prompt is identical
from turn to turn, and the model charges for all of it. Gemini's explicit
context cache stores that prefix server-side, so a later request can name the
cache instead of resending the prefix.

The manager decides, on each turn, which of three things to do:

| Outcome          | When                                                                                                                                              | What it returns                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Reuse            | The previous turn's cache is live, inside its interval budget, and its fingerprint still matches.                                                 | The same metadata, unchanged.               |
| Refresh          | The cache is stale, but the previous fingerprint proves the prefix has settled, and the prefix clears both `minTokens` and the model's own floor. | Metadata for a new cache.                   |
| Fingerprint only | Anything else, including a first turn.                                                                                                            | A hash of the current prefix, and no cache. |

A fingerprint-only turn is not a failure. The manager never creates a cache on
the first sight of a prefix, because a prefix that changes next turn would make
the cache dead on arrival. It records the hash, and acts on the repeat.

Three neighbouring pieces complete the loop. `ContextCacheConfig` holds the
knobs. `CacheMetadata` is what one turn hands the next. And
`LlmRequest.cacheableContentsTokenCount` carries the prompt token count the
previous response reported, which is the only measured size the manager has.

Nothing in adk-js calls the manager for you yet. `Gemini`
(`core/src/models/google_llm.ts`) does not construct one, so an application that
wants explicit caching drives the manager itself, as below.

## Get started

Two turns against the Gemini API. The first turn records a fingerprint. The
second turn creates the cache and sends only the new user content.

```typescript
import {
  CacheMetadata,
  GeminiContextCacheManager,
  LlmRequest,
} from '@google/adk';
import {GoogleGenAI} from '@google/genai';

const MODEL = 'gemini-2.5-flash';

const client = new GoogleGenAI({apiKey: process.env.GOOGLE_API_KEY});
const manager = new GeminiContextCacheManager(client);

const llmRequest: LlmRequest = {
  model: MODEL,
  contents: [{role: 'user', parts: [{text: 'What is your refund window?'}]}],
  config: {systemInstruction: 'You are a support agent. '.repeat(2000)},
  liveConnectConfig: {},
  toolsDict: {},
  cacheConfig: {cacheIntervals: 10, ttlSeconds: 1800, minTokens: 4096},
};

/** Runs one turn and returns what the next turn needs. */
async function runTurn(
  previous?: CacheMetadata,
  measuredPromptTokens?: number,
): Promise<{metadata: CacheMetadata; promptTokens?: number}> {
  llmRequest.cacheMetadata = previous;
  llmRequest.cacheableContentsTokenCount = measuredPromptTokens;

  // Rewrites llmRequest in place when a cache applies.
  const metadata = await manager.handleContextCaching(llmRequest);

  const response = await client.models.generateContent({
    model: MODEL,
    contents: llmRequest.contents,
    config: llmRequest.config,
  });
  return {metadata, promptTokens: response.usageMetadata?.promptTokenCount};
}

const first = await runTurn();
await runTurn(first.metadata, first.promptTokens);
```

Feed the metadata and the measured token count forward on every turn. Drop
either one and the manager restarts at fingerprint-only, so no cache is ever
created.

## Configuration

`ContextCacheConfig` on the request holds four fields.

| Field               | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `cacheIntervals`    | How many invocations one cache serves before the manager refreshes it. |
| `ttlSeconds`        | The cache lifetime requested from the server.                          |
| `minTokens`         | The smallest measured prompt that justifies a cache.                   |
| `createHttpOptions` | HTTP options for the create call, for example a timeout.               |

A named Gemini family also has a published floor that the manager applies on top
of `minTokens`: 2,048 tokens for `gemini-2.5-*` and 4,096 for `gemini-3*`. For a
tuned-model or endpoint ID the manager applies no floor and lets the server
decide.

The floor is checked against the _cacheable prefix_, not the whole prompt. On a
long conversation the full prompt can clear the floor while the prefix that the
cache would hold is far below it, and creating that cache fails with 400
INVALID_ARGUMENT.

## What the fingerprint covers

The fingerprint is a short SHA-256 digest of the model, the cache scope, the
system instruction, the tools, the tool config and the cached content prefix.
Change any of them and the cache is invalidated. Nothing else enters the digest,
so appending a trailing turn leaves a fixed-prefix fingerprint unchanged.

Two orderings do not matter. A reordered tool list, and a reordered
`functionDeclarations` list within a tool, produce the same fingerprint. So does
a differently ordered set of object keys, such as function-call arguments. Your
own arrays keep their order; the manager sorts copies.

## Cache scope

An explicit cache belongs to one backend, one project and one endpoint.
`@google/genai` does not expose the project, location or base URL its client was
built with, so pass them yourself:

```typescript
const manager = new GeminiContextCacheManager(vertexClient, {
  project: 'my-project',
  location: 'us-central1',
});
```

The scope enters the fingerprint. A cache created against one project is
therefore never reused against another. On the Gemini API backend the project
and location are ignored, because the backend has no such namespace; the base
URL is kept on both.

## Failure modes

Caching is an optimisation, so an operational failure degrades to "no cache"
rather than failing the turn. A rejected `caches.create`, a rejected
`caches.delete`, and a create that returns no cache name are all logged at
warning level and swallowed; the turn then proceeds with fingerprint-only
metadata.

Two conditions do throw, because they are programming errors rather than service
failures: a request with no `model`, and a request with no `cacheConfig`.

Three further guarantees are worth knowing:

- The request always keeps at least one content, because the API rejects a
  request with none. A cache covering the whole conversation still leaves the
  final content in the request.
- `contentsCount` never shrinks after a failed creation attempt, so the
  fingerprint does not oscillate while the prefix stays below the size that
  justifies a cache.
- `populateCacheMetadataInResponse` copies the metadata onto a response without
  touching `invocationsUsed`. Whoever counts invocations owns that increment.
