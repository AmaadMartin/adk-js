# Sampler

`Sampler` is the contract an agent optimizer calls to evaluate a candidate
agent. You implement it once, over your own evaluation service, and any
optimizer can then score the agents it produces.

## Introduction

An optimizer improves an agent by proposing candidates and keeping the ones that
score better. It cannot judge a candidate on its own: scoring needs your
examples, your metrics and your evaluation service. `Sampler` is the seam
between the two. The optimizer owns the search, and your `Sampler` owns the
measurement.

The contract has three members. `getTrainExampleIds()` and
`getValidationExampleIds()` name the examples in each set, so the optimizer can
search against training data and check the winner against held-out data.
`sampleAndScore()` runs a candidate over a set and returns a score per example.

`SamplingResult` carries those scores as a map from example UID to a number,
where a higher number is better. An optimizer that needs more than a score can
declare its own sub-type and read the extra data back through the generic
parameter: a `Sampler<MyResult>` resolves `sampleAndScore()` to `MyResult`, and
the compiler rejects a subclass that returns anything else.

Nothing in adk-js implements `Sampler` yet, and nothing calls one. The type is
here so an evaluation service written today matches the optimizers that arrive
later.

## Get started

A complete `Sampler` over two fixed example sets. It scores nothing real, so it
runs with no credentials and no network.

```ts
import {
  LlmAgent,
  SampleAndScoreParams,
  Sampler,
  SamplingResult,
} from '@google/adk';

/** Adds the data an optimizer needs beyond a bare score. */
interface DetailedSamplingResult extends SamplingResult {
  outputs: Record<string, string>;
}

class MyEvalSampler extends Sampler<DetailedSamplingResult> {
  constructor(
    private readonly trainIds: string[],
    private readonly validationIds: string[],
  ) {
    super();
  }

  override getTrainExampleIds(): string[] {
    return this.trainIds;
  }

  override getValidationExampleIds(): string[] {
    return this.validationIds;
  }

  override async sampleAndScore({
    candidate,
    exampleSet = Sampler.VALIDATION_SET,
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<DetailedSamplingResult> {
    const ids =
      batch ??
      (exampleSet === Sampler.TRAIN_SET
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());

    const scores: Record<string, number> = {};
    const outputs: Record<string, string> = {};
    for (const id of ids) {
      const answer = await this.runExample(candidate, id);
      scores[id] = this.grade(answer);
      if (captureFullEvalData) {
        outputs[id] = answer;
      }
    }
    return {scores, outputs};
  }

  private async runExample(candidate: LlmAgent, id: string): Promise<string> {
    return `${candidate.name} answered ${id}`;
  }

  private grade(answer: string): number {
    return answer.length > 0 ? 1 : 0;
  }
}

const sampler = new MyEvalSampler(['train-1'], ['val-1', 'val-2']);
const result = await sampler.sampleAndScore({
  candidate: new LlmAgent({name: 'candidate'}),
});
```

`result.scores` holds one entry per validation example. `result.outputs` is
empty, because the caller did not ask for the full evaluation data.

## The two example sets

`exampleSet` is the string union `ExampleSet`, which admits `'train'` and
`'validation'` and nothing else. `Sampler.TRAIN_SET` and
`Sampler.VALIDATION_SET` are those two values. Use the constants rather than the
bare strings: an implementation that keys a lookup table on them reads the same
in TypeScript as it does in Python.

## Defaults belong to your implementation

`exampleSet`, `batch` and `captureFullEvalData` are all optional, and the base
class applies no default to any of them. Your `sampleAndScore()` decides what an
omitted field means, and the documented contract is:

| Field                 | Meaning when omitted                      |
| --------------------- | ----------------------------------------- |
| `exampleSet`          | Evaluate the validation set.              |
| `batch`               | Evaluate every example of the chosen set. |
| `captureFullEvalData` | Score only; capture no extra data.        |

Destructuring the parameter object with defaults, as the example above does, is
the shortest way to honour that. An optimizer relies on it, so a `Sampler` that
picks other defaults will be driven wrongly.

## Validation

`SamplingResult` is a TypeScript interface, so it is erased at compile time and
performs no runtime check. If your `scores` come from a file, an API or a model,
validate them before you return them.
