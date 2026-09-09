# Resuming an invocation

The `Runner` decides which invocation each call to `runAsync` belongs to. A tool
result rejoins the invocation that issued the call, and a reply sent while a
task agent is paused rejoins that task. Reach for this when your application
answers a tool call out of band, retries a turn, or drives an agent that pauses
to ask a question.

## Introduction

An invocation is one run of the root agent over one user turn. Every event the
run appends carries its `invocationId`, so the invocation is how the session
records which turn produced what.

Without the rules below, every call to `runAsync` would start a new invocation.
Two things break when it does. A function response answering an earlier call
lands in a turn that holds no such call, so the agent waiting on the result
never receives it. And a reply to a paused task agent lands outside that agent's
isolation scope, which is exactly the set of events the agent is allowed to see,
so the reply is filtered out of its view.

The runner resolves the invocation in this order:

1. An `invocationId` you pass is reconciled against the message's function
   responses, not trusted. The responses win, and a disagreement is logged.
2. Otherwise the function responses in the message are matched to the calls
   recorded in the session, and the invocation that issued them is used.
3. Otherwise, if a task agent is paused, the message joins that task's
   invocation and is stamped with its isolation scope.
4. Otherwise the run starts a new invocation.

Two rules keep a message unambiguous. Every function response in one message
must answer calls from the same invocation. And a message may not carry both
function responses and text, because a response continues a turn while text
starts one.

## Get started

Answer a tool call. No `invocationId` is needed: the response names the call, and
the call names the invocation.

```ts
import {InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  appName: 'booking',
  agent: new LlmAgent({name: 'booking_agent', model: 'gemini-2.0-flash'}),
});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId,
  newMessage: {
    role: 'user',
    parts: [
      {functionResponse: {id: 'fc-1', name: 'book', response: {ok: true}}},
    ],
  },
})) {
  // The invocation that issued `fc-1` continues.
}
```

## Resuming without a message

A resumable app can rerun an invocation from where it stopped, with no new
message at all. The runner recovers the user message that started the invocation
and runs the agent against it.

```ts
import {App, InMemorySessionService, Runner} from '@google/adk';

const app = new App({
  name: 'booking',
  rootAgent,
  resumabilityConfig: {isResumable: true},
});
const runner = new Runner({app, sessionService: new InMemorySessionService()});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId,
  invocationId: 'inv-1',
})) {
  // Picks up where inv-1 stopped.
}
```

Set `resumabilityConfig.isResumable` on the `App` for this. Without it, omitting
`newMessage` is an error.

## Guarantees

**One user event per invocation per turn.** Re-sending the same message under an
existing `invocationId` appends no second user event and does not re-run
`onUserMessageCallback`. The runner decides this from where the invocation id
came from, never from the message content, so a user who repeats themselves is
still heard.

**A borrowed invocation is still a new turn.** A message that joins a paused
task borrows that task's invocation id, but it is appended, it is the input the
task agent runs on, and it is not deduplicated against the earlier turn.

**A finished agent is not rerun.** Resuming onto an agent that already reported
the end of its run in that invocation yields nothing and appends nothing.

## Failure modes

| What you sent                                          | What you get                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| A function response with no `id`                       | `Function response id is required to resume an invocation.`         |
| A response whose call is not in the session            | `Function call not found for function response ids: …`              |
| Responses answering calls from two invocations         | `Function responses resolve to multiple invocations: …`             |
| Function responses and text in one message             | `Message cannot contain both function responses and text.`          |
| A function call in a user message                      | `User message cannot contain function calls.`                       |
| Neither `newMessage` nor `invocationId`                | `Running an agent requires either a newMessage or an invocationId…` |
| No `newMessage` on an app that is not resumable        | `Running an agent requires a newMessage or a resumable app.`        |
| An `invocationId` to resume against an empty session   | `Session <id> has no events to resume.`                             |
| An `invocationId` whose invocation has no user message | `No user message available for resuming invocation: <id>`           |
