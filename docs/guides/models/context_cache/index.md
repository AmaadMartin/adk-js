# Context cache carry-over

`ContextCacheRequestProcessor` puts the context caching policy and the
session's carried-over cache state on the outgoing `LlmRequest`, so a model
layer can decide whether to reuse a cache the previous turn created.

## Introduction

A long conversation resends the same system instruction, the same tool
declarations and a growing history on every turn. A context cache lets the
model keep that prefix on the server. Reusing it needs two facts from the
previous turn: which cache was in play, and how many turns it has already
served. Both facts live on the session events, because that is the only state
that survives between invocations.

The processor is the request-side half of context caching. It reads the session
history and writes three fields on the request. It never creates, refreshes or
attaches a cache. That work belongs to a model-specific cache manager, which
adk-js does not have yet, so nothing consumes these fields today. The split
follows adk-python, where `context_cache_processor` and
`gemini_context_cache_manager` are separate modules.

Two neighbouring pieces complete the picture. `ContextCacheConfig` holds the
policy, and its own [guide](../../apps/context_cache_config/index.md) covers the
three settings. `CacheMetadata` is the per-cache record that rides on an
`LlmResponse`, and therefore on an `Event`.

`cacheableContentsTokenCount` is the previous request's measured prompt token
count, and it is what `ContextCacheConfig.minTokens` gates on. The first
request of a session has no such count, so caching begins on the second turn at
the earliest. Gemini's own minimum applies on top: 2048 tokens for Gemini 2.5,
4096 tokens for Gemini 3.

WARNING: This feature is experimental. Its API or behavior may change in a
future release.

## Get started

Every `LlmAgent` already runs the processor. It returns immediately unless the
invocation carries a `contextCacheConfig`, so the example below builds the
invocation context by hand.

```ts
import {
  CONTEXT_CACHE_REQUEST_PROCESSOR,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  createCacheMetadata,
  createContextCacheConfig,
  createEvent,
  createSession,
} from '@google/adk';

const agent = new LlmAgent({name: 'assistant', model: 'gemini-2.5-flash'});

const previousTurn = createEvent({
  author: 'assistant',
  invocationId: 'invocation-1',
  cacheMetadata: createCacheMetadata({
    cacheName: 'projects/p/locations/us-central1/cachedContents/abc',
    expireTime: Math.floor(Date.now() / 1000) + 1800,
    fingerprint: 'a1b2c3',
    invocationsUsed: 5,
    contentsCount: 12,
    createdAt: Math.floor(Date.now() / 1000) - 600,
  }),
  usageMetadata: {promptTokenCount: 1024},
});

const invocationContext = new InvocationContext({
  invocationId: 'invocation-2',
  agent,
  session: createSession({
    id: 'session-1',
    appName: 'demo',
    userId: 'user-1',
    events: [previousTurn],
  }),
  pluginManager: new PluginManager(),
  contextCacheConfig: createContextCacheConfig({ttlSeconds: 1800}),
});

const llmRequest: LlmRequest = {
  contents: [],
  toolsDict: {},
  liveConnectConfig: {},
};

for await (const _ of CONTEXT_CACHE_REQUEST_PROCESSOR.runAsync(
  invocationContext,
  llmRequest,
)) {
  // The processor yields no events.
}

llmRequest.cacheConfig; // {cacheIntervals: 10, ttlSeconds: 1800, minTokens: 0}
llmRequest.cacheMetadata?.invocationsUsed; // 6
llmRequest.cacheableContentsTokenCount; // 1024
```

## What the processor writes

| Field                         | Set when                                                           |
| ----------------------------- | ------------------------------------------------------------------ |
| `cacheConfig`                 | The invocation carries a config.                                   |
| `cacheMetadata`               | An event from this agent carried cache metadata.                   |
| `cacheableContentsTokenCount` | An event from this agent carried `usageMetadata.promptTokenCount`. |

The search walks the session events newest-first and keeps only the events this
agent authored. The two values are found independently, so an older event may
supply the token count for a cache found on a newer one. The first match of
each wins, and the walk stops as soon as both are known.

## Guarantees

- **The use counter advances once per turn.** The processor increments
  `invocationsUsed` only when the event comes from a different invocation and
  the cache is active. An event from the current invocation is copied as-is, so
  a second LLM call inside one turn does not double-count.
- **The request never shares the event's object.** Both branches produce a new
  object, so mutating `llmRequest.cacheMetadata` cannot write through into
  stored history.
- **The processor yields no events and performs no I/O.**

## Failure modes

- **An active cache with no use count throws.** An event whose metadata has a
  `cacheName` but no `invocationsUsed` cannot be advanced, so the processor
  throws `Active cache metadata must include invocationsUsed.`
  `createCacheMetadata` rejects that state, but an event rehydrated from
  session storage bypasses the factory.
- **A bare workflow node throws.** The processor needs an agent name for the
  author filter, so it fails when the invocation runs a node directly.

## Limitations

- **No cache manager yet.** No adk-js model reads `cacheConfig` or
  `cacheMetadata`, so the fields change no model call today.
- **No public switch.** adk-python exposes the policy as
  `App.context_cache_config`. adk-js has no equivalent field, and
  `InvocationContext.contextCacheConfig` is the only way to set it. The public
  knob lands with the cache manager that honours it.
