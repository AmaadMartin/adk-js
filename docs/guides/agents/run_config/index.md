# RunConfig

`RunConfig` holds the per-run knobs the runner reads: how many LLM calls a run
may make, what metadata every event carries, how much of the session to load,
and what extra context the model sees for this turn only. Reach for it when a
setting belongs to one run rather than to the agent, and especially when one
process serves several tenants.

---

## Introduction

An agent is a long-lived object. A run is not. Anything that changes per caller,
per tenant, or per request therefore does not belong on the agent, and
`RunConfig` is where it goes instead. You pass it to `runner.runAsync()` or
`runner.runLive()`, and the runner threads it through session loading, event
persistence and the LLM request.

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

const runner = new InMemoryRunner({
  agent: new LlmAgent({name: 'assistant', model: 'gemini-2.5-flash'}),
});
const session = await runner.sessionService.createSession({
  appName: runner.appName,
  userId: 'user',
});

const events: Event[] = [];
for await (const event of runner.runAsync({
  userId: session.userId,
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'What day is it?'}]},
  runConfig: {
    customMetadata: {tenant: 'acme'},
    getSessionConfig: {numRecentEvents: 50},
    modelInputContext: [{role: 'user', parts: [{text: 'Today is Tuesday.'}]}],
  },
})) {
  // Every event carries {tenant: 'acme'}.
  events.push(event);
}
```

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
