# AudioTranscriber

`AudioTranscriber` turns the audio an invocation buffered into text `Content`.
Reach for it when your model does not return transcriptions itself, and you
still want the turn's audio in the session history.

## Introduction

`InvocationContext.transcriptionCache` is a per-invocation list of
`TranscriptionEntry`. Each entry carries a `role` and either an audio `Blob` or
a `Content` that is already text. `AudioTranscriber` drains that list: it sends
the audio to Google Cloud Speech-to-Text and returns one `Content[]` in cache
order.

This is a different mechanism from the transcription the Gemini Live API
returns on the wire. `GeminiLlmConnection` already surfaces `inputTranscription`
and `outputTranscription` events for models that produce them, and the runner
writes those to the session. `AudioTranscriber` covers the other case, where the
transcript has to be produced from the raw audio.

Consecutive audio from one speaker is merged into a single recognition request,
so one utterance costs one round trip instead of one per chunk. A `Content`
entry ends the run before it and is passed through unchanged, which keeps the
speakers in the order they spoke. The cache is emptied once it has been
bundled, before any request runs, so a failed request never causes the same
audio to be transcribed twice.

`@google-cloud/speech` is an optional peer dependency. Installing `@google/adk`
does not download it, and `AudioTranscriber` loads it on the first call that
actually has audio to transcribe. A text-only cache never touches it.

## Get started

Install the peer and authenticate with Application Default Credentials against
a project that has the Speech-to-Text API enabled:

```sh
npm install @google-cloud/speech
```

Audio blobs must be 16 kHz mono LINEAR16 PCM, base64-encoded as the
`@google/genai` SDK represents `Blob.data`. The recognition config is fixed at
LINEAR16, 16000 Hz and `en-US`.

```ts
import {AudioTranscriber, InvocationContext} from '@google/adk';
import type {Content} from '@google/genai';

async function transcribeTurn(
  invocationContext: InvocationContext,
  pcm: Buffer,
): Promise<Content[]> {
  invocationContext.transcriptionCache = [
    {role: 'user', data: {mimeType: 'audio/pcm', data: pcm.toString('base64')}},
    {role: 'model', data: {role: 'model', parts: [{text: 'Understood.'}]}},
  ];

  // [{role: 'user', parts: [{text: '<the transcript>'}]},
  //  {role: 'model', parts: [{text: 'Understood.'}]}]
  return new AudioTranscriber().transcribeFile(invocationContext);
}
```

## Failure modes

- `@google-cloud/speech` is not installed: the first call with audio throws an
  error naming `AudioTranscriber` and the `npm install` command.
- The Speech API rejects a request: the error propagates unchanged. There is no
  retry loop here, because the `google-gax` client already retries with
  backoff. The cache is already empty at that point, so the audio of the failed
  request is lost rather than retried on the next call.
- An audio entry with no `role` is dropped. `TranscriptionEntry.role` is
  documented as undefined only for function calls, which carry `Content`, so a
  role-less audio blob is not a case the framework produces. This matches
  adk-python.
