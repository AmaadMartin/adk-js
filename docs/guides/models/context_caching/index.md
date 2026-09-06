# Gemini context caching

Explicit context caching stores the stable prefix of a Gemini prompt on the
server and replaces it with a reference on later turns. Reach for it when an
agent repeats a large system instruction, a large tool declaration set, or a
long conversation history on every turn.

## Introduction

A multi-turn agent resends the same prefix each turn: the system instruction,
the tool declarations, and every earlier content. That prefix is billed and
processed again on every call. Gemini's `cachedContents` resource lets you
upload the prefix once and refer to it by name, so later turns send only the
new contents.

`GeminiContextCacheManager` owns that lifecycle for the `Gemini` model. It
decides whether a cache still matches the request, creates one when it does not,
deletes the one it replaced, and reports which cache served the response. It
never fails a turn: a cache that cannot be created or deleted is logged and the
request proceeds uncached.

The manager is not a general prompt cache. Gemini enforces a minimum cacheable
size, so a short conversation is never cached, and the first turn of a session
is never cached either because no accurate token count exists yet. The gain
appears from the second turn on, on prompts with a large stable prefix.

Two pieces of state make this work across turns, and the caller carries them:
`LlmResponse.cacheMetadata` from one turn becomes `LlmRequest.cacheMetadata` on
the next, and `LlmRequest.cacheableContentsTokenCount` reports the previous
turn's prompt token count.

## Get started

Set `cacheConfig` on the request to turn caching on, then feed each turn's
metadata into the next one.

```ts
import {
  DEFAULT_CONTEXT_CACHE_CONFIG,
  Gemini,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Content} from '@google/genai';

async function askOnce(
  llm: Gemini,
  contents: Content[],
  previous?: LlmResponse,
): Promise<LlmResponse> {
  const llmRequest: LlmRequest = {
    model: 'gemini-2.5-flash',
    contents,
    config: {systemInstruction: 'You are a patient research assistant.'},
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: DEFAULT_CONTEXT_CACHE_CONFIG,
    cacheMetadata: previous?.cacheMetadata,
    cacheableContentsTokenCount: previous?.usageMetadata?.promptTokenCount,
  };

  let last: LlmResponse | undefined;
  for await (const response of llm.generateContentAsync(llmRequest)) {
    last = response;
  }
  if (!last) {
    throw new Error('the model yielded no response');
  }
  return last;
}

/** Runs two turns and returns the cache that served the second one. */
export async function researchTwice(): Promise<string | undefined> {
  const llm = new Gemini({model: 'gemini-2.5-flash'});
  const history: Content[] = [
    {role: 'user', parts: [{text: 'Summarize the attached policy.'}]},
  ];

  const first = await askOnce(llm, history);
  history.push(first.content ?? {role: 'model', parts: []}, {
    role: 'user',
    parts: [{text: 'Now list its exceptions.'}],
  });

  const second = await askOnce(llm, history, first);
  return second.cacheMetadata?.cacheName;
}
```

`CacheMetadata` has two states. Fingerprint-only metadata carries a
`fingerprint` and a `contentsCount` and nothing else: it records the prefix the
next turn may cache. Active metadata additionally carries `cacheName`,
`expireTime` and `invocationsUsed`. The type is a union, so a half-populated
record does not compile, and `cacheName` is the field to test.

## What the manager sends

When a cache applies, the manager rewrites the request in place before the model
call: `config.cachedContent` names the cache, `config.systemInstruction`,
`config.tools` and `config.toolConfig` are cleared because the cache holds them,
and the cached leading contents are dropped. The final content is always kept,
because the API rejects a request with no contents.

The response then reports the cache twice. `LlmResponse.cacheMetadata` carries
the cache identity, and `usageMetadata.cachedContentTokenCount` carries the
token count the cache served. On a streaming call only the final aggregated
response carries `cacheMetadata`; the partials before it are fragments of the
same turn.

## What invalidates a cache

The manager fingerprints the model, the backend, the system instruction, the
tools, the tool config and the cached contents. A cache is reused only while
that fingerprint still matches and all of these hold:

- The cache has not expired, per `ttlSeconds`.
- It has served no more than `cacheIntervals` invocations.
- The request targets the same model, backend, project, location and endpoint.

When the fingerprint of the previously cached prefix still matches but the cache
is otherwise unusable, the manager deletes it and tries to create a replacement
over a prefix that has grown to include the completed turn. When the fingerprint
no longer matches, it deletes the cache and starts again with fingerprint-only
metadata.

## Configuration

| Field               | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `cacheIntervals`    | How many invocations may reuse one cache before it is refreshed.        |
| `ttlSeconds`        | How long the cache lives, server-side.                                  |
| `minTokens`         | The previous turn's prompt token count below which no cache is created. |
| `createHttpOptions` | HTTP options for the cache-creation call, a timeout for instance.       |

`DEFAULT_CONTEXT_CACHE_CONFIG` supplies `cacheIntervals: 10`, `ttlSeconds: 1800`
and `minTokens: 0`.

Gemini's own minimum always applies on top of `minTokens`: 2048 tokens for a
`gemini-2.5-*` model and 4096 for a `gemini-3*` one. The manager estimates the
size of the prefix it would cache and skips creation below that floor, so a
long conversation with a small cacheable prefix does not fail the create call.
A model name it does not recognise, a tuned-model or endpoint ID, gets no
client-side floor; the server decides.

## Tracing

Each request that carries a `cacheConfig` emits one `handle_context_caching`
span. Its `cache_action` attribute is `active_cache` or `fingerprint_only`, and
`cache_name` is set only in the first case. A turn that mints a cache also emits
a nested `create_cache` span carrying `cache_contents_count`, `model`,
`ttl_seconds` and `cache_name`.

## Limits

Caching never runs on the Interactions API path, so a `Gemini` built with
`useInteractionsApi: true` ignores `cacheConfig`.

`GeminiContextCacheManager` is experimental, and its API may change.
