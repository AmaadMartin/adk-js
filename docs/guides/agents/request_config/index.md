# Per-run request configuration

`RunConfig` carries settings that belong to one run, not to the agent.
`BasicLlmRequestProcessor` merges them into the model request. Reach for it when
one caller needs a different timeout, a billing label, or a live-session
setting, and the agent itself must stay unchanged.

## Introduction

An `LlmAgent` holds a `generateContentConfig` that describes how that agent
always calls its model. A `RunConfig` describes one run. The two meet in
`BasicLlmRequestProcessor`, the first request processor in the chain: it copies
the agent's configuration onto the request, then merges the run's settings over
it. The run wins, because the run is the more specific of the two.

The processor copies rather than aliases. Every array and plain object on
`generateContentConfig` is copied onto the request, so a `beforeModelCallback`
that appends a safety setting changes that one request and not the agent. The
same holds in the other direction: the run config's `httpOptions` and
`sessionResumption` are copied in, so request assembly cannot write back into an
object the caller still holds. Without those copies an agent accumulates edits
across invocations, and a `RunConfig` reused for a second run carries a stale
session-resumption handle into it.

Two fields need naming. `httpOptions` merges key by key, so the run can override
a timeout or add a header while the agent's other headers survive; `baseUrl` and
`apiVersion` are configuration-time settings and never overwrite ones the agent
set. `labels` merges per key, which is what makes billing attribution per run
possible.

A live session reads `liveConnectConfig`, not `config`, so the processor also
fills the live connection's sampling settings from the agent and its transport
settings from the run config.

## Get started

```ts
import {InMemoryRunner, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-3.5-flash',
  generateContentConfig: {
    temperature: 0.2,
    httpOptions: {timeout: 1000, headers: {'X-Agent': 'assistant'}},
  },
});

const runner = new InMemoryRunner({appName: 'demo', agent});
const session = await runner.sessionService.createSession({
  appName: 'demo',
  userId: 'user-1',
});

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Hello'}]},
  runConfig: {
    httpOptions: {timeout: 5000},
    labels: {'goog-originating-logical-product-id': 'demo'},
  },
})) {
  // The request carries timeout 5000, the agent's X-Agent header, and the label.
}
```

## What the run config contributes

| Field                                                                                                                                                                                                    | Where it lands       | Merge rule                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpOptions`                                                                                                                                                                                            | `config.httpOptions` | Per key. `timeout`, `retryOptions` and `extraBody` replace; `headers` merge; `baseUrl` and `apiVersion` apply only when the agent set no options. |
| `labels`                                                                                                                                                                                                 | `config.labels`      | Per key, the run winning.                                                                                                                         |
| `responseModalities`, `speechConfig`, `inputAudioTranscription`, `outputAudioTranscription`, `realtimeInputConfig`, `explicitVadSignal`, `translationConfig`, `contextWindowCompression`, `avatarConfig` | `liveConnectConfig`  | Assigned. An unset field clears the live field.                                                                                                   |
| `sessionResumption`                                                                                                                                                                                      | `liveConnectConfig`  | Copied, then the live flow writes each server-issued handle onto the copy.                                                                        |
| `enableAffectiveDialog`, `proactivity`                                                                                                                                                                   | `liveConnectConfig`  | Assigned, unless the live model is a Gemini 3.x live model.                                                                                       |

The agent contributes `temperature`, `topP`, `topK`, `maxOutputTokens`, `seed`
and `mediaResolution` to `liveConnectConfig`, but only where the field is still
unset. Anything already on the live connect config outranks the agent.

## Gemini 3.x live models

Gemini 3.x live models reject `enableAffectiveDialog` and `proactivity`. The
processor clears both for those models, so a run config that sets them still
opens a connection. Gemini 3.5 live translate models are excluded from that
rule and keep both fields.

## When the run config is absent

`InvocationContext.runConfig` is optional in adk-js. When it is missing the
processor skips the live-connect block entirely and leaves `liveConnectConfig`
as the caller built it. This differs from adk-python, which raises a
`ValueError`.
