# saveLiveBlob

`RunConfig.saveLiveBlob` keeps the audio of a live session. Turn it on and ADK
writes each turn's user audio and model audio to the artifact service, then puts
a reference to each file in the session. It is off by default.

## Introduction

A live session streams audio in both directions, but the session keeps almost
none of it. The runner drops every model event that carries inline audio,
because storing raw blobs in the conversation history would make it enormous.
What survives is the transcriptions, and a transcription is not enough to
review what a caller actually said or what the model actually played.

`saveLiveBlob` closes that gap without reintroducing the size problem. ADK
accumulates the audio chunks of a turn in memory, one buffer per direction, and
writes each buffer to the artifact service as a single audio file when the turn
ends. The session then receives one event per direction whose part is a
`fileData` reference, not the bytes. The history stays small, and the audio is
in the artifact service where you can fetch it.

Two things this feature is not. It does not persist video: only parts whose mime
type starts with `audio/` are kept. It is also not a substitute for
`saveInputBlobsAsArtifacts`, which applies to the ordinary `runAsync` path and
saves one artifact per input part; `saveLiveBlob` applies to `runLive` and
combines a whole turn into one artifact.

## Get started

`saveLiveBlob` needs an artifact service on the `Runner`. Without one nothing is
written, and the run continues as if the flag were off.

```ts
import {
  InMemoryArtifactService,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';

const artifactService = new InMemoryArtifactService();
const runner = new Runner({
  appName: 'live_app',
  agent: new LlmAgent({name: 'agent', model: 'gemini-3.1-flash-live-preview'}),
  sessionService: new InMemorySessionService(),
  artifactService,
});

const liveRequestQueue = new LiveRequestQueue();
liveRequestQueue.sendRealtime({data: pcmBase64, mimeType: 'audio/pcm'});

// Collects each turn's audio references, e.g.
// artifact://live_app/user/session/_adk_live/
//   adk_live_audio_storage_output_audio_1717171717171.pcm#0
const audioRefs: string[] = [];
for await (const event of runner.runLive({
  userId: 'user',
  sessionId: 'session',
  liveRequestQueue,
  runConfig: {saveLiveBlob: true},
})) {
  const fileUri = event.content?.parts?.[0]?.fileData?.fileUri;
  if (fileUri) {
    audioRefs.push(fileUri);
  }
}
```

Note that `sendRealtime` takes base64-encoded audio, because `@google/genai`
types `Blob.data` as a string. ADK decodes the chunks before it joins them, so
the artifact holds the raw audio.

## What gets written

Each flush produces one artifact and one event per direction that has audio.

The artifact filename is
`adk_live_audio_storage_<input_audio|output_audio>_<timestamp>.<extension>`. The
timestamp is when the turn's first chunk arrived, in epoch milliseconds, so the
name says when the recording started rather than when it was saved. The
extension comes from the first chunk's mime type, with any parameter removed:
`audio/pcm;rate=24000` gives `pcm`.

The event carries a single `fileData` part whose `fileUri` is
`artifact://<appName>/<userId>/<sessionId>/_adk_live/<filename>#<version>`. The
user's audio is authored by `user`; the model's audio is authored by the agent.
Because the part is `fileData` and not `inlineData`, the runner's live-media
filter lets the event through and the session stores it.

Read an artifact back with the same service you gave the `Runner`:

```ts
const audio = await artifactService.loadArtifact({
  appName: 'live_app',
  userId: 'user',
  sessionId: 'session',
  filename: 'adk_live_audio_storage_output_audio_1717171717171.pcm',
});
const bytes = Buffer.from(audio?.inlineData?.data ?? '', 'base64');
```

## When a flush happens

The turn's audio is written when the model reports the turn is over.

- `turnComplete` flushes both directions.
- `interrupted` flushes the model's audio only. The user is still speaking, so
  their audio stays in the cache and joins the next flush.

The control event itself is still emitted after the flushed events, so a client
that waits for `turnComplete` to end a turn keeps working.

## Failure modes and limits

A failed write never stops the session. If the artifact service rejects the
save, ADK logs the error, keeps the cached audio, and emits no event; that audio
is written by the next successful flush. If no artifact service is configured,
nothing is written and the audio stays cached.

Each direction's cache is capped at 10 MiB of decoded audio. When a new chunk
would exceed the cap, the oldest chunks are dropped, so a turn that never
completes keeps a rolling window of the most recent audio instead of growing
without bound. A single chunk larger than the cap is kept on its own.

A chunk with no data is refused. ADK logs a warning and continues, and the chunk
is still sent to the model.
