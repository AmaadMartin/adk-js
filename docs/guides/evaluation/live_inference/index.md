# Generating eval inferences over a live connection

`generateInferencesFromRootAgentLive` drives an agent through a whole simulated
conversation on a bidirectional (live) connection and returns the same
gradable `Invocation[]` the non-live generator returns. Reach for it when the
conversation you want to grade is audio, and for nothing else: the non-live
`generateInferencesFromRootAgent` is simpler and covers every text case.

## Introduction

A native-audio model answers in audio. It reports the words it said separately,
as a transcription on an event that carries no content. An evaluator grades
text, so an audio conversation is ungradable until something folds those
transcriptions back into content. That, plus owning the connection the
conversation runs on, is what this path adds.

The connection outlives the conversation, which is the structural difference
from the non-live path. There, one call to `runner.runAsync` is one turn: it
opens, produces its events and finishes. Here one connection carries every
turn, and the model's events arrive on the model's schedule rather than the
caller's. `EvalLiveSession` owns that connection. It runs a background driver
that reads the agent's live flow, stamps each event with the turn that was in
flight when it arrived, and records the turn as complete when the model says
so. The eval loop pushes one user turn at a time into
`EvalLiveSession.liveRequestQueue` and waits for
`EvalLiveSession.turnComplete`.

The driver also replays the model callbacks by hand. The live flow does not
fire `beforeModelCallback` or `afterModelCallback`, but autorater metrics grade
against the instructions and tool declarations the agent was shown, and those
only reach the eval system through those callbacks. The driver therefore
rebuilds the request the agent would have sent, from the agent's public request
processors and tools, and fires `beforeModelCallback` once with it, then
`afterModelCallback` once per event.

Both entry points install `EnsureRetryOptionsPlugin` on the eval runner, which
records a retry policy on every eval model request that carries none. Note that
`@google/genai` 2.9.0 applies the retry options its client was built with, not
the ones on the request, so against that version the policy is recorded but not
applied. Pass `httpOptions.retryOptions` when you construct the client to make
a transient outage retry today.

## Get started

The signature matches `generateInferencesFromRootAgent`, plus
`liveTimeoutSeconds`. The agent's model must support the Live API.

```typescript
import {
  Event,
  LlmAgent,
  NextUserMessage,
  UserSimulator,
  UserSimulatorStatus,
  generateInferencesFromRootAgentLive,
} from '@google/adk';

/** Replays a fixed list of user turns, then ends the conversation. */
class ScriptedUserSimulator implements UserSimulator {
  private turn = 0;

  constructor(private readonly messages: string[]) {}

  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    if (this.turn >= this.messages.length) {
      return {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED};
    }
    const text = this.messages[this.turn];
    this.turn++;
    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: {role: 'user', parts: [{text}]},
    };
  }
}

const rootAgent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-live-2.5-flash-native-audio',
  instruction: 'Answer in one short sentence.',
});

const invocations = await generateInferencesFromRootAgentLive({
  rootAgent,
  userSimulator: new ScriptedUserSimulator(['what is the weather?']),
  liveTimeoutSeconds: 600,
});

for (const invocation of invocations) {
  // Text, even for a native-audio answer: the transcription was folded in.
  console.log(invocation.finalResponse?.parts?.[0]?.text);
}
```

A user turn carrying `inlineData` is streamed as realtime audio; a text-only
turn is sent as content. Either way the recorded user event keeps the full
content, so the transcript an evaluator reads is complete.

## The run config

Every live eval driver runs under `LIVE_RUN_CONFIG`, a frozen module constant:
`StreamingMode.BIDI`, `Modality.AUDIO` as the only response modality, input and
output audio transcription both on, and server-side automatic activity
detection **off**. Turn boundaries come from the activity markers the driver
puts around the audio it sends, not from the model's guess at when the user
stopped talking. Each session runs against a copy of the constant, so one eval
run cannot reconfigure the next.

Note that `createRunConfig` rejects `StreamingMode.BIDI`, so `LIVE_RUN_CONFIG`
is a plain object literal handed straight to the invocation context.

## Turn boundaries and tool calls

The model reports `turnComplete` when it finishes speaking — including when it
finishes asking for a tool. That first `turnComplete` is not the end of the
turn, because the model still owes an answer once the tool result arrives. The
driver therefore holds the turn open across a tool round and completes it on
the next `turnComplete`. Without that, the simulator would be asked for its
next message while the agent was still mid tool call.

The agent's own live flow runs the tools and sends their results back over the
connection. The driver does not run them again. This differs from adk-python,
whose eval driver runs the tools a second time; adk-js's live flow already does
the whole job.

## Shutdown

`generateInferencesFromRootAgentLive` closes the live session and the runner on
every exit path, including a failing turn. `EvalLiveSession.close` closes the
request queue and waits up to `LIVE_SHUTDOWN_TIMEOUT_SECONDS` (30) for the
background driver to stop. A driver still running after that is aborted through
the invocation's abort signal and abandoned, with a warning, so a stuck model
cannot hang the eval run.

A connection that closes normally — WebSocket code 1000 — is not an error: the
transcript collected so far is kept and the closure is logged at debug level.
`isNormalClosure` matches the code structurally, on `code` or `status`, rather
than by error class, because a bundled `@google/genai` resolves its own copy of
the SDK and `instanceof` misses its error types. Any other closure is rethrown
from `close`.

## Failure modes

- A root that is not an `LlmAgent` raises an `InputValidationError` before any
  service or connection is built. adk-js drives a live run through the
  `LlmAgent` live flow, so a workflow root has no live path at all.
- A model that never completes a turn within `liveTimeoutSeconds` (default
  `DEFAULT_LIVE_TIMEOUT_SECONDS`, 300) fails the run with a timeout error.
- `EvalLiveSession.start` called twice throws, and `close` called before
  `start` throws.
- When the background driver stops on its own — the model hung up — the turn in
  flight is released rather than left to time out, and the conversation ends
  with the transcript collected so far.
