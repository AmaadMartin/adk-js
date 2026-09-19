# Speaking the user's turns

`LlmAudioUserSimulator` turns a simulated user's written turn into speech, so
an eval case can drive an agent that listens instead of one that reads. Reach
for it when the agent under evaluation takes audio input and you want to score
it on the eval cases you already have.

## Introduction

A `UserSimulator` decides what the user says next. Every simulator adk-js ships
writes that turn as text: `StaticUserSimulator` replays a pre-authored script,
and a scenario-driven simulator generates the turn from a conversation plan. An
agent that accepts only audio cannot be evaluated by any of them.

`LlmAudioUserSimulator` closes that gap without a second family of simulators.
It is a decorator: you hand it the simulator that writes the text, and it
returns a `UserSimulator` that writes the same turn and speaks it. The wrapped
simulator is a black box — only its `getNextUserMessage` output is read — so
any simulator works, including one of your own.

The audio it produces is always 16 kHz PCM, tagged `audio/pcm;rate=16000`,
because that is the only input format the Live API accepts. Text-to-speech
models usually emit 24 kHz, so the simulator resamples every turn. It reads the
source rate from the mime type the model reported and warns when the model
reported none, rather than guessing in silence.

Two kinds of turn never reach the audio model. A result whose status is not
`SUCCESS` passes straight through, so the reasons a conversation ends —
`TURN_LIMIT_REACHED`, `STOP_SIGNAL_DETECTED` — behave as they do without the
decorator. So does a `SUCCESS` result carrying no text, which there is nothing
to speak.

## Get started

Wrap a text simulator and ask for a turn. This example replays a script, so the
only model call is the one that renders the audio.

```typescript
import {
  LlmAudioUserSimulator,
  parseLlmAudioUserSimulatorConfig,
  StaticUserSimulator,
  UserSimulatorStatus,
} from '@google/adk';

const simulator = new LlmAudioUserSimulator({
  config: parseLlmAudioUserSimulatorConfig({
    audioModel: 'gemini-2.5-flash-preview-tts',
    audioModelConfiguration: {responseModalities: ['AUDIO']},
  }),
  textSimulator: new StaticUserSimulator([
    {userContent: {role: 'user', parts: [{text: 'Book me a flight.'}]}},
  ]),
});

const next = await simulator.getNextUserMessage([]);
if (next.status === UserSimulatorStatus.SUCCESS) {
  // parts[0] is the text, parts[1] is the audio as base64 16 kHz PCM.
  const audio = next.userMessage?.parts?.[1].inlineData;
}
```

Set `includeTextWithAudio: false` to drop the text part and send audio alone.
The text part is on by default, because a transcript of what the simulated user
said makes an eval result readable.

## Choosing the audio model

`audioModel` names the model that renders the speech, and
`audioModelConfiguration` configures it. Voice selection goes in
`speechConfig`; the default names `en-US-Studio-O` speaking `en-US`. A Gemini
text-to-speech model additionally needs `responseModalities: ['AUDIO']`, as in
the example above.

The default `audioModel` is `'cloud_tts'`, which matches adk-python. adk-js has
no Cloud Text-to-Speech model registered, so leaving the default in place makes
the constructor throw `Model cloud_tts not found.` Name a Gemini
text-to-speech model instead, or pass your own `BaseLlm` as `audioLlm`:

```typescript
const simulator = new LlmAudioUserSimulator({
  config: parseLlmAudioUserSimulatorConfig({}),
  textSimulator,
  audioLlm: myOwnTtsModel,
});
```

`audioLlm` is also how you drive the simulator offline in a test: an injected
model is used as it is, and the registry is never consulted.

## Failure modes

The audio model is resolved in the constructor, so an unresolvable `audioModel`
throws when you build the simulator rather than part-way through a
conversation.

Two failures come from the model itself, and both throw from
`getNextUserMessage` and from `toAudioContent`:

- A response carrying an error code throws
  `Audio generation failed: <code> — <message>`.
- A stream that yields no audio bytes throws
  `Audio model returned no audio data`.

Neither is retried here. The request carries the eval system's default retry
policy, which the model client applies.

## Speaking text you already have

`toAudioContent` is the audio-generation entry point, and it is public. Call it
directly when you hold the text already and do not want a simulator to produce
it:

```typescript
const content = await simulator.toAudioContent('Book me a flight.');
```

It returns a `Content` with the role `user`, carrying the text part, then the
audio part.
