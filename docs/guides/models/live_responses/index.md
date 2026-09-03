# Live responses

A Gemini Live session pushes many small server messages per turn. ADK maps
each of them to an `LlmResponse`, and `Runner.runLive` hands that stream to
your app as `Event` objects. Read this guide when you consume a live run and
need to know which field carries what, and when.

## Introduction

The live wire protocol is fragmented by design. One spoken answer arrives as a
run of partial text messages, then a `turnComplete`. Search grounding arrives
in pieces: each message reports only the queries, chunks and supports it added.
Token usage arrives under names that differ from the unary API's.

`LiveResponseAggregator` does the reassembly, so your app does not have to:

- It buffers streamed text and emits one full-text response at the end of a
  run of text parts.
- It merges the grounding metadata of a turn, so the full-text response carries
  every query and chunk of the turn rather than the last message's fragment.
- It renames the live token counts onto the `GenerateContentResponse` names, so
  `usageMetadata.candidatesTokenCount` reads the model's output tokens.
- It buffers tool calls until `turnComplete` for models that send the two
  separately.

The aggregator lives with the connection, so the state resets when the
connection closes. Nothing from turn _n_ reaches turn _n+1_.

## Get started

```ts
import {
  InMemorySessionService,
  InteractionStatus,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';

const runner = new Runner({
  appName: 'live-demo',
  agent: new LlmAgent({name: 'agent', model: 'gemini-2.5-flash-live'}),
  sessionService: new InMemorySessionService(),
});

const queue = new LiveRequestQueue();
queue.sendRealtime({data: audioBase64, mimeType: 'audio/pcm'});

for await (const event of runner.runLive({
  userId: 'user',
  sessionId: 'session',
  liveRequestQueue: queue,
})) {
  if (event.partial) {
    continue; // A text fragment; the full text follows.
  }
  if (
    event.turnComplete &&
    event.interactionStatus !== InteractionStatus.IN_PROGRESS
  ) {
    queue.close(); // The model finished the prompt and waits for more input.
  }
}
```

## What each field means

| Field                | When it is set                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `partial`            | The response carries a fragment. A `partial: false` response with the same text follows.       |
| `turnComplete`       | The model finished a turn.                                                                     |
| `turnCompleteReason` | Why the turn ended, when the server reports it.                                                |
| `interactionStatus`  | `IN_PROGRESS` or `IDLE`, when the server reports it. See below.                                |
| `interrupted`        | The user spoke over the model. Also set on the text flushed by the interrupt.                  |
| `groundingMetadata`  | The merged grounding of the turn on a full-text response, the raw message grounding elsewhere. |
| `voiceActivity`      | The server detected the start or the end of user speech.                                       |
| `usageMetadata`      | Token counts, remapped onto the `GenerateContentResponse` names.                               |
| `liveSessionId`      | The session id, once the server reports it in its setup acknowledgement.                       |

### Do not treat turnComplete as the end of the interaction

Newer live models answer one user prompt with several model turns, so
`turnComplete` no longer means the model is done. `interactionStatus` separates
the two cases:

- `IN_PROGRESS`: the model still works on the prompt. Do not re-enable the
  microphone yet.
- `IDLE`: the model finished the prompt and waits for more user input.

The field stays absent for models that do not report it. Treat
`turnComplete === true` as terminal in that case.

### Grounding metadata accumulates, then resets

Each message contributes its own fragment. The aggregator appends the queries
it has not seen, concatenates the chunks, and shifts each support's
`groundingChunkIndices` past the chunks already accumulated, so an index still
points at the right chunk in the merged list. The full-text response carries
the merged result.

The accumulator resets on every response that carries it. A turn that grounds
nothing therefore reports no grounding, even if the previous turn grounded a
search.

When the backend reports `retrievalQueries` but no `groundingChunks`, ADK logs
a warning at `turnComplete`. The grounding is unusable in that state, and the
cause is usually a transient backend problem.

### Token usage

The live API names output tokens `responseTokenCount` and
`responseTokensDetails`. ADK copies them onto `candidatesTokenCount` and
`candidatesTokensDetails`, which is where the unary API puts them, so one
accounting path serves both. `serviceTier` has no counterpart on the target
type and is dropped.

## Gemini 3.x Live differences

`gemini-3.x` live models behave differently in three ways, and ADK routes them
with `isGemini3xLive`:

- They send one final input transcription rather than a stream of partials, so
  ADK emits it once with `finished: true` and `partial: false`.
- They do not send `turnComplete` until they receive the tool response, so ADK
  yields a tool call immediately instead of buffering it.
- They report an empty `GroundingMetadata` object on `turnComplete` when they
  grounded nothing, which lets an app tell "no grounding" from "grounding not
  supported".

Gemini 3.5 Live Translate models are excluded: they are 3.x live models, but
they support a different feature set. Use `isGemini35LiveTranslate` for those.
