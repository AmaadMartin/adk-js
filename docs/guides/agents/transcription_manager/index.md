# TranscriptionManager

`TranscriptionManager` turns a live-streaming transcription payload into an
`Event` with the right author and the right slot. Reach for it when you host a
live session yourself and receive `inputTranscription` or `outputTranscription`
payloads off the wire.

## Introduction

A live model streams two kinds of transcription: what the user said, and what
the model said. Both arrive as a `Transcription` from `@google/genai`, and
neither carries an author. The author rule is easy to get wrong, because it is
not symmetric: an input transcription is always authored by the literal string
`'user'`, while an output transcription is authored with the agent's name.

`TranscriptionManager` applies that rule and puts the payload in exactly one of
the two slots on the event. It also counts the transcriptions a session has
already recorded.

The manager does not write to the session. It builds the event and returns it,
so the caller decides whether to append it, yield it, or drop it. This mirrors
`google/adk-python`, where the same class is a standalone utility rather than a
step in a flow.

You do not need this class for the normal path. `LlmAgent` already handles
transcriptions inline when you run an agent live, and it also sets the `partial`
flag, which this class does not model. Use `TranscriptionManager` when you drive
the live connection yourself.

## Get started

```ts
import {InvocationContext, TranscriptionManager} from '@google/adk';

const transcriptions = new TranscriptionManager();

function onLiveTranscription(ctx: InvocationContext) {
  const userEvent = transcriptions.handleInputTranscription(ctx, {
    text: 'What is the weather today?',
  });
  // userEvent.author === 'user'
  // userEvent.inputTranscription === {text: 'What is the weather today?'}
  // userEvent.outputTranscription === undefined

  const modelEvent = transcriptions.handleOutputTranscription(ctx, {
    text: 'It is sunny.',
  });
  // modelEvent.author === the agent's name

  return [userEvent, modelEvent];
}
```

## Counting transcriptions

`getTranscriptionStats` walks `ctx.session.events` and returns the counts:

```ts
import {InvocationContext, TranscriptionManager} from '@google/adk';

function report(ctx: InvocationContext) {
  return new TranscriptionManager().getTranscriptionStats(ctx);
  // {inputTranscriptions: 2, outputTranscriptions: 1, totalTranscriptions: 3}
}
```

The two counters are independent. An event that carries both an input and an
output transcription counts once on each side, so it adds 2 to
`totalTranscriptions`. The function reads the session and returns a fresh
object; it never mutates anything.

## Guarantees and failure modes

- An event this class builds never carries both transcription slots.
- The `Transcription` you pass in is stored by reference. No copy is made, so
  the object on the event is the object you handed over.
- Each event gets a fresh id and a `Date.now()` timestamp.
- `handleOutputTranscription` throws when the invocation has no agent, because
  it has no name to author the event with.
