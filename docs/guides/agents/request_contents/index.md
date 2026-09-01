# Request contents

Every call an `LlmAgent` makes to a model carries a `contents` array built from
the session history. This guide explains which events reach that array, how
another agent's output is presented, and the four settings that change the
result.

---

## Introduction

The session stores everything that happened: user messages, model replies, tool
calls and their results, live audio transcriptions, and framework events such as
an authentication request. A model must not see all of it. The content request
processor runs before each model call and decides what to send.

It keeps the events that carry something the model can act on, and it drops the
rest. It rewrites another agent's output as user-role context, so the current
agent is never confused about who said what. It keeps a tool call next to the
result that answers it. It removes events annulled by a rewind.

Reach for this guide when the model is not seeing something you expect, or when
you run agents under an isolation scope and need to know what each one reads.

---

## Get started

Nothing here needs configuration. The processor is part of the default request
pipeline, so an ordinary agent already gets the behaviour below.

```ts
import {InMemoryRunner, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  instruction: 'Answer the user.',
});

const runner = new InMemoryRunner({agent, appName: 'demo'});
const session = await runner.sessionService.createSession({
  appName: 'demo',
  userId: 'u',
});

for await (const event of runner.runAsync({
  userId: 'u',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Hello'}]},
})) {
  // The request behind this turn carries the visible session history.
}
```

---

## What reaches the model

An event is sent when at least one of its parts is visible. A part is visible
when it carries text, inline data, file data, executable code or a code
execution result. Four kinds of part are always visible, whatever else they
hold:

- a function call and a function response, because one is work to do and the
  other is a result to read;
- a thought signature, which is opaque state the model expects back verbatim,
  and which often arrives on a part that holds nothing else;
- a server-side tool call and its response, which the model ran itself and
  expects echoed back.

A part marked `thought: true` is not visible by default. An event whose parts
are all invisible is dropped, and so is an event that only changed session
state. Authentication, tool confirmation and human-input events are dropped
too: they are an exchange between the framework and the client, not something
the model asked for.

### Live transcriptions

A live audio session reports what it heard and what it said as transcription
fragments on events that carry no content. Consecutive fragments of the same
kind are joined and sent as one content: input transcriptions become a `user`
turn, output transcriptions a `model` turn. Without this the model would see
nothing at all for a spoken turn.

### Another agent's output

An event authored by a different agent is rewritten as a `user` turn that opens
with `For context:`, and each part is labelled with the author. Its thoughts are
left out, because a thought is that agent's reasoning rather than its answer.
Set `includeThoughtsFromOtherAgents` on the run config to relay them as
`[author] thought: …` lines:

```ts
for await (const event of runner.runAsync({
  userId: 'u',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Review the draft'}]},
  runConfig: {includeThoughtsFromOtherAgents: true},
})) {
  // Other agents' thoughts now reach the model as labelled context.
}
```

The flag applies to the full history only. An agent with
`includeContents: 'none'` builds a current-turn request, where another agent's
thoughts stay out either way.

---

## Agents under an isolation scope

A workflow node can run under an isolation scope, and every event it emits
carries that scope tag. An agent reads only the events whose scope matches its
own exactly. A scoped agent therefore never sees the ambient conversation, and
an unscoped agent never sees a scoped agent's turns.

That leaves a scoped agent with no statement of its task, so the processor
prepends one. It looks for the function call whose id is the scope — the call
that delegated the task — and renders its arguments as the first `user` turn. A
workflow node dispatched without such a call uses the node input instead.

An agent in `single_turn` mode gets one more part on that turn: a sentence
telling it that no user replies will arrive, so it answers from the input alone.

---

## Tool call ids and the provider

ADK generates a fallback id, prefixed `adk-`, for a function call the model did
not label. Gemini pairs a call with its result by position, so those ids are
stripped before the request goes out.

A provider that pairs by id instead needs them kept. Set `pairsToolCallsById` on
the model class:

```ts
import {BaseLlm} from '@google/adk';

class MyProviderLlm extends BaseLlm {
  override readonly pairsToolCallsById = true;

  // …generateContentAsync and connect
}
```

Gemini on the Interactions API also keeps them, without any setting.

---

## Rewinds

An event whose `actions.rewindBeforeInvocationId` is set marks the history as
rewound to that invocation. The processor drops the marker together with every
event back to the first event of the named invocation, so a rewound turn never
reaches the model again. A marker naming an invocation that is not in the
history drops only itself.

---

## Malformed histories

A function response whose call is missing — a hand-edited session, or a history
stitched from two sources — is pruned, and the drop is logged at `warn` level. A
response that carries no id is left alone, because ids are stripped on the way
out for some providers and a missing id does not imply a missing call.
