# SimplePromptOptimizer

`SimplePromptOptimizer` rewrites an agent's instruction by measurement. It asks
an optimizer model for a better instruction, scores the rewrite against your
examples, and keeps it only when it scores higher. Reach for it when you have
an agent whose instruction you have been tuning by hand and a way to score that
agent on a fixed set of cases.

## Introduction

`AgentOptimizer` is the contract for offline agent optimization and `Sampler`
is the scoring half of it. `SimplePromptOptimizer` is the first concrete
optimizer `@google/adk` ships. It is a hill climb, and deliberately naive:

1. It scores the starting agent on a random batch of training examples. That is
   the baseline.
2. Each round, it sends the current best instruction and its score to an
   optimizer model, asks for a rewrite, clones the best agent with the rewrite,
   and scores the clone on a fresh random training batch. The clone becomes the
   new best only when it scores **strictly** higher, so a tie keeps the
   incumbent.
3. It scores the winner on the whole validation set and returns it.

The search is not clever. Its value is that it works end to end against the
contract, so you can read it, run it, and copy its shape into an optimizer of
your own.

Two things follow from the design. The optimizer only ever compares your own
numbers, so any scale where higher is better will do. And it selects on the
training set and reports on the validation set, so keep the two disjoint — an
optimizer that reports on the examples it selected on always looks successful.

Nothing here runs at request time. Optimization is an offline batch job. The
result is an in-memory agent carrying a better instruction; copying that
instruction back into your source is manual.

**This is expensive.** With the defaults, one `optimize` call makes 12 sampler
calls and 10 optimizer-model calls, and every sampler call runs your agent over
a batch of examples. Start with a small `numIterations` while you are getting
your `Sampler` right.

## Get started

Implement a `Sampler`, then hand it to the optimizer with the agent to improve.
The sampler below scores an instruction by the phrases it contains; a real one
runs the agent and grades the answer.

```ts
import {
  LlmAgent,
  SampleAndScoreParams,
  Sampler,
  SimplePromptOptimizer,
  UnstructuredSamplingResult,
} from '@google/adk';

const EXPECTED_PHRASES: Record<string, string[]> = {
  'case-1': ['order'],
  'case-2': ['order', 'confirm'],
  'case-3': ['confirm'],
  'holdout-1': ['order', 'confirm'],
  'holdout-2': ['order'],
};

class PhraseCoverageSampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['case-1', 'case-2', 'case-3'];
  }

  override getValidationExampleIds(): string[] {
    return ['holdout-1', 'holdout-2'];
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
    const text = String(candidate.instruction).toLowerCase();
    return {
      scores: Object.fromEntries(
        ids.map((id) => {
          const phrases = EXPECTED_PHRASES[id];
          const hits = phrases.filter((p) => text.includes(p)).length;
          return [id, hits / phrases.length];
        }),
      ),
    };
  }
}

const agent = new LlmAgent({
  name: 'support_agent',
  instruction: 'Help the user with their order.',
});

const optimizer = new SimplePromptOptimizer({numIterations: 3, batchSize: 3});
const result = await optimizer.optimize({
  initialAgent: agent,
  sampler: new PhraseCoverageSampler(),
});

const [best] = result.optimizedAgents;
// best.optimizedAgent.instruction is the winning instruction.
// best.overallScore is its mean score on the validation set.
```

`optimizedAgents` always holds exactly one entry. The contract allows a Pareto
front of several agents, but this optimizer tracks a single best.

This example calls the default Gemini model, so it needs credentials.
`samples/optimization/simple_prompt_optimizer/agent.ts` runs the same sampler
against a model it registers itself, so it needs neither credentials nor
network. Set `optimizerModel` to do the same in your own tests.

## Configuration

Every field is optional and every default matches ADK Python.

| Field                | Default                                                | What it does                             |
| -------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `optimizerModel`     | `'gemini-2.5-flash'`                                   | The model that rewrites the instruction. |
| `modelConfiguration` | thinking config, `includeThoughts: true`, budget 10240 | Config sent with each rewrite request.   |
| `numIterations`      | `10`                                                   | Rounds of rewrite-and-score.             |
| `batchSize`          | `5`                                                    | Training examples scored per candidate.  |

`new SimplePromptOptimizer()` with no argument gives you all four defaults.

The optimizer resolves `optimizerModel` through `LLMRegistry` in its
constructor, so a name nothing is registered under throws there rather than on
the first `optimize` call.

Your `modelConfiguration` object is never modified. The optimizer copies it into
each request, so the retry policy it stamps on a request does not leak back to
you.

If `batchSize` is larger than the training set, the optimizer logs a warning and
uses the whole training set for every candidate.

## What it requires of the agent

The agent's `instruction` must be a `string`. `LlmAgent.instruction` also
accepts an `InstructionProvider` function, and there is nothing in a function
for a model to rewrite, so `optimize` throws before it calls the model or the
sampler.

The optimizer never modifies the agent you pass it. Every candidate comes from
`initialAgent.clone({instruction})`, and the returned agent is either a clone or
the original object when no rewrite won.

## Failure modes

The optimizer keeps the reference implementation's behaviour, which means it
tolerates more than it rejects.

A model that answers with nothing, or with thought parts only, yields an empty
instruction. That candidate is scored like any other and loses, so the run
continues. Thought parts are always dropped, so model reasoning never reaches a
shipped instruction.

A sampler that returns an empty `scores` map scores `0`, not `NaN`.

`getTrainExampleIds()` returning an empty array is not guarded, matching ADK
Python. `batchSize` clamps to `0`, every batch is empty, and what an empty batch
means is your sampler's decision.
