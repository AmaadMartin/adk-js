# Live streaming run config

`RunConfig` carries three options that only apply to a live (bidirectional) run:
`sessionResumption`, `saveLiveBlob` and `explicitVadSignal`. Reach for them when
you drive `Runner.runLive` and you need the connection to survive a drop, the
model's audio to be kept, or the client to own the turn boundaries.

## Introduction

A live run holds one open connection to the Live server. Three problems follow
from that, and each option answers one of them.

A connection drops. By default the runner replays the conversation history onto
the new connection. Session resumption replaces that replay: the server keeps
the state and restores it from a handle, so the model does not lose partially
processed audio. The runner already captures each server-issued handle and
reconnects with it; `sessionResumption` is how you configure the mode, or supply
a handle from an earlier run.

The model streams audio back as inline blobs. The runner never writes those
blobs into the session, because a session is a conversation record and not a
media store. `saveLiveBlob` sends them to the artifact service instead and keeps
only the reference in the session.

The server decides when the user started and stopped speaking. A push-to-talk
client already knows. `explicitVadSignal` tells the server to stop guessing and
wait for `LiveRequestQueue.sendActivityStart()` and `sendActivityEnd()`.

## Get started

```ts
import {
  InMemoryArtifactService,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';

const runner = new Runner({
  appName: 'live-app',
  agent: new LlmAgent({
    name: 'assistant',
    model: 'gemini-3.1-flash-live-preview-04-2026',
  }),
  sessionService: new InMemorySessionService(),
  artifactService: new InMemoryArtifactService(),
});

const liveRequestQueue = new LiveRequestQueue();
const transcript: string[] = [];

for await (const event of runner.runLive({
  userId: 'user-1',
  sessionId: 'session-1',
  liveRequestQueue,
  runConfig: {
    sessionResumption: {transparent: true},
    saveLiveBlob: true,
    explicitVadSignal: true,
  },
})) {
  const text = event.outputTranscription?.text;
  if (text) {
    transcript.push(text);
  }
}
```

## Session resumption

`sessionResumption` is a `SessionResumptionConfig` from `@google/genai`. It has
two fields:

- `transparent` asks the server to report the last consumed client message
  index in each resumption update, which is what allows a transparent
  reconnection.
- `handle` names a session the server already holds.

Set `handle` to resume a session from an earlier `runLive` call. The runner then
treats the first connection as a resumption: it skips history replay, and a drop
before the first server update still has a handle to retry with.

```ts
runConfig: {sessionResumption: {handle: priorHandle, transparent: true}},
```

The runner reads each `liveSessionResumptionUpdate` the server sends and merges
the new handle into the connect config. Your `transparent` choice survives that
merge. Read the handle off the event stream to persist it for a later run:

```ts
for await (const event of runner.runLive({
  /* ... */
})) {
  const newHandle = event.liveSessionResumptionUpdate?.newHandle;
  if (newHandle) {
    latestHandle = newHandle;
  }
}
```

The runner copies the config rather than sharing it, so the observed handle
never appears on the `RunConfig` object you passed in. One `RunConfig` is safe
to reuse across runs.

The Gemini API backend rejects `transparent` and the model provider strips it.
Vertex AI accepts it.

## Saving live blobs

`saveLiveBlob` defaults to `false`. Turn it on and every live event carrying
inline audio, video or image data is written to the artifact service before the
session event is stored. The stored event carries an
`[Uploaded Artifact: "<name>"]` text part in place of the blob, plus a
`fileData` part when the artifact service exposes a canonical URI.

The event you receive from `runLive` is unchanged. It still carries the raw
`inlineData`, so a client can play the audio while the artifact is written.

The flag needs an artifact service on the `Runner`. Without one it does nothing
and the run continues; it does not throw. A failed save also does not stop the
run — the runner logs it and keeps the original part.

Each chunk becomes a new version of one artifact, named
`artifact_<invocationId>_<partIndex>` unless the blob carries a `displayName`.
adk-js does not concatenate the chunks of a turn into a single file.

## Explicit voice activity signals

`explicitVadSignal` has no default: leaving it out and setting it to `false` are
different states on the wire. Setting it to `true` only tells the server to
expect the signals. Your application still has to send them.

```ts
liveRequestQueue.sendActivityStart();
liveRequestQueue.sendRealtime({data: chunk, mimeType: 'audio/pcm;rate=16000'});
liveRequestQueue.sendActivityEnd();
```

Both methods already exist on `LiveRequestQueue` and the live flow already
dispatches them, so the flag is the only piece that was missing.

## Defaults

| Field               | Default |
| ------------------- | ------- |
| `sessionResumption` | absent  |
| `saveLiveBlob`      | `false` |
| `explicitVadSignal` | absent  |

`createRunConfig` applies the `saveLiveBlob` default. It leaves the other two
absent on purpose, because an empty object and an absent field mean different
things to the Live server.
