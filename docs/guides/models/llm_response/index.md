# LlmResponse

`LlmResponse` is the single shape every model adapter in ADK returns. It carries
the model's content, the reason the turn ended, and the accounting a caller
needs: token usage, log probabilities, context cache state, and live-session
turn state. Reach for this guide when you read a model result directly, or when
you write a model adapter and need to know which field carries what.

## Introduction

An ADK `Event` extends `LlmResponse`, so every field described here also appears
on a persisted event. That is why the type matters beyond the model layer: a
field the adapter never fills is a value that disappears between the wire
response and the application, and it never reaches session history.

`createLlmResponse` converts a `GenerateContentResponse` from `@google/genai`
into an `LlmResponse`. It is total: it returns a response for every input and
never throws. A caller distinguishes success from failure by `errorCode`, which
is set only when the model refused or blocked the turn.

## Get started

```ts
import {Gemini, LlmRequest} from '@google/adk';

async function firstReply(request: LlmRequest): Promise<string> {
  const model = new Gemini({model: 'gemini-2.5-flash'});
  for await (const response of model.generateContentAsync(request)) {
    if (response.errorCode) {
      throw new Error(`${response.errorCode}: ${response.errorMessage}`);
    }
    const text = response.content?.parts?.[0]?.text;
    if (text) {
      return text;
    }
  }
  return '';
}
```

Every response also carries `modelVersion`, the model that actually served the
request, and `avgLogprobs` when the model reports token confidence.

## Reading function calls and responses

`getFunctionCalls` and `getFunctionResponses` read the tool traffic out of any
`LlmResponse`. Both keep the order of the parts and skip parts that carry
neither. Both return an empty array when the response has no content.

```ts
import {getFunctionCalls, getFunctionResponses, LlmResponse} from '@google/adk';

const response: LlmResponse = {
  content: {
    parts: [
      {functionCall: {name: 'lookup', args: {city: 'Paris'}}},
      {text: 'checking'},
      {functionResponse: {name: 'lookup', response: {temp: 14}}},
    ],
  },
};

getFunctionCalls(response); // [{name: 'lookup', args: {city: 'Paris'}}]
getFunctionResponses(response); // [{name: 'lookup', response: {temp: 14}}]
```

An `Event` is an `LlmResponse`, so the same two functions accept an event.

## What createLlmResponse produces

The factory takes one of four branches.

| Input                                                      | Result                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A candidate with content parts, or `finishReason: STOP`    | Success: `content`, `groundingMetadata`, `citationMetadata`, `usageMetadata`, `finishReason`, `avgLogprobs`, `logprobsResult`, `modelVersion`. |
| A candidate with no usable parts and another finish reason | Error: `errorCode` from `finishReason`, `errorMessage` from `finishMessage`, plus the citation, usage, logprobs and version fields.            |
| No candidates, but `promptFeedback`                        | Error: `errorCode` from `blockReason`, `errorMessage` from `blockReasonMessage`, plus `usageMetadata` and `modelVersion`.                      |
| No candidates and no `promptFeedback`                      | Success with empty model content, plus `usageMetadata` and `modelVersion`. The factory logs a warning.                                         |

Two of these are worth spelling out.

A candidate with an empty `parts` array and `finishReason: STOP` is a success,
not an error. A streaming model emits a terminal chunk that carries the finish
reason and no parts, and a consumer that batches parts across chunks breaks if
that chunk arrives as an error.

A response with no candidates and no prompt feedback is also a success. Some
backends complete a turn this way, for example a tool-driven interface turn that
produces no text.

## Live session turn state

A live model reports `turnComplete` when it finishes a turn. Newer live models
answer one user prompt with several turns, so `turnComplete` alone no longer
means the model is done. `interactionStatus` separates the two cases:

- `InteractionStatus.IN_PROGRESS`: more model turns follow. Do not re-enable the
  microphone.
- `InteractionStatus.IDLE`: the model finished the prompt and waits for user
  input.

The field stays absent for models that do not report it. Treat
`turnComplete === true` as terminal in that case.

```ts
import {InteractionStatus, LlmResponse} from '@google/adk';

function isUserTurn(response: LlmResponse): boolean {
  if (response.interactionStatus === undefined) {
    return response.turnComplete === true;
  }
  return response.interactionStatus === InteractionStatus.IDLE;
}
```

`turnCompleteReason` and `voiceActivity` carry the matching signals from
`@google/genai`. ADK declares all three fields on `LlmResponse`. No adapter in
this package sets them, so an adapter or an application must supply them.

## Context cache metadata

`cacheMetadata` describes the context cache that served a response. It has two
states, and the type makes them exclusive:

- `ActiveCacheMetadata`: a live cache, with `cacheName`, `expireTime` and
  `invocationsUsed`.
- `FingerprintCacheMetadata`: a fingerprinted content prefix with no cache
  behind it. It has none of those three fields.

Both states carry `fingerprint` and `contentsCount`. Token counts are not
repeated here; read them from `usageMetadata`.

```ts
import {CacheMetadata, isCacheExpiringSoon} from '@google/adk';

const metadata: CacheMetadata = {
  cacheName: 'projects/1/locations/us-central1/cachedContents/2',
  expireTime: 1_700_000_600,
  invocationsUsed: 4,
  fingerprint: 'abcdef0123456789',
  contentsCount: 6,
};

isCacheExpiringSoon(metadata); // true within 120 seconds of expireTime
```

`formatCacheMetadata` renders either state as one line for a log. No adapter in
this package sets `cacheMetadata`, so the producer of the cache must supply it.
