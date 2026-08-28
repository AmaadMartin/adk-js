# Context caching

`ContextCacheConfig` describes how an app reuses a Gemini context cache: how
many invocations one cache serves, how long it lives, and how large a request
must be before caching is worth it. `ContextCacheRequestProcessor` carries that
policy, and the cache state of the previous turn, onto each outgoing request.

## Introduction

A long conversation resends the same system instruction, the same tool
declarations, and a growing history on every turn. A context cache lets the
model keep that prefix on the server, so later requests pay for it once instead
of every time. Caching is not free, though: the cache has storage cost and a
lifetime, so a good setup depends on three numbers rather than a single switch.

`ContextCacheConfig` holds those three numbers, and its defaults and bounds
match adk-python's `ContextCacheConfig`, so the same tuning transfers between
the two SDKs.

Reusing a cache also needs two facts from the previous turn: which cache was in
play, and how many turns it has served. Both live on the session events,
because that is the only state surviving between invocations.
`ContextCacheRequestProcessor` reads them back and writes them onto the
request. It never creates, refreshes or attaches a cache; that belongs to a
model-specific cache manager, which adk-js does not have yet. The split follows
adk-python, where `context_cache_processor` and `gemini_context_cache_manager`
are separate modules.

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

## Carrying the cache state forward

Every `LlmAgent` already runs `ContextCacheRequestProcessor`. It returns
immediately unless the invocation carries a `contextCacheConfig`, so the
example below builds the invocation context by hand.

```ts
import {
  CONTEXT_CACHE_REQUEST_PROCESSOR,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  createContextCacheConfig,
  createEvent,
  createSession,
} from '@google/adk';

const agent = new LlmAgent({name: 'assistant', model: 'gemini-2.5-flash'});

const previousTurn = createEvent({
  author: 'assistant',
  invocationId: 'invocation-1',
  cacheMetadata: {
    cacheName: 'projects/p/locations/us-central1/cachedContents/abc',
    expireTime: Math.floor(Date.now() / 1000) + 1800,
    fingerprint: 'a1b2c3',
    invocationsUsed: 5,
    contentsCount: 12,
    createdAt: Math.floor(Date.now() / 1000) - 600,
  },
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

The search walks the session events newest-first and keeps only the events this
agent authored. `cacheMetadata` and `cacheableContentsTokenCount` are found
independently, so an older event may supply the token count for a cache found
on a newer one. The first match of each wins, and the walk stops as soon as
both are known.

The processor increments `invocationsUsed` only when the event comes from a
different invocation and the cache is active, so a second LLM call inside one
turn does not double-count. It copies the metadata rather than sharing the
event's object, so mutating `llmRequest.cacheMetadata` cannot write through
into stored history. It yields no events and performs no I/O.

It throws in one case. An event whose metadata has a `cacheName` but no
`invocationsUsed` cannot be advanced, so the processor throws `Active cache
metadata must include invocationsUsed.` An active cache always carries a use
count; an event rehydrated from storage can arrive without one.

## Limitations

- **No cache manager yet.** `ContextCacheRequestProcessor` reads this config,
  but no adk-js model acts on it, so building a config changes no model call
  today.
- **No public switch.** `App` has no `contextCacheConfig` field.
  `InvocationContext.contextCacheConfig` is the only way to set the policy.
- **Three fields only.** adk-python's default branch has since added a
  `createHttpOptions` field that only its cache manager reads. This port
  matches the v2.0.0 field set.
