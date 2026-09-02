# RunConfig

`RunConfig` carries the settings that belong to one run rather than to the
agent: labels and timeouts, how many LLM calls a run may make, what metadata
every event carries, how much of the session to load, and the live session
settings. You pass it to `Runner.runAsync` or `Runner.runLive`. Reach for it
when two callers share an agent but need different settings, and especially
when one process serves several tenants.

## Introduction

An agent is a long-lived object. A run is not. An `LlmAgent` owns its
long-lived configuration in `generateContentConfig`: temperature, tools, safety
settings. That object is built once and every invocation of the agent reads it.
Anything that changes per caller, per tenant, or per request does not fit
there — a billing label, a request timeout, the avatar a live session should
use.

`RunConfig` fills that gap. The runner threads it through session loading,
event persistence and the LLM request, so the agent object stays unchanged. The
merge never writes into your `RunConfig` either, so you can build one object and
reuse it across invocations.

Where a field exists on both sides, the `RunConfig` value wins. `labels` and
`httpOptions.headers` merge key by key; the rest overwrite.

`createRunConfig()` applies the defaults. It is the only factory; `RunConfig`
itself is a plain interface, so a partial object is a valid argument and the
runner fills in the rest.

Two fields are close enough to confuse. `customMetadata` is run-level and lands
on every event of the run. The `customMetadata` parameter of
`runner.runAsync()` is narrower: it stamps only the synthetic user event that
starts the run. When both set the same key, the parameter wins on that one
event.

## Get started

```ts
import {Event, InMemoryRunner, LlmAgent} from '@google/adk';

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

const events: Event[] = [];
for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'What day is it?'}]},
  runConfig: {
    labels: {team: 'search', cost_center: 'abc-123'},
    httpOptions: {timeout: 30_000, headers: {'x-request-id': 'req-1'}},
    customMetadata: {tenant: 'acme'},
    getSessionConfig: {numRecentEvents: 50},
    modelInputContext: [{role: 'user', parts: [{text: 'Today is Tuesday.'}]}],
  },
})) {
  // Every event carries {tenant: 'acme'}.
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

## Limiting LLM calls

`maxLlmCalls` bounds the calls a single run may make, which is what stops a
model and a tool from calling each other forever. The default is 500, and the
`ADK_MAX_LLM_CALLS` environment variable overrides it:

```sh
ADK_MAX_LLM_CALLS=100 node my-agent.js
```

An explicit `maxLlmCalls` always beats the environment variable. A value the
runner cannot read as an integer logs a warning and falls back to 500, so a typo
in a deployment does not break every run. A value of 0 or less removes the limit
and logs a warning.

## Tagging every event

`customMetadata` is merged onto every event the run yields and every event it
appends to the session:

```ts
import {RunConfig} from '@google/adk';

const runConfig: Partial<RunConfig> = {
  customMetadata: {tenant: 'acme', requestId: 'req-42'},
};
```

An event that already carries one of those keys keeps its own value. The merge
gives the run-level entries, not the last word.

## Loading part of a session

`getSessionConfig` reaches the session service as the `config` of its
`getSession` call, so a long conversation does not have to be read in full on
every turn:

```ts
const runConfig: Partial<RunConfig> = {
  getSessionConfig: {numRecentEvents: 50},
};
```

It accepts `numRecentEvents` and `afterTimestamp`. It pairs with event
compaction, where the compacted summary plus a bounded tail is the whole context
the agent needs.

## Per-turn context the session never stores

`modelInputContext` is added to the LLM request for this invocation only:

```ts
const runConfig: Partial<RunConfig> = {
  modelInputContext: [{role: 'user', parts: [{text: 'Today is Tuesday.'}]}],
};
```

The runner inserts a deep copy immediately before the user's message, so your
array is never aliased into the request. If no content in the request matches
the user's message, the context goes to the front. Nothing is written to the
session, so the next turn does not see it unless you pass it again.

## Per-request telemetry

`telemetry` takes a `TelemetryConfig`, which overrides the process-wide
`OTEL_*` environment variables for one run:

```ts
import {ContentCapturingMode, createTelemetryConfig} from '@google/adk';

const runConfig: Partial<RunConfig> = {
  telemetry: createTelemetryConfig({
    captureMessageContent: ContentCapturingMode.NO_CONTENT,
  }),
};
```

ADK-owned spans read this config, so the run above records no request, response
or tool content on its spans while the rest of the process keeps its default.
Each knob resolves in this order: the `ADK_TELEMETRY_IGNORE_RUN_CONFIG` admin
lock, then the per-request field, then the environment variable, then the
default. Set the lock to `1` or `true` and the per-request fields are ignored,
which is how an operator keeps control of a shared deployment.

A `TelemetryConfig` reads the environment once, when you construct it. A later
change to `process.env` does not alter an existing config, so no run gets half
of one telemetry setting and half of another. This type is experimental and its
API can change.

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

## Live runs

`runner.runLive()` reads the same config. `inputAudioTranscription` and
`outputAudioTranscription` both default to `{}`, which turns transcription on,
so a live request always carries both. Pass `StreamingMode.BIDI` to record that
a run is bidirectional; `runLive()` does not branch on the value, and
`runAsync()` ignores it.

`toolThreadPoolConfig` is accepted so that one configuration can drive several
ADK SDKs, but nothing here reads it. A tool callback is not
structured-cloneable, so Node cannot move it onto a worker thread; tools always
run on the main event loop.

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
