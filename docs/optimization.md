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
them costs nothing. `SimplePromptOptimizer` is the one optimizer adk-js ships
against this contract; it has its own section at the end of this guide.

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
    const exampleSet = params.exampleSet ?? 'validation';
    const batch =
      params.batch ??
      (exampleSet === 'train'
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

## SimplePromptOptimizer

`SimplePromptOptimizer` hill-climbs an agent's instruction. It asks a model for
a rewrite, scores the rewrite on a random batch of training examples, and keeps
it only when it scores strictly higher than the incumbent. Reach for it when you
already have an eval set and want a better instruction to paste back into your
source.

```ts
import {LlmAgent, SimplePromptOptimizer} from '@google/adk';

const agent = new LlmAgent({
  name: 'support_agent',
  instruction: 'Help the user with their order.',
});

const optimizer = new SimplePromptOptimizer({numIterations: 5, batchSize: 3});
const result = await optimizer.optimize(agent, new MyEvalSampler());

const best = result.optimizedAgents[0];
const betterInstruction = best.optimizedAgent.instruction;
```

`optimize` never mutates the agent you pass in. Every candidate is a
`clone({instruction})`, so `agent.instruction` still reads
`'Help the user with their order.'` after the run.

### Configuration

Every field is optional.

| Field                | Default                  | Meaning                                  |
| -------------------- | ------------------------ | ---------------------------------------- |
| `optimizerModel`     | `'gemini-2.5-flash'`     | The model that rewrites the instruction. |
| `modelConfiguration` | thinking, budget `10240` | Generation config for that model.        |
| `numIterations`      | `10`                     | Rewrites to try.                         |
| `batchSize`          | `5`                      | Training examples scored per candidate.  |

The constructor resolves `optimizerModel` through `LLMRegistry`, so an unknown
model name throws as soon as you build the optimizer, not when you run it.

`batchSize` is capped at the number of training examples your sampler reports.
The optimizer logs a warning and uses them all. It does not write the cap back
into the object you passed, so your config still reads the number you set.

### What a run costs

A run with `numIterations = n` makes `n` calls to the optimizer model and
`n + 2` calls to your sampler: one baseline, `n` candidates and one final
validation. Each sampler call runs an agent over a batch of examples, so a run
costs real model traffic and nothing in the class bounds it. Start with a small
`numIterations`.

### Selection and validation are separate

Selection reads training scores only. Every comparison draws a fresh random
batch, so a candidate can win on batch noise. Validation runs once at the end,
over the whole validation set, and it never decides which instruction wins.

A run can therefore return a rewritten instruction whose validation score is
below the initial agent's. `overallScore` reports that number honestly. Read it
before you adopt the result.

### The instruction must be a string

`optimize` rejects an agent whose `instruction` is a provider function. A
provider only resolves inside a live invocation. Interpolating the function
would send its source text to the optimizer model, so the optimizer refuses
instead.
