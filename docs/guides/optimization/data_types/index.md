# Agent optimization data types

These four types are the contract between a sampler and an optimizer.
A sampler scores a candidate agent on a batch of examples. An optimizer reads
those scores and returns better agents. Reach for these types when you write
either side.

## Introduction

Agent optimization runs as a loop between two roles.

- A **sampler** takes a candidate agent and a batch of examples. It returns a
  `SamplingResult`: a score per example, where higher is better. A sampler that
  also captures inputs, trajectories or metrics returns an
  `UnstructuredSamplingResult`, which adds a `data` map keyed by the same
  example UIDs.
- An **optimizer** reads those scores and produces candidates. It returns an
  `OptimizerResult`: a list of `AgentWithScores`. The list is a
  [Pareto front](https://en.wikipedia.org/wiki/Pareto_front), so no agent in it
  is strictly better than another. An optimizer that improves one agent returns
  a list of one.

Both roles are pluggable, and both sides of the contract are extensible.
`OptimizerResult<T>` takes the agent type as a parameter, so an optimizer that
reports its own metrics extends `AgentWithScores` and names the subtype. A
sampler that reports its own fields extends `SamplingResult` the same way.

This module is types only. TypeScript erases the types at compile time, so they
carry no runtime validation. A value that arrives as `unknown` — read from
persisted JSON, or returned by a caller-supplied sampler — is not checked for
you. Validate it at the point you receive it.

## Get started

Build a sampling result. The compiler checks the shape.

```typescript
import {
  AgentWithScores,
  LlmAgent,
  OptimizerResult,
  UnstructuredSamplingResult,
} from '@google/adk';

const sampled: UnstructuredSamplingResult = {
  scores: {'example-1': 0.8, 'example-2': 0.4},
  data: {'example-1': {trajectory: ['roll_die', 'check_prime']}},
};

const candidate: AgentWithScores = {
  optimizedAgent: new LlmAgent({name: 'optimizer_candidate'}),
  overallScore: 0.8,
};

const front: OptimizerResult = {optimizedAgents: [candidate]};
```

Report a custom metric by extending `AgentWithScores` and naming the subtype.

```typescript
import {AgentWithScores, OptimizerResult} from '@google/adk';

interface AgentWithToolMetrics extends AgentWithScores {
  toolCallAccuracy: number;
}

function bestOf(
  result: OptimizerResult<AgentWithToolMetrics>,
): AgentWithToolMetrics {
  return result.optimizedAgents.reduce((best, next) =>
    next.toolCallAccuracy > best.toolCallAccuracy ? next : best,
  );
}
```

## Field reference

| Type                         | Field             | Meaning                                                               |
| ---------------------------- | ----------------- | --------------------------------------------------------------------- |
| `SamplingResult`             | `scores`          | A map from example UID to that example's score. Higher is better.     |
| `UnstructuredSamplingResult` | `data`            | Optional. A map from example UID to evaluation data for that example. |
| `AgentWithScores`            | `optimizedAgent`  | The optimized agent.                                                  |
| `AgentWithScores`            | `overallScore`    | Optional. The agent's overall score.                                  |
| `OptimizerResult<T>`         | `optimizedAgents` | The Pareto front of optimized agents.                                 |

`data` and `overallScore` are optional, so both read as `undefined` when unset.
An `overallScore` of `0` is a real score, not an absent one.

## Relationship to ADK Python

These types mirror `google.adk.optimization.data_types` field for field, under
the names TypeScript uses. ADK Python builds them as pydantic models, which
validate on construction. The TypeScript types are interfaces, so the compiler
checks them and nothing runs at runtime.

| ADK Python                   | ADK TypeScript               |
| ---------------------------- | ---------------------------- |
| `SamplingResult`             | `SamplingResult`             |
| `UnstructuredSamplingResult` | `UnstructuredSamplingResult` |
| `AgentWithScores`            | `AgentWithScores`            |
| `OptimizerResult[T]`         | `OptimizerResult<T>`         |
| `optimized_agent`            | `optimizedAgent`             |
| `overall_score`              | `overallScore`               |
| `optimized_agents`           | `optimizedAgents`            |
