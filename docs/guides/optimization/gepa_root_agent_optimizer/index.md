# GEPARootAgentOptimizer

`GEPARootAgentOptimizer` rewrites a root agent's instruction and the
instructions of every skill it exposes, in one GEPA search. It hands a search
engine an adapter over your agent and your `Sampler`, and returns the candidate
agents the search kept, each with its validation score. Reach for it when an
agent's quality depends on its skills as much as on its instruction, and tuning
the two by hand has stopped paying off.

## Introduction

GEPA is a search: it evaluates a candidate, reads the failures, has a model
write a better candidate, and repeats until it runs out of budget. What is
searched here is a set of named components, not one string.

- `agent_prompt` holds the agent's core instruction.
- `skill_instructions:<name>` holds one skill's instructions, one component per
  skill on every `SkillToolset` the agent carries.

Every candidate the engine reports is a full assignment of those components.
The optimizer rebuilds the agent from it: a clone carrying the new instruction,
with each `SkillToolset` replaced by a copy carrying the new skill
instructions. Nothing on the agent you passed in is changed.

Three parts make up a run, and two of them are yours.

- The **engine** runs the search. ADK bundles none. You pass one as
  `config.engine`, and an `optimize` call without it throws before it touches
  your sampler.
- The **sampler** scores a candidate agent. You implement `Sampler` over
  whatever scoring you already trust.
- The **optimizer** is the bridge. It builds the seed candidate, rebuilds the
  agent per candidate, routes the scoring to your sampler, and writes the
  proposal prompt that asks the reflection model for each component's next
  text.

Only the root agent changes. Sub-agent instructions are left alone, and the
optimizer warns when the agent has any.

ADK Python imports the PyPI package `gepa` here. npm has no first-party
equivalent, so adk-js declares the engine contract instead of importing one:
`GepaEngine`, `GepaAdapter`, `EvaluationBatch`, `GepaOptimizeParams` and
`GepaRunResult`. Anything satisfying `GepaEngine` works, including your own.

Nothing runs at request time. Optimization is an offline batch job whose output
is an in-memory agent. Copying its instruction and its skill instructions back
into your source is manual.

## Get started

You need two things the optimizer does not supply: a `Sampler` that scores a
candidate agent, and an engine that searches. Both live, runnable, in
[`samples/optimization/gepa_root_agent_optimizer/agent.ts`](../../../../samples/optimization/gepa_root_agent_optimizer/agent.ts).
Import them there, or copy them; the call that drives them is this:

```ts
import {GEPARootAgentOptimizer, LlmAgent, SkillToolset} from '@google/adk';
import {
  PhraseCoverageSampler,
  refundSkill,
  TwoCandidateEngine,
} from './samples/optimization/gepa_root_agent_optimizer/agent.js';

const result = await new GEPARootAgentOptimizer({
  engine: new TwoCandidateEngine(),
}).optimize({
  initialAgent: new LlmAgent({
    name: 'support_agent',
    instruction: 'Help the user with their order.',
    tools: [new SkillToolset([refundSkill])],
  }),
  sampler: new PhraseCoverageSampler(),
});

// result.optimizedAgents[1].overallScore is 1, and its optimizedAgent carries
// both the rewritten instruction and the rewritten skill instructions.
```

The instruction has to be a static string. A request-scoped instruction
provider cannot be resolved without an invocation context, so the optimizer
rejects one. Your sampler gets the same guarantee: call the exported
`requireStaticInstruction(candidate)` rather than coercing with `String(...)`,
which would silently score a function's source text.

## Configuration

Every field is optional and carries this module's ADK Python default.

| Field                     | Default                   | What it does                                                    |
| ------------------------- | ------------------------- | --------------------------------------------------------------- |
| `engine`                  | none                      | The GEPA search engine. Without it, `optimize` throws.          |
| `optimizerModel`          | `'gemini-3.5-flash'`      | The model that writes each rewrite.                             |
| `modelConfiguration`      | thinking on, level `HIGH` | The generation config for that model.                           |
| `maxMetricCalls`          | `100`                     | The evaluation budget, passed to the engine.                    |
| `reflectionMinibatchSize` | `3`                       | How many examples the engine reflects over at a time.           |
| `runDir`                  | none                      | Where the engine writes its results. ADK writes nothing itself. |

The constructor resolves `optimizerModel` through `LLMRegistry`, so an unknown
model fails immediately. The model itself is built on first reflection, which
keeps a run whose engine never reflects free of credentials.

## The seed candidate

`optimize` builds the starting candidate from the agent you pass in: one entry
per skill, in the order the toolsets and their skills are declared, then
`agent_prompt` last. ADK Python relies on that order, and so does this port: an
engine that walks the components in order optimizes the skills before the core
instruction.

```ts
{
  'skill_instructions:refund_policy': 'Refund an order when the user asks.',
  'agent_prompt': 'Help the user with their order.',
}
```

Use the exported `skillComponentKey(name)` to build a key rather than
concatenating `SKILL_KEY_PREFIX` yourself. The name is the skill's
`frontmatter.name`.

## What the engine gets

`optimize` calls `engine.optimize` once, with a `RootAgentGepaAdapter` over
your agent.

`adapter.evaluate(batch, candidate, captureTraces)` rebuilds the agent from the
candidate and calls your sampler once. It decides the example set from the
batch: a batch drawn wholly from the training UIDs is scored as `'train'`, one
drawn wholly from the validation UIDs as `'validation'`, and a batch mixing the
two throws. An empty batch counts as training.

`adapter.makeReflectiveDataset(candidate, evalBatch, components)` returns one
record list per requested component. A record is `{score, eval_data}`, in
snake_case, because the reflection model reads those keys and ADK Python writes
them that way. The `agent_prompt` component gets every example. A skill
component gets only the examples whose serialized eval data mentions that
skill's name, so a skill learns from the runs that exercised it. Put the skill
name in the eval data your sampler captures, or the skill's dataset stays
empty.

`adapter.proposeNewTexts(candidate, reflectiveDataset, components)` renders one
instruction-updater prompt per component and calls the reflection model. The
prompt for `agent_prompt` tells the model to leave skill instructions alone;
the prompt for a skill component names that skill and tells the model to leave
the core instruction alone. It reads the reply's last fenced block as the new
text. This member is optional on `GepaAdapter`, so an engine that has its own
proposer can ignore it.

`params.reflectionLm(prompt)` sends any prompt to `optimizerModel` and returns
the response text with the model's thoughts removed.

## Failure modes

- No `config.engine`: `optimize` throws before it reads anything from the
  sampler, and the message names `config.engine`.
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
- A component that is neither `agent_prompt` nor a `skill_instructions:` key:
  `proposeNewTexts` throws, naming the component.
- A reflection reply with no fenced block: `proposeNewTexts` throws, naming the
  component, rather than treating the whole reply as an instruction.
- An engine reporting a different number of candidates and validation scores,
  or a reflective dataset with fewer trajectories than scores: both throw,
  naming the two lengths.
