# ConformanceTestGemini

`ConformanceTestGemini` serves recorded LLM responses instead of calling Gemini,
and throws when the runtime does not ask for what the recording captured. Reach
for it when a conformance test must prove that the request itself has not
drifted, not only that the run finished.

## Introduction

A conformance recording holds both halves of every model call: the `LlmRequest`
the runtime sent, and the responses the model gave back. Replaying only the
responses proves that the runtime can finish the conversation. It does not prove
that the runtime asked the same question. A prompt change, a lost tool
declaration or a reworded relayed message all leave a response-only replay
green.

`ConformanceTestGemini` closes that gap. It is a `BaseLlm`, so it stands where
the real model stands, and it compares the live request against the recorded one
before it yields anything.

Two neighbouring pieces do related work in this package:

- `ReplayPlugin` (`dev/src/integration/replay_plugin.ts`) replays responses
  through `beforeModelCallback`. It verifies nothing. `TestRunner` uses it
  today.
- `RecordReplayModel` (`tests/integration/workflows/_harness/`) keys recordings
  by a request fingerprint for the workflow sample suite. It is a different
  replayer, not a counterpart.

Nothing in adk-js constructs `ConformanceTestGemini` yet. adk-python swaps its
equivalent in from `base_llm_flow.py` when a replay config sits in session
state; adk-js has no such hook. Wiring is a separate change.

This module is internal to `@google/adk-devtools`. It is not exported from the
package entry point, so the examples below import it by path, as the conformance
harness does.

## Get started

Build the model for one agent, one user turn and one call index, then iterate
it:

```ts
import {LlmRequest, LlmResponse} from '@google/adk';
import {ConformanceTestGemini} from '../conformance/conformance_test_google_llm.js';

const model = new ConformanceTestGemini({
  recordings: {
    recordings: [
      {
        userMessageIndex: 0,
        agentName: 'root_agent',
        llmRecording: {
          llmRequest: recordedRequest,
          llmResponses: [{content: {role: 'model', parts: [{text: 'hi'}]}}],
        },
      },
    ],
  },
  agentName: 'root_agent',
  userMessageIndex: 0,
  replayIndex: 0,
});

const replayed: LlmResponse[] = [];
for await (const response of model.generateContentAsync(liveRequest)) {
  replayed.push(response);
}
```

The constructor keeps only the recordings whose `agentName` and
`userMessageIndex` match, and which carry an `llmRecording`. `replayIndex`
selects one of those. The model holds no cursor: the caller increments
`replayIndex` and builds a new model for the next call, as adk-python does from
session state.

`connect()` throws. A replay model never opens a live connection.

## What the comparison ignores

A request carries data that legitimately differs between two runs of the same
conversation. The comparison drops it first:

- `toolsDict`, which holds live `BaseTool` instances.
- `liveConnectConfig`.
- `config.abortSignal`, `config.httpOptions` and `config.labels`.
- Any field that is absent, `null`, an empty object or an empty array.

That last rule stands in for Pydantic's `exclude_defaults`, which TypeScript has
no analogue for. A field explicitly set to `false`, `0` or `''` survives, so it
can still fail the comparison if only one side set it.

## What the normalizers absorb

`replay_normalizers.ts` reduces both dumps to a shape that ignores formatting.
Import the functions directly to normalize a schema outside the model.

Function declarations, through `normalizeToolConfig`:

- `transfer_to_agent` gets a pinned description, so rewording the built-in
  transfer tool does not invalidate every recording that covers a transfer.
- Every other description is trimmed.
- `parameters` becomes `parametersJsonSchema`, and an existing
  `parametersJsonSchema` is normalized in place. `parameters` wins when a
  declaration carries both.
- `response` and `responseJsonSchema` are dropped.

Schemas, through `normalizeSchema`:

- `$defs` references are inlined and `$defs` is removed.
- `title`, `default` and `description` are dropped at every level.
- `Type.STRING`, `STRING` and a Python enum dump all become `string`.
- `anyOf: [X, {type: 'null'}]` becomes `X` plus `nullable: true`.

Relayed agent turns, through `normalizeRelayedAgentContent`. When an agent hands
off, the runtime replays its turn behind a preamble and between quote markers.
That framing is prose aimed at the model, so a recording made before the fencing
change still compares equal:

```ts
import {normalizeRelayedAgentText} from '../conformance/replay_normalizers.js';

normalizeRelayedAgentText(
  '[sub_agent] said:\n<<<BEGIN_QUOTED_AGENT_CONTENT>>>\nhi\n<<<END_QUOTED_AGENT_CONTENT>>>',
);
// '[sub_agent] said: hi'
```

The preamble is matched exactly, never by prefix. A turn the real user typed
that merely opens with `For context:` is a real turn, and compares verbatim.

## Failure modes

Both failures throw `ReplayVerificationError`. Test for it with
`isReplayVerificationError`, not `instanceof`.

The runtime asked for more calls than were recorded:

```
Runtime sent more LLM requests than expected for agent 'root_agent' at
userMessageIndex 0. Expected 1, but got request at index 1
```

The request did not match. The message names the turn, the agent and the replay
index, and prints both dumps:

```
LLM request mismatch in turn 0 for agent 'root_agent' (index 0):
recorded: {...}
current: {...}
```

Nothing is yielded before either failure.

A recording that predates request capture has no `llmRequest`. There is then
nothing to verify, so the responses are served without a comparison.
