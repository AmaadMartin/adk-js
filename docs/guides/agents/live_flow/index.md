# The live flow

`Runner.runLive` drives an `LlmAgent` over a bidirectional model connection.
The flow screens what the user says and what the model answers, saves the
turn's audio, and reopens the session when something goes wrong. Reach for it
when you need a spoken conversation rather than a request and a reply.

## Introduction

A non-live run is one request and one response, so a guardrail can sit in
`beforeModelCallback` and inspect the whole request before it leaves. A live
run has no such moment. The user speaks while the model answers, both sides
stream, and the model has usually started replying before anyone could have
read the input.

The live flow gives you the same two callbacks anyway, at three points where a
decision is still useful:

- Typed text, before it reaches the model. Nothing was sent yet, so a block
  costs nothing: the flow delivers your response and keeps the session.
- The model's own words, as its output transcription accumulates. A block ends
  the turn and restarts the session, so the rest of the answer never reaches
  the caller.
- The user's speech, once the server reports the transcription as finished.
  The transcription still reaches the caller first, then the block, then a
  restart.

A restart is not a reconnect. A reconnect keeps the session resumption handle
and lets the server restore what it holds. A restart drops the handle, opens a
new session, and replays the conversation from the session's own events, so
the blocked content is not carried forward. Restarts are bounded: a callback
that blocks every turn stops the run rather than looping.

Three more things the flow does around the connection:

- **Audio.** With `RunConfig.saveLiveBlob`, the user's audio and the model's
  audio are cached per turn and written to the artifact service when the turn
  ends. Each turn produces one artifact per side, and the event that carries
  it holds an `artifact://` reference rather than the bytes.
- **Toolset credentials.** A toolset that returns an `AuthConfig` from
  `getAuthConfig()` has its credential resolved before ADK lists its tools. If
  no credential is available, the invocation ends with an
  `adk_request_credential` function call for the client to answer.
- **Background tools.** Streaming and non-blocking tools registered on the
  invocation are cancelled when the run ends, on a handoff to another agent
  and on teardown alike, so a tool cannot keep answering the next agent's
  model.

## Get started

This agent refuses to discuss one topic and saves the session's audio. The
guardrail runs on typed text and on finished speech transcriptions alike.

```ts
import {
  InMemoryArtifactService,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-live-2.5-flash-native-audio',
  instruction: 'You are a helpful assistant.',
  beforeModelCallback: ({request}) => {
    const said = request.contents
      .flatMap((content) => content.parts ?? [])
      .map((part) => part.text ?? '')
      .join(' ');
    if (!said.toLowerCase().includes('salary')) {
      return undefined;
    }
    return {
      content: {role: 'model', parts: [{text: 'I cannot discuss that.'}]},
    };
  },
});

const runner = new Runner({
  appName: 'live-demo',
  agent,
  sessionService: new InMemorySessionService(),
  artifactService: new InMemoryArtifactService(),
});

const queue = new LiveRequestQueue();
queue.send({content: {role: 'user', parts: [{text: 'What is the weather?'}]}});

for await (const event of runner.runLive({
  userId: 'user',
  sessionId: 'session',
  liveRequestQueue: queue,
})) {
  if (event.turnComplete) {
    queue.close();
  }
}
```

Send audio with `queue.sendRealtime({data, mimeType})`, where `data` is a
base64 string. Close the queue to end the session.

## Configuration

| Field                | Where       | Effect                                                           |
| -------------------- | ----------- | ---------------------------------------------------------------- |
| `saveLiveBlob`       | `RunConfig` | Saves each turn's audio to the artifact service. Off by default. |
| `historyConfig`      | `RunConfig` | Copied onto the connect config when history is replayed.         |
| `responseScheduling` | `BaseTool`  | Declares the tool `NON_BLOCKING` on the live path.               |

Turning `saveLiveBlob` on changes the shape of a turn's last event. The flow
yields the flushed audio events instead of the control event, so a turn that
produced audio emits no `turnComplete`. Do not build a turn boundary on that
flag; close the queue on your own input instead, or on the `fileData` event
the flush produces.

The flow sets `historyConfig.initialHistoryInClientContent` to `true` when it
replays history on a fresh connection, so the server does not answer those
turns again. An explicit value in `RunConfig.historyConfig` is kept.

`sessionResumption.transparent` is set only for a Vertex AI backed `Gemini`.
The Gemini API backend rejects the field.

## Guarantees and limits

- A turn with no callback registered, or with callbacks that return nothing,
  passes through unchanged.
- A blocked event carries `turnComplete: true`.
- A resolved toolset credential is stored on the invocation, under
  `InvocationContext.credentialByKey`, never on the toolset's own config.
- Audio is written only when the artifact service is present. A failed save
  keeps the audio for the next flush and produces no event.
- A turn that flushes audio emits no `turnComplete` event.
- No audio is cached while `saveLiveBlob` is off, so the caches cannot grow on
  the default path.
- Cancelling a background tool is best effort. A task that ignores it is
  logged and dropped from the registry.
