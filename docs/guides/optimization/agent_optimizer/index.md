# AgentOptimizer and Sampler

`AgentOptimizer` and `Sampler` are the two halves of offline agent
optimization. An optimizer proposes candidate agents. A sampler scores them
against a fixed set of examples. Reach for them when you want to improve an
agent's instruction by measurement instead of by hand.

## Introduction

Rewriting an instruction by hand means running the agent over a few cases and
deciding it looks better. Optimization replaces that with a loop: propose a
candidate, score it over a fixed example set, and keep the higher score.

The package splits that loop at one interface.

- `AgentOptimizer` is the search. It decides which candidates to try, in what
  order, and when to stop. Its one member, `optimize`, takes the agent to start
  from and the sampler that scores candidates.
- `Sampler` is the scoring. It answers two questions: which examples exist, and
  how well did this candidate do on them. You implement it over whatever
  scoring you already trust.

`@google/adk` ships no concrete optimizer and no concrete sampler yet. This
module is the contract both sides extend, so an optimizer written against it
works with any sampler, and the reverse.

Nothing here runs at request time. Optimization is an offline batch job, and
its output is an in-memory agent carrying a better instruction. Copying that
instruction into your source is manual.

Three details of the contract are worth stating before you implement it.

`optimize` resolves to an `OptimizerResult`, whose `optimizedAgents` is a list
rather than a single agent. An optimizer may return a Pareto front: several
agents that are each best at something, none strictly better than the rest.

Scores are numbers where higher is better. That is the whole contract, so the
range is yours. An optimizer only ever compares two of your own numbers.

`Sampler.TRAIN_SET` and `Sampler.VALIDATION_SET` hold the strings `'train'` and
`'validation'`. They are the only two values `exampleSet` takes, and they match
ADK Python, so a document written by one SDK reads the same in the other. Keep
the two example sets disjoint. An optimizer that selects on the examples it
reports on always looks successful.

## Get started

Implement the three `Sampler` members. The sampler below scores an instruction
by the words it contains; a real one runs the agent.

Both members take one params object, so TypeScript cannot put a default on
`exampleSet` in the signature. Apply it yourself, with a destructuring default.
An optimizer that omits `exampleSet` means the validation set.

```ts
import {
  LlmAgent,
  SampleAndScoreParams,
  Sampler,
  UnstructuredSamplingResult,
} from '@google/adk';

const EXPECTED_PHRASE: Record<string, string> = {
  'case-1': 'order',
  'case-2': 'confirm',
  'holdout-1': 'order',
};

class PhraseCoverageSampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['case-1', 'case-2'];
  }

  override getValidationExampleIds(): string[] {
    return ['holdout-1'];
  }

  override async sampleAndScore({
    candidate,
    exampleSet = Sampler.VALIDATION_SET,
    batch,
  }: SampleAndScoreParams): Promise<UnstructuredSamplingResult> {
    const ids =
      batch ??
      (exampleSet === Sampler.TRAIN_SET
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const instruction = String(candidate.instruction).toLowerCase();
    return {
      scores: Object.fromEntries(
        ids.map((id) => [
          id,
          instruction.includes(EXPECTED_PHRASE[id]) ? 1 : 0,
        ]),
      ),
    };
  }
}
```

An optimizer proposes candidates and reads the scores back.

```ts
import {
  AgentOptimizer,
  AgentWithScores,
  OptimizeParams,
  OptimizerResult,
} from '@google/adk';

class TwoInstructionOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<
    OptimizerResult<AgentWithScores>
  > {
    const rewrite = new LlmAgent({
      name: initialAgent.name,
      instruction: 'Confirm the order id, then help with the order.',
    });

    let best = initialAgent;
    let bestScore = -Infinity;
    for (const candidate of [initialAgent, rewrite]) {
      const {scores} = await sampler.sampleAndScore({
        candidate,
        exampleSet: Sampler.TRAIN_SET,
      });
      const score = mean(Object.values(scores));
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    const {scores} = await sampler.sampleAndScore({candidate: best});
    return {
      optimizedAgents: [
        {optimizedAgent: best, overallScore: mean(Object.values(scores))},
      ],
    };
  }
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

const agent = new LlmAgent({
  name: 'support_agent',
  instruction: 'Help the user with their order.',
});

const result = await new TwoInstructionOptimizer().optimize({
  initialAgent: agent,
  sampler: new PhraseCoverageSampler(),
});

const [best] = result.optimizedAgents;
// best.overallScore is 1, best.optimizedAgent.instruction is the rewrite.
```

`samples/optimization/agent_optimizer/agent.ts` runs this same optimizer and
sampler. It wraps them in a `Workflow` node so that `npm run sample` reports the
winning instruction, and it needs no credentials.

## Capturing full evaluation data

`captureFullEvalData` asks the sampler for more than a score. When it is
`true`, populate `UnstructuredSamplingResult.data`: a map from the same example
UIDs to whatever JSON-serializable material helps a model reason about a
failure, such as the input, the response, or the tool calls. It defaults to
`false`, so an optimizer that only compares scores never sets it.

```ts
class TrajectorySampler extends PhraseCoverageSampler {
  override async sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<UnstructuredSamplingResult> {
    const result = await super.sampleAndScore(params);
    if (params.captureFullEvalData) {
      result.data = Object.fromEntries(
        Object.keys(result.scores).map((id) => [
          id,
          {instruction: params.candidate.instruction},
        ]),
      );
    }
    return result;
  }
}
```

## Returning custom metrics

`AgentWithScores` carries `optimizedAgent` and an optional `overallScore`. An
optimizer that reports more extends the interface and passes the wider type as
its second generic argument.

```ts
interface AgentWithLatency extends AgentWithScores {
  latencyMs: number;
}

class TimedOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithLatency
> {
  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<
    OptimizerResult<AgentWithLatency>
  > {
    const startedAt = Date.now();
    const {scores} = await sampler.sampleAndScore({candidate: initialAgent});
    return {
      optimizedAgents: [
        {
          optimizedAgent: initialAgent,
          overallScore: mean(Object.values(scores)),
          latencyMs: Date.now() - startedAt,
        },
      ],
    };
  }
}
```

## Finding an optimizer or a sampler

Use `isAgentOptimizer` and `isSampler` rather than `instanceof`. Each checks a
registered symbol, so it still returns true when the object came from a second
copy of `@google/adk` in the same runtime, where `instanceof` returns false.

```ts
import {isSampler} from '@google/adk';

function trainIds(candidate: unknown): string[] {
  return isSampler(candidate) ? candidate.getTrainExampleIds() : [];
}
```
