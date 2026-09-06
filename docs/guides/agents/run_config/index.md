# RunConfig

`RunConfig` carries the settings that belong to one invocation rather than to
the agent. You pass it to `Runner.runAsync` or `Runner.runLive`. Reach for it
when two callers share an agent but need different labels, timeouts, or live
session settings.

## Introduction

An `LlmAgent` owns its long-lived configuration in `generateContentConfig`:
temperature, tools, safety settings. That object is built once and every
invocation of the agent reads it. Some settings do not fit there, because they
describe the caller rather than the agent — a billing label, a request timeout,
the avatar a live session should use.

`RunConfig` fills that gap. The runner merges it into the request it assembles,
so the agent object stays unchanged. The merge never writes into your
`RunConfig` either, so you can build one object and reuse it across
invocations.

Where a field exists on both sides, the `RunConfig` value wins. `labels` and
`httpOptions.headers` merge key by key; the rest overwrite.

## Get started

```ts
import {InMemoryRunner, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'agent',
  model: 'gemini-2.5-flash',
  generateContentConfig: {temperature: 0.2, labels: {tier: 'gold'}},
});
const runner = new InMemoryRunner({appName: 'app', agent});
const session = await runner.sessionService.createSession({
  appName: 'app',
  userId: 'u1',
});

const events = [];
for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'hello'}]},
  runConfig: {
    labels: {team: 'search', cost_center: 'abc-123'},
    httpOptions: {timeout: 30_000, headers: {'x-request-id': 'req-1'}},
  },
})) {
  events.push(event);
}
```

The model request carries `tier: 'gold'` from the agent plus both labels from
the `RunConfig`. The agent's own `labels` object is not modified.

## Request options

| Field         | Effect                                  |
| ------------- | --------------------------------------- |
| `httpOptions` | Merged into the request's HTTP options. |
| `labels`      | Merged over the agent's labels.         |

`httpOptions.headers` merge key by key, and `timeout`, `retryOptions` and
`extraBody` overwrite the agent's values. `baseUrl` and `apiVersion` configure
the client rather than one request, so they do not overwrite HTTP options the
agent already set.

## Live session options

These reach `liveConnectConfig`, so they apply to `Runner.runLive` only.

| Field               | Effect                                                        |
| ------------------- | ------------------------------------------------------------- |
| `avatarConfig`      | Selects a prebuilt avatar, or supplies a reference image.     |
| `explicitVadSignal` | Asks the model for explicit voice activity detection signals. |
| `translationConfig` | Configures speech-to-speech translation.                      |
| `sessionResumption` | Enables the session resumption mechanism.                     |
| `historyConfig`     | Controls the history exchange between client and server.      |

```ts
import {LiveRequestQueue} from '@google/adk';

const queue = new LiveRequestQueue();
const live = runner.runLive({
  userId: 'u1',
  sessionId: session.id,
  liveRequestQueue: queue,
  runConfig: {
    avatarConfig: {avatarName: 'ada', audioBitrateBps: 128_000},
    translationConfig: {targetLanguageCode: 'es-ES'},
    sessionResumption: {transparent: true},
    historyConfig: {initialHistoryInClientContent: true},
    explicitVadSignal: true,
  },
});
```

`sessionResumption` and `historyConfig` are copied onto the request rather than
aliased. The live flow writes into both while the session runs: it stamps each
server-issued resumption handle onto `sessionResumption`. Copying keeps that
write out of your `RunConfig`, so a reused object never carries a stale handle
into a later run.

A resumption handle you pass to `runLive` as `liveSessionResumptionHandle`
overrides `runConfig.sessionResumption`. The runner applies it before every
connect attempt.

`HistoryConfig` is declared by ADK rather than imported from `@google/genai`,
because the pinned version of that package does not export it.

## Keeping live audio and video

`Runner.runLive` yields every model event to you, but it does not persist the
ones carrying inline audio, video or image data. Raw blobs would otherwise fill
the session history.

Set `saveLiveBlob: true` to keep them. The runner sends each blob to the
artifact service first, then appends the event with a text placeholder in place
of the raw bytes:

```ts
const live = runner.runLive({
  userId: 'u1',
  sessionId: session.id,
  liveRequestQueue: queue,
  runConfig: {saveLiveBlob: true},
});
```

This needs an artifact service on the runner. Partial events are never saved,
so a stream of audio chunks does not produce one artifact per chunk.

`saveLiveAudio` is the deprecated name for this flag. Passing it logs a warning,
and passing `true` turns `saveLiveBlob` on even when you also set
`saveLiveBlob: false`. Use `saveLiveBlob`.
