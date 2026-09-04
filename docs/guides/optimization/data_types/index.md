# Agent optimization data types

These four types are the contract between a sampler and an optimizer.
A sampler scores a candidate agent on a batch of examples. An optimizer reads
those scores and returns better agents. Reach for these types when you write
either side, or when you read a result back from storage.

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

The compiler checks a value that TypeScript built. It cannot check one that
arrives as `unknown` — a result restored from persisted JSON, or returned by a
sampler that a caller supplied. Each type therefore has a `parse` function
that validates such a value and throws `InputValidationError` if it is wrong.
Use the interface when you build a value, and the `parse` function when you
receive one.

## Get started

Build a sampling result in code. The compiler checks it, so no validation runs.

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

Validate a result that arrives as `unknown`.

```typescript
import {
  InputValidationError,
  parseUnstructuredSamplingResult,
} from '@google/adk';

try {
  const restored = parseUnstructuredSamplingResult(JSON.parse(text));
  // restored.scores is a Record<string, number>.
} catch (error) {
  if (error instanceof InputValidationError) {
    // The stored result is not a valid sampling result.
  }
}
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

## What each validator rejects

Every validator throws `InputValidationError`. The message names the field that
failed.

| Validator                         | Rejects                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `parseSamplingResult`             | A missing `scores`, a `scores` that is not an object, or a score that is not a number.                      |
| `parseUnstructuredSamplingResult` | Everything above, plus a `data` that is not a map of objects.                                               |
| `parseAgentWithScores`            | An `optimizedAgent` that is not an `LlmAgent`, or an `overallScore` that is not a number.                   |
| `parseOptimizerResult`            | A missing `optimizedAgents`, one that is not an array, or an element that is not a valid `AgentWithScores`. |

Three behaviours are worth knowing before you rely on a validator.

- **An optional field reads back as `undefined`.** `data` and `overallScore` are
  optional. ADK Python writes an unset optional field as `null`, so both `null`
  and an absent key become `undefined`. An `overallScore` of `0` survives; it is
  a real score, not an absent one.
- **An undeclared key survives.** A subtype's extra fields are not deleted, so
  `parseAgentWithScores` keeps `toolCallAccuracy`. The validator checks the
  declared fields and passes the rest through.
- **A value is never coerced.** A score of `'0.5'` is rejected, not converted.
  ADK Python's models coerce a numeric string; these validators do not.

`parseAgentWithScores` passes `optimizedAgent` through by reference, so the
agent you get back is the agent you supplied. No validator freezes its result,
because an optimizer mutates the result it builds.
