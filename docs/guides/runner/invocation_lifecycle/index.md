# Runner invocation lifecycle

One call to `Runner.runAsync` is one invocation. This guide covers the four
controls over an invocation's lifetime: creating the session it runs in,
resuming an invocation that paused, scoping a reply to a task that is still
running, and rewinding an invocation that should not have happened.

## Introduction

A runner needs a session before it can run. By default it looks the session up
and reports `SessionNotFoundError` when there is none, because a mistyped
session id should be an error rather than a new empty conversation. A server
that owns the session id and expects the first use to create it sets
`autoCreateSession: true`.

An invocation does not always finish in one call. A long-running tool call
pauses it: the agent asks for approval, the run ends, and the answer arrives
later. Resuming needs the invocation id. The runner infers it from the function
response the caller sends, so the caller only has to echo the id of the call it
is answering. Every response in one message must answer calls from the same
invocation; a message that mixes two is refused rather than attributed to
whichever came first.

Rewinding is the opposite operation, and it is currently a partial one.
`rewindAsync` undoes the state an invocation wrote and restores the artifacts it
changed. It does **not** remove the conversation: nothing reads
`actions.rewindBeforeInvocationId` yet, so the model still sees the rewound
turns in its history. Use it to roll back side effects, not to erase a turn.

## Get started

```typescript
import {InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  appName: 'my_app',
  agent: new LlmAgent({name: 'assistant', model: 'gemini-2.5-flash'}),
  autoCreateSession: true,
});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: 'brand-new',
  newMessage: {role: 'user', parts: [{text: 'Hello'}]},
})) {
  console.log(event.author, event.content?.parts);
}
```

Without `autoCreateSession`, the same call rejects with `SessionNotFoundError`
and a message beginning `Session not found: brand-new`.

## Creating the session

`autoCreateSession` applies to `runAsync`, `runLive` and `rewindAsync` alike. It
defaults to `false`.

The `adk web` agent loader records which directory it found each root agent in.
When the runner's `appName` disagrees with that directory, the runner warns once
at construction and repeats the explanation in the session-not-found message:

```
Session not found: s1. The runner is configured with app name "my_app", but the
root agent was loaded from "/agents/weather_app", which implies app name
"weather_app". Ensure the runner appName matches that directory or pass appName
explicitly when constructing the runner. ...
```

That mismatch is the usual reason a session that was written cannot be found:
sessions are keyed by app name.

## Resuming an invocation

Set `resumabilityConfig` to make an app resumable. The runner then accepts a
message made of function responses and continues the invocation those responses
belong to.

```typescript
import {createResumabilityConfig, InMemoryRunner, LlmAgent} from '@google/adk';

const runner = new InMemoryRunner({
  appName: 'my_app',
  agent: new LlmAgent({name: 'assistant', model: 'gemini-2.5-flash'}),
  resumabilityConfig: createResumabilityConfig({isResumable: true}),
});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: 's1',
  newMessage: {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'fc-approval',
          name: 'ask_approval',
          response: {approved: true},
        },
      },
    ],
  },
})) {
  console.log(event.invocationId);
}
```

Every event carries the resumed invocation's id, not a new one. A caller that
already knows the id may pass `invocationId` instead; when both are given and
they disagree, the runner warns and uses the one the function responses resolve
to.

An `invocationId` with no `newMessage` resumes an invocation on a resumable app.
The runner finds the user message that started it, so the agent sees the
original turn. A user turn made only of function responses is skipped: it
answers the invocation rather than opening it.

Failure modes:

| Condition                                    | Result                              |
| -------------------------------------------- | ----------------------------------- |
| Neither `newMessage` nor `invocationId`      | `Error` naming the session and user |
| No `newMessage` and the app is not resumable | `Error` naming the session and user |
| A function response with no `id`             | `Error` asking for the id           |
| A response id that matches no function call  | `Error` listing the unmatched ids   |
| Responses that span two invocations          | `Error` listing the invocation ids  |
| Resuming a session with no events            | `Error` naming the session          |
| No user message found for the invocation     | `Error` naming the invocation       |

## Task-mode roots and the active task scope

An `LlmAgent` with `mode: 'task'` runs to completion through the `finish_task`
tool. As a runner root it takes the node path, so the `finish_task` arguments
land on the terminal event's `output`, and `outputKey` writes them to session
state.

A task agent declared with `isolationScope` builds its contents from that scope
alone. When such a task is paused and waiting for the user, the runner stamps
the new user event with the scope, so the reply is visible to the agent that
asked for it. The scope closes on a terminal `finish_task` result; a
`finish_task` response carrying an error leaves it open, because the agent sees
the error and retries.

Only a scope a task-mode agent wrote into counts. Any node may declare
`isolationScope`, and a plain node never calls `finish_task`, so its scope would
otherwise look open forever and every later user message would be hidden inside
it.

## Rewinding

```typescript
await runner.rewindAsync({
  userId: 'u1',
  sessionId: 's1',
  rewindBeforeInvocationId: 'inv-3',
});
```

The appended event carries three things: `actions.rewindBeforeInvocationId`, a
state delta that restores every non-shared key to the value it had before the
invocation, and an artifact delta. Keys prefixed `app:` or `user:` are left
alone, because they outlive the session.

Each artifact whose version changed after the rewind point is written again at
the version that was current then, under a new version number. An artifact that
did not exist at the rewind point is replaced with an empty
`application/octet-stream` blob; so is one whose old version can no longer be
loaded, with a warning. Artifacts prefixed `user:` are not touched.

`rewindAsync` rejects with `Invocation ID not found: <id>` when no event in the
session belongs to that invocation.

The conversation itself is untouched. `actions.rewindBeforeInvocationId` records
the intent, but no reader honours it, so the rewound turns stay in the history
the model is given.
