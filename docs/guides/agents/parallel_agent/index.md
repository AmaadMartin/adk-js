# ParallelAgent

`ParallelAgent` runs its sub-agents at the same time and merges their events
into one stream. Reach for it when several agents attack the same task
independently — different algorithms, or several drafts for a later reviewer
agent to judge.

> `ParallelAgent` is deprecated in favour of `Workflow`, which expresses the
> same fan-out as a graph and adds routing, retries and human-in-the-loop.
> `Workflow` cannot yet be an `LlmAgent` sub-agent, so `ParallelAgent` remains
> the option inside an agent tree.

## Introduction

A `SequentialAgent` runs its sub-agents one after another, and each one sees
what the previous one said. That is the wrong shape when the sub-agents are
meant to be independent: it is slow, and each answer is coloured by the answer
before it.

`ParallelAgent` starts every sub-agent at once and gives each one its own
branch. A branch isolates conversation history only. A sub-agent sees the events
that led to the fan-out and its own events, but not a sibling's. Session state
is shared, so two branches writing the same state key leave the value written
last.

The merged stream preserves backpressure. A sub-agent is asked for its next
event only after the caller has taken the previous one, so one slow consumer
does not let a fast sub-agent run ahead unbounded.

The fan-out ends in one of three ways. Every branch finishes; a direct
sub-agent escalates, which stops the branches still running; or a branch
throws, which stops the fan-out and hands the caller that error. In all three
cases every branch is closed, so a sub-agent's own cleanup runs.

## Get started

```ts
import {LlmAgent, ParallelAgent} from '@google/adk';

const optimistAgent = new LlmAgent({
  name: 'optimist',
  model: 'gemini-2.5-flash',
  instruction: 'Argue for the proposal in at most three sentences.',
});

const pessimistAgent = new LlmAgent({
  name: 'pessimist',
  model: 'gemini-2.5-flash',
  instruction: 'Argue against the proposal in at most three sentences.',
});

export const rootAgent = new ParallelAgent({
  name: 'debate',
  description: 'Collects an argument for and against, at the same time.',
  subAgents: [optimistAgent, pessimistAgent],
});
```

Both sub-agents run at once. Their events arrive interleaved, in the order each
one produces them.

## Branches

Each sub-agent runs on `<parent branch>.<parallel agent>.<sub-agent>`, and every
descendant of that sub-agent shares the string. In the example above the
optimist's events carry `debate.optimist` and the pessimist's carry
`debate.pessimist`. Nest a `SequentialAgent` under the fan-out and all of its
sub-agents' events carry the one branch of the sequential agent.

A parallel agent with no sub-agents produces nothing and does no work.

## Ending the fan-out early

An event whose `actions.escalate` is set stops the workflow that directly
encloses its author. When a **direct** sub-agent of the parallel agent escalates,
the parallel agent yields that event and then stops its remaining branches.

An escalation from deeper in the tree is not addressed to the parallel agent. A
`LoopAgent` sub-agent whose own child escalates ends that loop and re-yields the
event while it unwinds; the parallel agent's other branches keep running.

## Failures

If a sub-agent throws, the parallel agent closes every other branch and rethrows
that same error object — not a wrapper — so a caller can match on its type. When
several branches fail, the earliest failure is the one the caller sees.

Closing a branch runs its `finally` blocks. If a branch fails while being
closed, the parallel agent logs a warning instead of throwing, so the cleanup
failure cannot hide the error that ended the run.

## Resumable fan-out

When the app is built with `ResumabilityConfig({isResumable: true})`, the
parallel agent brackets its run with checkpoint events so a later run can pick
up where this one stopped.

```ts
import {App, createResumabilityConfig, Runner} from '@google/adk';

const runner = new Runner({
  app: new App({
    name: 'debate_app',
    rootAgent,
    resumabilityConfig: createResumabilityConfig({isResumable: true}),
  }),
  sessionService,
});
```

The stream then opens with an event carrying `actions.agentState` and closes
with one carrying `actions.endOfAgent`. Between them are the sub-agent events,
unchanged. A non-resumable run emits neither checkpoint.

Two rules govern the closing checkpoint:

- It is emitted only when every sub-agent recorded that it finished, or when a
  direct sub-agent escalated.
- It is withheld when an event paused the invocation — a request for a
  long-running tool that nothing has answered yet. The parallel agent is then
  left unfinished on purpose, so the invocation can resume later.

On a resumed run, a sub-agent already marked finished is skipped and does not
run again.
