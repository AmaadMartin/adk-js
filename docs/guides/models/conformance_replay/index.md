# ConformanceTestGemini and the replay normalizers

`ConformanceTestGemini` is a `Gemini` model that serves a recorded response to a
conformance run, and checks first that the runtime asked for what the recording
says it asked for. Reach for it when a replayed run must fail on a change to the
request, not only on a change to the answer.

## Introduction

A conformance case is recorded once against a live model. Every later run
replays the recording, so the run costs nothing and never flakes on the model.
The value of that run depends on what it compares. A replay that only hands back
the recorded response proves that the runtime consumed a response. It passes
even when the prompt, the tool declarations or the history the runtime built
have changed, which is the regression conformance exists to catch.

This model compares the request instead. Before it serves the recorded response
it reduces both the recorded request and the current one to a canonical shape,
and throws `ReplayVerificationError` when the two differ. It also throws when
the runtime asks for more calls in a turn than the recording holds, rather than
failing later on an undefined response.

Two requests that mean the same thing can still be spelled differently, so the
comparison is not a raw deep equal. The normalizers in `replay_normalizers.ts`
absorb the differences that carry no behavior:

- `normalizeToolConfig` pins the `transfer_to_agent` description and trims the
  others, so rewording a built-in tool does not invalidate every recording.
- `normalizeSchemaDict` inlines `$defs`/`$ref`, drops `title`, `default` and
  `description`, lowercases type names, and collapses an `anyOf` of one type
  plus null into that type with `nullable: true`.
- `normalizeRelayedAgentContent` reduces a relayed agent turn to the payload it
  carries, so the preamble and quote markers around it can be reworded.

The comparison also drops fields that differ by construction: `liveConnectConfig`,
`toolsDict`, and `config.httpOptions`, `config.labels` and `config.abortSignal`.

The model is not wired into the runtime. adk-python swaps it in from its flow,
which reads a replay config out of session state; adk-js has no equivalent hook
yet, and its conformance harness replays through `ReplayPlugin` instead. Drive
this model directly, as below.

## Get started

`dev/src/conformance/conformance_test_google_llm.ts` is internal to the
conformance harness, so it is not exported from `@google/adk-devtools`. Import
it by path.

```ts
import {LlmRequest} from '@google/adk';

import {
  ConformanceTestGemini,
  isReplayVerificationError,
} from './conformance_test_google_llm.js';

const recordedRequest: LlmRequest = {
  model: 'gemini-2.5-flash',
  contents: [{role: 'user', parts: [{text: 'Where is my parcel?'}]}],
  liveConnectConfig: {},
  toolsDict: {},
};

const model = new ConformanceTestGemini({
  recordings: {
    recordings: [
      {
        userMessageIndex: 0,
        agentName: 'planner',
        llmRecording: {
          llmRequest: recordedRequest,
          llmResponses: [
            {content: {role: 'model', parts: [{text: 'It shipped today.'}]}},
          ],
        },
      },
    ],
  },
  agentName: 'planner',
  userMessageIndex: 0,
  replayIndex: 0,
});

const replayed: string[] = [];
for await (const response of model.generateContentAsync(recordedRequest)) {
  replayed.push(response.content?.parts?.[0]?.text ?? '');
}
// replayed is ['It shipped today.']

const changedRequest: LlmRequest = {
  ...recordedRequest,
  contents: [{role: 'user', parts: [{text: 'Where is my refund?'}]}],
};

let failure = '';
try {
  // The verification runs before the first response is yielded.
  for await (const response of model.generateContentAsync(changedRequest)) {
    replayed.push(response.content?.parts?.[0]?.text ?? '');
  }
} catch (e: unknown) {
  if (!isReplayVerificationError(e)) throw e;
  failure = e.message;
}
// failure starts with:
// LLM request mismatch in turn 0 for agent 'planner' (index 0):
```

## Advancing the replay cursor

The model holds no cursor. The caller constructs one model per call and passes
the `replayIndex` that call is expected to serve, exactly as adk-python does.
Asking for an index the recording does not hold throws:

```
Runtime sent more LLM requests than expected for agent 'planner' at
userMessageIndex 0. Expected 1, but got request at index 1
```

## Recording shape

`ConformanceReplayModelConfig.recordings` is the `Recordings` type from
`dev/src/integration/test_types.ts`, which the conformance harness already
produces. A recording may carry `llmResponses` (a list, as adk-python records
it) or `llmResponse` (a single response, as adk-js records it); the list is
preferred when both are present. A recording with no request is served without
verification, because there is nothing to compare.

## Live calls

`connect` throws. A replay model never reaches the network, so it has no live
path.

It also ignores the ambient credential environment. `Gemini` demands an API key
normally, and a project and a location once `GOOGLE_GENAI_USE_VERTEXAI` or
`GOOGLE_GENAI_USE_ENTERPRISE` is set, so the replay model supplies placeholders
for all three. A conformance run therefore behaves the same on a machine that
has credentials configured and on one that does not.
