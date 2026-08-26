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

This example sweeps two instructions and scores each candidate with a local
heuristic. Replace `scoreAgent` with a call into your own evaluation service.

```ts
import {
  LlmAgent,
  type AgentOptimizer,
  type AgentWithScores,
  type OptimizerResult,
  type SampleAndScoreParams,
  type Sampler,
  type SamplingResult,
} from '@google/adk';

const EXAMPLES: Record<string, string> = {
  ex_1: 'refund a duplicate charge',
  ex_2: 'cancel a subscription',
  ex_3: 'update a billing address',
};

/** Stand-in for your evaluation service. Higher is better. */
async function scoreAgent(
  candidate: LlmAgent,
  exampleId: string,
): Promise<number> {
  const instruction =
    typeof candidate.instruction === 'string' ? candidate.instruction : '';
  const words = EXAMPLES[exampleId].split(' ');
  return words.filter((word) => instruction.includes(word)).length;
}

class BillingEvalSampler implements Sampler {
  getTrainExampleIds(): string[] {
    return ['ex_1', 'ex_2'];
  }

  getValidationExampleIds(): string[] {
    return ['ex_3'];
  }

  async sampleAndScore(params: SampleAndScoreParams): Promise<SamplingResult> {
    const exampleSet = params.exampleSet ?? 'validation';
    const batch =
      params.batch ??
      (exampleSet === 'train'
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());

    const scores: Record<string, number> = {};
    for (const exampleId of batch) {
      scores[exampleId] = await scoreAgent(params.candidate, exampleId);
    }
    return {scores};
  }
}

class InstructionSweepOptimizer implements AgentOptimizer {
  constructor(private readonly instructions: string[]) {}

  async optimize(
    initialAgent: LlmAgent,
    sampler: Sampler,
  ): Promise<OptimizerResult> {
    const validationIds = sampler.getValidationExampleIds();
    const optimizedAgents: AgentWithScores[] = [];

    for (const instruction of this.instructions) {
      const candidate = new LlmAgent({
        name: initialAgent.name,
        model: initialAgent.model,
        instruction,
      });
      const {scores} = await sampler.sampleAndScore({
        candidate,
        exampleSet: 'validation',
        batch: validationIds,
      });
      const values = Object.values(scores);
      optimizedAgents.push({
        optimizedAgent: candidate,
        overallScore:
          values.reduce((sum, value) => sum + value, 0) / values.length,
      });
    }
    return {optimizedAgents};
  }
}

const initialAgent = new LlmAgent({
  name: 'billing_agent',
  instruction: 'Help the user.',
});

const result = await new InstructionSweepOptimizer([
  'Help the user with billing.',
  'Help the user update a billing address or refund a charge.',
]).optimize(initialAgent, new BillingEvalSampler());

const best = result.optimizedAgents.reduce((left, right) =>
  (right.overallScore ?? 0) > (left.overallScore ?? 0) ? right : left,
);
```

`result.optimizedAgents` holds one entry per instruction, with scores `1` and
`4`. `best` is the second candidate, which matches four words of the validation
example.

## The example sets

`Sampler` exposes two sets by UID. An optimizer reads `getTrainExampleIds()`
while it searches, and `getValidationExampleIds()` to score what it found.
Keeping the sets apart is what stops an optimizer from reporting a score it
already optimized against.

`SampleAndScoreParams.exampleSet` selects the set for one call. Its values are
the string literals `'train'` and `'validation'`, which match adk-python.

## Defaults a Sampler must apply

TypeScript cannot give an interface a default, so `sampleAndScore` documents
three defaults that your implementation applies itself. Omitting any of them is
a valid call, and every optimizer may make one.

| Parameter             | Omitted means                   |
| --------------------- | ------------------------------- |
| `exampleSet`          | `'validation'`                  |
| `batch`               | every example in the chosen set |
| `captureFullEvalData` | `false`                         |

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
