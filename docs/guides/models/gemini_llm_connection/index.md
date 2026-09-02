# GeminiLlmConnection

`GeminiLlmConnection` is the live session handle that `Gemini.connect()`
returns. Use it when you drive a Gemini Live session yourself instead of
running an agent, or when you need to know how ADK translates its own calls
into Gemini Live messages.

## Introduction

A live session is bidirectional. The client streams audio, video and text up,
and the model streams content, transcriptions and tool calls back. The Gemini
Live API accepts each of those on a different channel, and the right channel
depends on the model family. `GeminiLlmConnection` owns that routing, so a
caller sends a `Content` or a `Blob` and does not choose a channel.

The class implements `BaseLlmConnection`, which is the contract the live agent
flow uses. Three of its methods send, one receives:

- `sendHistory(history)` replays earlier turns into a new session.
- `sendContent(content, options)` sends one turn, or part of one.
- `sendRealtime(input)` sends a media chunk or a realtime control signal.
- `receive()` yields every `LlmResponse` until the session closes.

## Get started

```ts
import {Gemini, LlmRequest} from '@google/adk';
import {Modality} from '@google/genai';

const model = new Gemini({model: 'gemini-3.1-flash-live-preview'});
const request: LlmRequest = {
  model: 'gemini-3.1-flash-live-preview',
  contents: [],
  liveConnectConfig: {responseModalities: [Modality.TEXT]},
  toolsDict: {},
};

const connection = await model.connect(request);
await connection.sendContent({role: 'user', parts: [{text: 'Hello!'}]});

for await (const response of connection.receive()) {
  if (response.turnComplete) {
    break;
  }
}

await connection.close();
```

## Replaying history

`sendHistory` drops every audio part before it sends. The audio is already
transcribed, and sending it back as client content corrupts the session. A
turn that holds nothing but audio disappears; a turn that mixes audio with
text keeps its text. Images survive: only `audio/*` is dropped.

The `turnComplete` flag follows the last turn that survives the filter. It is
`true` when that turn has the role `user`, so the model answers, and `false`
when the model spoke last, so the model waits. A history that is empty after
filtering sends nothing at all.

Gemini 3.x Live needs one more message. It only starts generating when it
receives new user input, so replayed history alone leaves it waiting. When the
filtered history ends with a user turn, the connection sends a `'.'`
placeholder as realtime input, after the history. Live Translate models and
every other family get no placeholder.

## Sending a turn

`sendContent` routes on the parts it is given.

- Every part is a function response: the content goes to `sendToolResponse`.
  One part out of two being text is enough to send the whole content as client
  content instead, which keeps the text.
- A single text part on Gemini 3.x Live goes to `sendRealtimeInput`.
- Anything else goes to `sendClientContent`.

Pass `{partial: true}` to append to the turn without completing it. This is
what a caller feeding progressive typed text needs. A partial content always
goes through `sendClientContent`, even the single-text-part case above,
because realtime input always completes the turn.

```ts
await connection.sendContent(
  {role: 'user', parts: [{text: 'What is the'}]},
  {
    partial: true,
  },
);
await connection.sendContent({role: 'user', parts: [{text: ' weather?'}]});
```

## Realtime input

`sendRealtime` takes a `RealtimeInput`, which is a `Blob` or a
`LiveClientRealtimeInput`.

A `Blob` is media. Gemini 3.x Live and Gemini 3.5 Live Translate models take
audio on the `audio` channel and images on the `video` channel. Every other
model takes both on the `media` channel. A blob whose MIME type is neither
`audio/*` nor `image/*` is not sent on the dedicated channels; the connection
logs a warning instead.

A `LiveClientRealtimeInput` is a control signal. The connection reads
`activityStart`, `activityEnd` and `audioStreamEnd`, and warns on anything
else. Send `{audioStreamEnd: true}` when the microphone is switched off, so
the model flushes the audio it has buffered.

```ts
await connection.sendRealtime({mimeType: 'audio/pcm', data: audioChunk});
await connection.sendRealtime({audioStreamEnd: true});
```

`sendActivityStart()` and `sendActivityEnd()` are shorthand for the two
activity signals.

## Correlating responses

Gemini reports a session id in its setup acknowledgement. From that message
on, every `LlmResponse` that `receive()` yields carries it as
`liveSessionId`, including a response flushed when the session closes. Use it
to correlate telemetry with one live session. The field is absent when the
server reports no id.

```ts
for await (const response of connection.receive()) {
  const sessionId: string | undefined = response.liveSessionId;
  reportTelemetry(sessionId, response);
}
```
