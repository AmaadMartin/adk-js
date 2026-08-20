# LiveRequestQueue input signals

`LiveRequestQueue` is the channel an application uses to push input into a live
(bidirectional streaming) agent run. Besides content and audio, it carries
control signals that tell the model something about the input stream itself.

## Introduction

In a live run the application and the model talk at the same time. `Runner.runLive`
yields events from the model, and the application pushes input through a
`LiveRequestQueue`. Each `send*` method enqueues one `LiveRequest`, and the
agent's live send loop translates it into a Live API client message. Building
that wire message is the connection layer's job, so the application never
constructs one itself.

Most input is content (`sendContent`) or realtime media chunks (`sendRealtime`).
The remaining methods are signals about the stream rather than data on it:

- `sendActivityStart()` and `sendActivityEnd()` mark where user input begins and
  ends. Use them when automatic Voice Activity Detection (VAD) is off and the
  application decides the boundaries itself.
- `sendAudioStreamEnd()` says the audio input stream has finished, for example
  because the user muted or switched off the microphone. The model stops
  expecting further audio chunks and flushes the audio it has buffered.

`sendAudioStreamEnd()` is not an end-of-turn marker, and this is the mistake to
avoid. Under VAD the Live API already finds utterance boundaries on its own. If
you send the signal after every conversational turn, you close the audio stream
each turn, and a new audio message is then needed to reopen it. Send it when the
microphone actually stops, not when the user stops talking.

## Get started

Stream microphone audio, then close the audio stream when the user mutes:

```ts
import {LiveRequestQueue} from '@google/adk';

const queue = new LiveRequestQueue();

// Each chunk of captured microphone audio.
queue.sendRealtime({mimeType: 'audio/pcm', data: chunkBase64});

// The user muted the microphone: no more audio is coming.
queue.sendAudioStreamEnd();
```

Driving a live agent with that queue:

```ts
import {LiveRequestQueue, LlmAgent, Runner} from '@google/adk';

const runner = new Runner({appName, agent, sessionService, artifactService});
const queue = new LiveRequestQueue();

const run = (async () => {
  for await (const event of runner.runLive({
    userId,
    sessionId,
    liveRequestQueue: queue,
  })) {
    handle(event);
  }
})();

queue.sendRealtime({mimeType: 'audio/pcm', data: chunkBase64});
queue.sendAudioStreamEnd();
queue.close();
await run;
```

## Signal precedence

One `LiveRequest` can carry several fields. The live send loop reads them in a
fixed order and acts on the first one it finds:

```
close > activityStart > activityEnd > audioStreamEnd > blob > content
```

So a request with both `audioStreamEnd` and `blob` sends only the
audio-stream-end signal. The `send*` helpers each set exactly one field, so this
matters only if you build a `LiveRequest` by hand and pass it to `send()`.

The queue itself stays first-in first-out. Precedence applies inside a single
request, never across requests.

## Failure modes

`sendAudioStreamEnd()` goes through `send()`, so a closed queue rejects it:

```ts
const queue = new LiveRequestQueue();
queue.close();
queue.sendAudioStreamEnd(); // throws Error('Cannot send to a closed queue.')
```

The signal creates no event and writes nothing to the session. It is a
fire-and-forget message to the model.

Not every connection supports the signal. `BaseLlmConnection.sendAudioStreamEnd`
is optional, and the live send loop calls it only when the connection implements
it. `GeminiLlmConnection` does. A connection that does not implement it drops
the signal silently.
