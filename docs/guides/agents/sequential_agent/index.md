# SequentialAgent resumability

`SequentialAgent` runs its sub-agents in order. In a resumable app it also
records which sub-agent it is about to run, so a later invocation continues from
that point instead of running the whole sequence again. Reach for this when a
step in the pipeline is slow, costly, or waits for a person.

## Introduction

A pipeline built from `SequentialAgent` is all-or-nothing by default. If the
process stops after the second of three steps, the next run repeats all three.
Every model call and every tool call happens twice. A step that asks a person to
approve something is worse still: nothing in the agent can wait for the answer,
so the pipeline has no way to stop and continue later.

Resumability solves both with one mechanism. Before each sub-agent runs, the
sequential agent writes a checkpoint naming that sub-agent, and emits it as an
event. The event goes into the session like any other, so the checkpoint
outlives the process. On the next invocation the agent reads the checkpoint back
and starts at the sub-agent it names.

The same mechanism handles pausing. A long-running function call — the ADK
pattern for human-in-the-loop — stops the sequence where it is. The checkpoint
still names the current sub-agent, and no end-of-agent event is written, so the
next invocation re-enters at that sub-agent.

Two things bound the feature. Resumability is a property of the `App`, not of
the agent, so one setting covers the whole tree. And it is off by default: with
no `resumabilityConfig` a `SequentialAgent` emits exactly the events its
sub-agents emit, and writes no checkpoints at all.

## Get started

Turn resumability on with `createResumabilityConfig` on the `App`, and pass an
`invocationId` you can name again later.

```ts
import {
  App,
  createResumabilityConfig,
  InMemorySessionService,
  LlmAgent,
  Runner,
  SequentialAgent,
} from '@google/adk';

const app = new App({
  name: 'pipeline_app',
  rootAgent: new SequentialAgent({
    name: 'pipeline',
    subAgents: [
      new LlmAgent({name: 'research', model: 'gemini-2.5-flash'}),
      new LlmAgent({name: 'review', model: 'gemini-2.5-flash'}),
      new LlmAgent({name: 'publish', model: 'gemini-2.5-flash'}),
    ],
  }),
  resumabilityConfig: createResumabilityConfig({isResumable: true}),
});

const sessionService = new InMemorySessionService();
await sessionService.createSession({
  appName: app.name,
  userId: 'u1',
  sessionId: 's1',
});

const runner = new Runner({app, sessionService});

const checkpoints: string[] = [];
for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: 's1',
  invocationId: 'inv-1',
  newMessage: {role: 'user', parts: [{text: 'write me a report'}]},
})) {
  const state = event.actions.agentState;
  if (state) {
    checkpoints.push(String(state['current_sub_agent']));
  }
}
```

The runner generates an invocation id when you omit it, and a generated id gives
you nothing to resume against.

## Resuming an invocation

Suppose `review` issues a long-running call to ask a person for approval. The
run above stops there: `checkpoints` holds `['research', 'review']`, `publish`
never runs, and no end-of-agent event is emitted.

Call `runAsync` again with the same `invocationId`. The runner rebuilds the
agent states of that invocation from the session, and the sequential agent
starts at the sub-agent its checkpoint names.

```ts
const authors: Array<string | undefined> = [];
for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: 's1',
  invocationId: 'inv-1',
  newMessage: {role: 'user', parts: [{text: 'approved'}]},
})) {
  authors.push(event.author);
}
```

`authors` is `['review', 'pipeline', 'publish', 'pipeline']`. `research` does
not run again. The two `pipeline` entries are the checkpoint before `publish`
and the end-of-agent event that closes the run.

Reusing the id of an invocation that already finished starts the sequence over,
because the end-of-agent event cleared its checkpoint. Only a paused or
interrupted invocation resumes.

## The event stream

A resumable run adds two kinds of event to the stream, both authored by the
sequential agent itself.

- A checkpoint before each sub-agent, carrying
  `actions.agentState.current_sub_agent`.
- An end-of-agent event after the last sub-agent, carrying
  `actions.endOfAgent`.

So `n` sub-agents that each emit one event produce `2n + 1` events. A resumed
run emits one checkpoint fewer, because the checkpoint for the sub-agent it
resumes into is already in the session.

The persisted key is `current_sub_agent`, in snake case. That is the key
adk-python writes, so a session written by either SDK is readable by the other.
The exported `SequentialAgentState` type declares the same name, so it
describes the payload you read off an event.

## Pausing on a long-running call

After each event from a sub-agent, the agent asks the invocation context whether
to pause. It pauses on a function call whose id is listed in the event's
`longRunningToolIds` and that nothing has answered yet. The current sub-agent
finishes streaming its events first; the sub-agents after it do not run, and no
end-of-agent event is emitted.

A later `user` event whose branch carries the call id as a run id means the call
is already being answered, so it does not pause the invocation.

## Failure modes

- **A corrupt checkpoint throws.** A `current_sub_agent` that is not a string,
  or an unexpected field in the state, raises an `Error` naming the field. A
  corrupt checkpoint that silently restarted the pipeline would be harder to
  diagnose than a loud failure.
- **A removed sub-agent restarts the sequence.** If the checkpoint names a
  sub-agent that is no longer in `subAgents`, the agent logs a warning and runs
  from the beginning. This is not an error: editing a pipeline between runs is
  expected.
- **An empty checkpoint means the run finished.** A checkpoint whose
  `current_sub_agent` is empty runs no sub-agent, and emits only the
  end-of-agent event.
- **An empty `subAgents` list emits nothing**, including no end-of-agent event.
