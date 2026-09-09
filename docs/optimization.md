# AgentOptimizer and Sampler

`AgentOptimizer` and `Sampler` are the two interfaces that connect an agent
optimizer to an evaluation harness. The optimizer proposes candidate agents.
The sampler scores them against examples you own.

## Introduction

Tuning an agent by hand means editing the instruction, re-running an eval set,
and comparing numbers. The two interfaces split that loop in half so the halves
can be written by different people.

`Sampler` is the half you write. It answers which example UIDs belong to the
train set and the validation set, and it scores a candidate agent on a batch of
them. ADK does not know how your examples are stored or what a good score is,
so the whole evaluation side stays behind this interface.

`AgentOptimizer` is the half an optimizer author writes. It takes a starting
agent and a `Sampler`, and it returns an `OptimizerResult`. The result holds a
_Pareto front_ — a list of agents where no entry is strictly better than
another — so an optimizer that trades accuracy against cost can return both
agents instead of picking for you.

Both are plain TypeScript interfaces. They add no runtime code, so importing
them costs nothing. adk-js ships no concrete optimizer today; this release
lands the contract that optimizers and evaluation services implement.

## Get started

Implement `Sampler` over your own examples and scoring:

```ts
import {
  type LlmAgent,
  type SampleAndScoreParams,
  type Sampler,
  type SamplingResult,
} from '@google/adk';

declare function scoreWithYourHarness(
  candidate: LlmAgent,
  batch: string[],
): Promise<Record<string, number>>;

export class MyEvalSampler implements Sampler {
  getTrainExampleIds(): string[] {
    return ['ex_1', 'ex_2'];
  }

  getValidationExampleIds(): string[] {
    return ['ex_3'];
  }

  async sampleAndScore(params: SampleAndScoreParams): Promise<SamplingResult> {
    const batch =
      params.batch ??
      (params.exampleSet === 'train'
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    return {scores: await scoreWithYourHarness(params.candidate, batch)};
  }
}
```

Hand it to an optimizer with `optimizer.optimize(initialAgent, sampler)`. For a
complete train-then-validate loop, including an optimizer that returns several
candidates, read `core/test/optimization/agent_optimizer_test.ts`.

## The example sets

`Sampler` exposes two sets by UID. An optimizer reads `getTrainExampleIds()`
while it searches, and `getValidationExampleIds()` to score what it found.
Keeping the sets apart is what stops an optimizer from reporting a score it
already optimized against.

`SampleAndScoreParams.exampleSet` selects the set for one call. Its values are
the string literals `'train'` and `'validation'`, which match adk-python.

`batch` is the one parameter an optimizer may omit. Omitting it asks for every
example in the chosen set, so your implementation resolves it, as the sample
above does. adk-python spells the same sentinel `batch: Optional[list[str]] =
None`.

## Capturing full evaluation data

Scores alone tell an optimizer which candidate won, not why. When an optimizer
sets `captureFullEvalData: true`, the sampler must also return the data the
optimizer needs to improve the agent — inputs, trajectories and tool calls.

Return `UnstructuredSamplingResult` to carry it. The `data` field is keyed by
the same example UIDs as `scores`:

```ts
import {type UnstructuredSamplingResult} from '@google/adk';

const result: UnstructuredSamplingResult = {
  scores: {ex_1: 0.8},
  data: {ex_1: {toolCalls: ['lookup_charge'], output: 'Refunded.'}},
};
```

`UnstructuredSamplingResult` extends `SamplingResult`, so anything that accepts
the base result accepts it too. Declare your sampler as
`Sampler<UnstructuredSamplingResult>` and the optimizer receives the wider type.

## Custom metrics on a result

`AgentWithScores` carries one score. An optimizer that measures more can extend
the interface, and `OptimizerResult` threads the subtype through:

```ts
import {type AgentWithScores, type OptimizerResult} from '@google/adk';

interface ScoredAgentWithLatency extends AgentWithScores {
  latencyMs: number;
}

declare const result: OptimizerResult<ScoredAgentWithLatency>;
const slowest = result.optimizedAgents.at(-1)?.latencyMs;
```
