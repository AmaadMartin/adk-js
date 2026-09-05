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

This module declares types only. TypeScript erases them at compile time, so a
value that arrives as `unknown` is not checked for you. `google/adk-python`
validates these models on construction because pydantic does it for free;
adk-js relies on the compiler instead. Validate a value you read from an
untyped source at the point you receive it.

## Get started

Score a candidate agent, then return the best agent you found.

```typescript
import {
  LlmAgent,
  OptimizerResult,
  UnstructuredSamplingResult,
} from '@google/adk';

const sampled: UnstructuredSamplingResult = {
  scores: {train1: 0.8, train2: 0.0},
  data: {train1: {output: 'result'}, train2: {}},
};

const tunedAgent = new LlmAgent({name: 'tuned_agent'});

const best: OptimizerResult = {
  optimizedAgents: [{optimizedAgent: tunedAgent, overallScore: 0.9}],
};
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
too. An `overallScore` of `0` is a real score, not an absent one.

## Extend the types with your own metrics

An optimizer that reports more than one number extends `AgentWithScores` and
parameterizes `OptimizerResult` on the subtype.

```typescript
import {AgentWithScores, LlmAgent, OptimizerResult} from '@google/adk';

interface AgentWithLatency extends AgentWithScores {
  medianLatencyMs: number;
}

const front: OptimizerResult<AgentWithLatency> = {
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
};
```

Both agents stay in the front because neither wins on both measures.

## Relationship to ADK Python

These types mirror `google.adk.optimization.data_types` field for field, under
the names TypeScript uses.

| ADK Python                   | ADK TypeScript               |
| ---------------------------- | ---------------------------- |
| `SamplingResult`             | `SamplingResult`             |
| `UnstructuredSamplingResult` | `UnstructuredSamplingResult` |
| `AgentWithScores`            | `AgentWithScores`            |
| `OptimizerResult[T]`         | `OptimizerResult<T>`         |
| `optimized_agent`            | `optimizedAgent`             |
| `overall_score`              | `overallScore`               |
| `optimized_agents`           | `optimizedAgents`            |
