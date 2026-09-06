# GEPARootAgentPromptOptimizer

`GEPARootAgentPromptOptimizer` improves a root agent's instruction by
reflective prompt evolution. It hands a GEPA search engine an adapter over your
agent and your `Sampler`, and returns the candidate instructions the search
kept, each with its validation score. Reach for it when hand-editing an
instruction has stopped paying off and you have an example set to measure
against.

## Introduction

GEPA is a search: it evaluates a candidate instruction, reads the failures, has
a model write a better candidate, and repeats until it runs out of budget. One
half of that loop is yours, and this class is the other.

- The **engine** runs the search. ADK bundles `DefaultGepaEngine` and uses it
  when you configure none. Pass `config.engine` to search your own way.
- The **sampler** scores a candidate. You implement `Sampler` over whatever
  scoring you already trust; it reports the example UIDs and the score each
  candidate earned on them.
- The **optimizer** is the bridge. It clones your agent with each candidate
  instruction, routes the scoring to your sampler, turns the results into the
  records the reflection model reads, and calls that model for you.

Only the root agent's instruction changes. Sub-agent instructions are left
alone, and the optimizer warns when the agent has any.

ADK Python imports the PyPI package `gepa` here. npm has no first-party
equivalent, so adk-js implements the search itself, behind a declared contract:
`GepaEngine`, `GepaAdapter`, `EvaluationBatch`, `GepaOptimizeParams` and
`GepaRunResult`. Anything satisfying `GepaEngine` works, including your own.
The two searches are independent implementations, so they will not follow the
same trajectory over the same inputs.

Nothing runs at request time. Optimization is an offline batch job whose output
is an in-memory agent carrying a better instruction. Copying that instruction
into your source is manual.

## Get started

You supply one thing the optimizer does not: a `Sampler` that scores a
candidate. A runnable one lives in
[`samples/optimization/gepa_root_agent_prompt_optimizer/agent.ts`](../../../../samples/optimization/gepa_root_agent_prompt_optimizer/agent.ts).
Import it there, or copy it; the call that drives it is this:

```ts
import {GEPARootAgentPromptOptimizer, LlmAgent} from '@google/adk';
import {PhraseCoverageSampler} from './samples/optimization/gepa_root_agent_prompt_optimizer/agent.js';

const result = await new GEPARootAgentPromptOptimizer({
  maxMetricCalls: 8,
  reflectionMinibatchSize: 2,
}).optimize({
  initialAgent: new LlmAgent({
    name: 'support_agent',
    instruction: 'Help the user with their order.',
  }),
  sampler: new PhraseCoverageSampler(),
});

// result.optimizedAgents[1].overallScore is 1, and its optimizedAgent carries
// the rewritten instruction.
```

The bundled search reflects, so it calls `optimizerModel` and needs that
model's credentials. The same sample also passes a `TwoCandidateEngine` as
`config.engine`; that engine never reflects, so it runs with no credentials.

The instruction has to be a static string. A request-scoped instruction
provider cannot be resolved without an invocation context, so the optimizer
rejects one. Your sampler gets the same guarantee: call the exported
`requireStaticInstruction(candidate)` rather than coercing with `String(...)`,
which would silently score a function's source text.

## Configuration

Every field is optional and matches the ADK Python defaults.

| Field                     | Default              | What it does                                          |
| ------------------------- | -------------------- | ----------------------------------------------------- |
| `engine`                  | `DefaultGepaEngine`  | The GEPA search engine.                               |
| `optimizerModel`          | `'gemini-2.5-flash'` | The model that writes each rewrite.                   |
| `modelConfiguration`      | thinking on, 10240   | The generation config for that model.                 |
| `maxMetricCalls`          | `100`                | The evaluation budget, passed to the engine.          |
| `reflectionMinibatchSize` | `3`                  | How many examples the engine reflects over at a time. |
| `runDir`                  | none                 | Where the engine writes its results.                  |

The constructor resolves `optimizerModel` through `LLMRegistry`, so an unknown
model fails immediately. The model itself is built on first reflection, which
keeps a run whose engine never reflects free of credentials.

## The bundled engine

`DefaultGepaEngine` scores the seed candidate on the validation set, then
repeats one round until the budget runs out: pick a parent, sample a training
minibatch, evaluate the parent on it, ask the reflection model for a rewrite,
evaluate that child on the same minibatch, and keep it when it beats its
parent. A kept child is scored on the validation set and joins the pool. Every
evaluated example is one metric call, and the engine starts no round it cannot
pay for, so a run never exceeds `maxMetricCalls`.

Each round picks its parent uniformly among the candidates no other candidate
beats on every validation example. Construct the engine yourself to make that
choice reproducible:

```ts
import {DefaultGepaEngine, GEPARootAgentPromptOptimizer} from '@google/adk';

new GEPARootAgentPromptOptimizer({
  engine: new DefaultGepaEngine({seed: 42}),
});
```

Without a `seed` the engine uses `Math.random`, so two runs over the same
inputs can take different paths.

With `runDir` set, the engine writes the final result to
`<runDir>/gepa_result.json` and creates the directory if it is missing. It
writes nothing else; ADK Python's `gepa` package keeps far more intermediate
state than this.

## What the engine gets

`optimize` calls `engine.optimize` once, with an adapter over your agent.

`adapter.evaluate(batch, candidate, captureTraces)` clones the initial agent
with `candidate[AGENT_PROMPT_NAME]` as its instruction, then calls your sampler
once. It decides the example set from the batch: a batch drawn wholly from the
training UIDs is scored as `'train'`, one drawn wholly from the validation UIDs
as `'validation'`, and a batch mixing the two throws. An empty batch counts as
training.

`adapter.makeReflectiveDataset(candidate, evalBatch, components)` returns one
record per example, under each requested component name. The record keys are
`agent_prompt`, `score` and `eval_data`, in snake_case, because the reflection
model and the engine read them and ADK Python writes them that way.

`params.reflectionLm(prompt)` sends the prompt to `optimizerModel` and returns
the response text with the model's thoughts removed.

## Failure modes

- An empty training set, an empty validation set, or a `maxMetricCalls` below
  the validation-set size: the bundled engine throws, naming the input.
- A non-string `instruction`: `optimize` throws, naming the invocation context
  it would need.
- A batch spanning both example sets, or holding an unknown UID: `evaluate`
  throws.
- An example the sampler did not score: the optimizer warns and scores it `0`,
  so the search treats it as a failure rather than aborting. This assumes
  scores on the `[0, 1]` scale.
- Overlapping training and validation UIDs: the optimizer warns. Keep the two
  sets disjoint; a search that selects on the examples it reports on always
  looks successful.
- An engine reporting a different number of candidates and validation scores,
  or a reflective dataset with fewer trajectories than scores: both throw,
  naming the two lengths.
