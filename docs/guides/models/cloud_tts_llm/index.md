# CloudTtsLlm

`CloudTtsLlm` is a `BaseLlm` that speaks instead of writing. It sends the text
of a request to the Google Cloud Text-to-Speech API and returns the audio as an
`inlineData` part. Reach for it when a component that already drives a model
needs speech, and you would rather configure a model name than add an audio
code path.

## Introduction

Most models in ADK take text and produce text. An audio user simulator needs
the opposite end: a component that turns a written turn into something a live
agent can hear. Rather than give that component its own audio client,
`CloudTtsLlm` puts Cloud Text-to-Speech behind the ordinary `BaseLlm`
interface, so the caller keeps working in `LlmRequest` and `LlmResponse`.

The class registers itself with `LLMRegistry` under the name `cloud_tts`. A
configuration that names a model by string therefore reaches it the same way it
reaches a Gemini model, with no import of its own:

```typescript
import {LLMRegistry} from '@google/adk';

const llm = LLMRegistry.newLlm('cloud_tts');
```

`CloudTtsLlm` is not a conversational model. It ignores tools, system
instructions and the `stream` argument, and it has no live connection —
`connect()` rejects.

## Get started

`generateContentAsync` yields exactly one response. The audio arrives as
base64 in `inlineData.data`, which is what `@google/genai` uses for binary
parts.

```typescript
import {CloudTtsLlm, LlmRequest} from '@google/adk';
import {writeFile} from 'node:fs/promises';

const llm = new CloudTtsLlm({audioEncoding: 'MP3'});

const request: LlmRequest = {
  contents: [{role: 'user', parts: [{text: 'Book me a flight to Lisbon.'}]}],
  liveConnectConfig: {},
  toolsDict: {},
};

for await (const response of llm.generateContentAsync(request)) {
  const audio = response.content?.parts?.[0]?.inlineData;
  if (audio?.data) {
    await writeFile('speech.mp3', Buffer.from(audio.data, 'base64'));
  }
}
```

The example needs `@google-cloud/text-to-speech` installed and Application
Default Credentials configured. `GOOGLE_CLOUD_PROJECT` selects the project the
client runs against. Under user credentials the API also requires a quota
project, which google-auth-library reads from `GOOGLE_CLOUD_QUOTA_PROJECT`:

```shell
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_QUOTA_PROJECT=your-project
```

Without it the first call comes back as a `TTS_SYNTHESIS_FAILED` response
saying the quota project is not set.

## Voice selection

The voice comes from `config.speechConfig` on the request, not from a
constructor option, because it is per-request state:

```typescript
const request: LlmRequest = {
  contents: [{role: 'user', parts: [{text: 'Bonjour.'}]}],
  config: {
    speechConfig: {
      languageCode: 'fr-FR',
      voiceConfig: {prebuiltVoiceConfig: {voiceName: 'fr-FR-Neural2-A'}},
    },
  },
  liveConnectConfig: {},
  toolsDict: {},
};
```

Each field falls back on its own. A request that sets neither gets the voice
`en-US-Studio-O` and the language code `en-US`. The voice must match the
language code; see the
[Cloud Text-to-Speech voice list](https://cloud.google.com/text-to-speech/docs/voices)
for the names.

`speechConfig` also accepts a plain string in `@google/genai`. That shorthand
carries no language code, so `CloudTtsLlm` treats it as unset and uses both
defaults.

## Audio options

Encoding, speed and pitch belong to the model, so they are constructor
options:

```typescript
const llm = new CloudTtsLlm({
  audioEncoding: 'OGG_OPUS',
  speakingSpeed: 1.25,
  pitch: -2.0,
});
```

`audioEncoding` defaults to `LINEAR16` and decides the MIME type of the part:

| `audioEncoding` | `inlineData.mimeType` |
| --------------- | --------------------- |
| `LINEAR16`      | `audio/l16`           |
| `MP3`           | `audio/mpeg`          |
| `OGG_OPUS`      | `audio/ogg`           |
| `MULAW`         | `audio/basic`         |
| `ALAW`          | `audio/alaw`          |

Any other value throws, before the request reaches the API.

`speakingSpeed` is a multiplier defaulting to `1.0`, and `pitch` is a shift in
semitones defaulting to `0.0`. Passing `null` for either one leaves the field
out of the request, so the API default applies instead. `undefined` is not the
same thing: it selects the ADK default above.

## Installing the dependency

`@google-cloud/text-to-speech` is an optional peer dependency, so installing
`@google/adk` does not download it. Add it where you use this model:

```shell
npm install @google-cloud/text-to-speech
```

The SDK is loaded on the first synthesis call, not at import. Importing
`CloudTtsLlm` without the package installed is fine; calling
`generateContentAsync` then throws an error naming the package and this
command.

## Errors

A Cloud TTS API failure is reported on the response, not thrown, so a caller
looping over responses keeps its shape:

```typescript
for await (const response of llm.generateContentAsync(request)) {
  if (response.errorCode === 'TTS_SYNTHESIS_FAILED') {
    // response.errorMessage carries the API message. There is no content.
  }
}
```

Everything else throws, because none of it is a synthesis result the caller
could act on:

| Condition                                       | Behaviour                            |
| ----------------------------------------------- | ------------------------------------ |
| `audioEncoding` is not one of the five above    | Throws, before any API call          |
| The request carries no text part                | Throws                               |
| `@google-cloud/text-to-speech` is not installed | Throws, naming the install command   |
| The API succeeds but returns no audio           | Throws                               |
| `connect()`                                     | Rejects; there is no live connection |
