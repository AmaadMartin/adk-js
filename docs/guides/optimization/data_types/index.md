# Agent optimization data types

The optimization data types are the vocabulary a sampler and an optimizer
share. A sampler scores a candidate agent on a batch of examples. An optimizer
reads those scores and returns better agents. Reach for these types when you
write either side.

## Introduction

Agent optimization runs as a loop between two roles.

A **sampler** takes a candidate agent and a batch of examples. It returns a
`SamplingResult`: one score per example, where higher is better. The keys are
example UIDs, and the optimizer uses the same UIDs to ask for the next batch. A
sampler that also captures inputs, trajectories or metrics returns an
`UnstructuredSamplingResult`, which adds a `data` map under the same UIDs.

An **optimizer** reads those scores and produces candidates. It returns an
`OptimizerResult`: a list of `AgentWithScores`. The list is a
[Pareto front](https://en.wikipedia.org/wiki/Pareto_front), so no agent in it is
strictly better than another on every measure. An optimizer that improves one
agent returns a list of one.

Both sides of the contract are extensible. `OptimizerResult<T>` takes the agent
type as a parameter, so an optimizer that reports its own metrics extends
`AgentWithScores` and names the subtype. A sampler that reports its own fields
extends `SamplingResult` the same way.

Each type has a `createX` factory. TypeScript already checks a typed object
literal, so the factory exists for the values the compiler never sees: a sampler
is caller-supplied code, and its result reaches the optimizer unchecked. The
factory throws `InputValidationError` on a bad field. This is the same
validate-at-construction guarantee `google/adk-python` gets from pydantic, and
the same pattern `createRunConfig` already uses in this package.

## Get started

Score a candidate agent, then return the best agent you found.

```typescript
import {
  createAgentWithScores,
  createOptimizerResult,
  createUnstructuredSamplingResult,
  LlmAgent,
} from '@google/adk';

const sampled = createUnstructuredSamplingResult({
  scores: {train1: 0.8, train2: 0.0},
  data: {train1: {output: 'result'}, train2: {}},
});

const tunedAgent = new LlmAgent({name: 'tuned_agent'});

const best = createOptimizerResult({
  optimizedAgents: [
    createAgentWithScores({optimizedAgent: tunedAgent, overallScore: 0.9}),
  ],
});
```

`sampled.scores` maps each example UID to a number. `sampled.data` is optional:
provide it when the optimizer asks for full evaluation data, and omit it when
scores are enough.

## The four types

| Type                         | Field             | Required | Meaning                                 |
| ---------------------------- | ----------------- | -------- | --------------------------------------- |
| `SamplingResult`             | `scores`          | yes      | Example UID to score. Higher is better. |
| `UnstructuredSamplingResult` | `data`            | no       | Example UID to evaluation data.         |
| `AgentWithScores`            | `optimizedAgent`  | yes      | The optimized agent.                    |
| `AgentWithScores`            | `overallScore`    | no       | The agent's overall score.              |
| `OptimizerResult<T>`         | `optimizedAgents` | yes      | The Pareto front.                       |

`UnstructuredSamplingResult` extends `SamplingResult`, so it carries `scores`
too.

A factory returns the object you gave it, unchanged. `optimizedAgent` passes
through by reference: you get back the same `LlmAgent` instance, not a copy.
Extra fields survive as well, which is what makes the subtype below work.

## Extend the types with your own metrics

An optimizer that reports more than one number extends `AgentWithScores` and
parameterizes `OptimizerResult` on the subtype.

```typescript
import {
  AgentWithScores,
  createOptimizerResult,
  LlmAgent,
  OptimizerResult,
} from '@google/adk';

interface AgentWithLatency extends AgentWithScores {
  medianLatencyMs: number;
}

const front: OptimizerResult<AgentWithLatency> = createOptimizerResult({
  optimizedAgents: [
    {
      optimizedAgent: new LlmAgent({name: 'fast_agent'}),
      overallScore: 0.7,
      medianLatencyMs: 240,
    },
    {
      optimizedAgent: new LlmAgent({name: 'accurate_agent'}),
      overallScore: 0.9,
      medianLatencyMs: 980,
    },
  ],
});
```

Both agents stay in the front because neither wins on both measures.

## Failure modes

Every factory throws `InputValidationError` and names the field at fault. The
message quotes the example UID when the fault is inside a map.

| Condition                                      | Message                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `scores` is absent, `null`, or not an object   | `scores must be an object mapping each example UID to a number.`                   |
| A value in `scores` is not a number            | `scores['<uid>'] must be a number.`                                                |
| `data` is present and is not an object         | `data must be an object mapping each example UID to an object of evaluation data.` |
| A value in `data` is not an object             | `data['<uid>'] must be an object of evaluation data.`                              |
| `optimizedAgent` is not an `LlmAgent`          | `optimizedAgent must be an LlmAgent.`                                              |
| `overallScore` is present and is not a number  | `overallScore must be a number.`                                                   |
| `optimizedAgents` is absent or is not an array | `optimizedAgents must be an array.`                                                |

`createOptimizerResult` validates each element and lets the inner error through
unchanged, so a bad agent in the list reports the field that is wrong.

Two things the factories accept on purpose:

- `Infinity` and `NaN` are valid scores. `google/adk-python` accepts them, and
  rejecting them here would make a sampler behave differently in the two SDKs.
- An empty `scores` map and an empty `data` map are both valid. An empty `data`
  map is not the same as an omitted one.

One thing they refuse: a numeric string. pydantic coerces `"0.5"` to `0.5` in
its default mode; this package throws instead, because rewriting caller data at
an API boundary hides the sampler's bug rather than reporting it.
