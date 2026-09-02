# BasePlanner

Applies an agent's planner to the outgoing model request, and hands the
model's reply back to the planner. Reach for a planner when you want the model
to write a plan before it acts, and you want the plan kept out of the answer
the user reads.

## Introduction

A planner is a field on `LlmAgent`. On its own it does nothing: something has
to put its instruction into the request and give it the reply. The two NL
planning processors do that, and `LlmAgent` runs them by default.

There are two kinds of planner, and they take different routes through the
request processor.

`BuiltInPlanner` carries a `thinkingConfig`. The processor copies that config
onto `llmRequest.config` and stops. The model does the planning itself, and the
conversation keeps its `thought` marks, because those marks are the model's own
thinking and the next turn needs them.

Any other planner contributes a system instruction instead. `PlanReActPlanner`
is the one in the box: its instruction asks the model to write its plan under
`/*PLANNING*/`, its reasoning under `/*REASONING*/`, and its answer under
`/*FINAL_ANSWER*/`. The response processor then splits the reply at those tags
into a thought part and an answer part. For this kind of planner the request
processor also clears every `thought` mark in the conversation, because the
tags are what marks a thought now, and a stale mark from an earlier turn would
contradict them.

A planner that is not a `BasePlanner` falls back to `PlanReActPlanner`. An
agent with no planner takes neither route: both processors return on their
first guard, so adding them to every agent's defaults changes nothing for an
agent that does not use one.

The request processor runs after the contents processor and before the code
execution processor. It has to run after contents so the previous turn's
`thought` marks exist to be cleared.

A planner may write session state while it processes the reply. The response
processor emits one state-delta event when it does, so the write reaches the
session.

## Get started

Tag-based planning, on any model:

```ts
import {LlmAgent, PlanReActPlanner} from '@google/adk';

const agent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  planner: new PlanReActPlanner(),
});
```

The model receives the planner instruction appended to its system
instruction. A reply of:

```
/*PLANNING*/1. Look up the weather.
/*FINAL_ANSWER*/It is sunny.
```

reaches you as two parts:

```ts
[{text: '1. Look up the weather.\n', thought: true}, {text: 'It is sunny.'}];
```

Native thinking instead, on a model that supports it:

```ts
import {BuiltInPlanner, LlmAgent} from '@google/adk';

const thinker = new LlmAgent({
  name: 'thinker',
  model: 'gemini-2.5-pro',
  planner: new BuiltInPlanner({thinkingConfig: {includeThoughts: true}}),
});
```

The request carries `config.thinkingConfig`, and the contents are unchanged.

## Writing your own planner

Extend `BasePlanner` and implement its two hooks. Either may return a promise;
the processors await both.

```ts
import {
  BasePlanner,
  BuildPlanningInstructionParams,
  LlmAgent,
  ProcessPlanningResponseParams,
} from '@google/adk';
import {Part} from '@google/genai';

class BriefPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string {
    return 'List your steps before you answer.';
  }

  override processPlanningResponse({
    responseParts,
  }: ProcessPlanningResponseParams): Part[] {
    return responseParts;
  }
}

const agent = new LlmAgent({
  name: 'brief',
  model: 'gemini-2.5-flash',
  planner: new BriefPlanner(),
});
```

Two details decide what the processors do with what you return:

- `buildPlanningInstruction` returning `undefined` or an empty string appends
  nothing. The `thought` marks are still cleared.
- `processPlanningResponse` returning `undefined` or an empty array keeps the
  model's original parts. Only a non-empty array replaces them.

A subclass of `BuiltInPlanner` that overrides `processPlanningResponse` gets
called; one that inherits the base no-op does not.

The processors do not catch what a planner throws. An error surfaces to the
caller.
