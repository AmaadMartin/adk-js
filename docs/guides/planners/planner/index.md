# BasePlanner

`BasePlanner` is the interface an agent uses to steer model reasoning before
the model acts. A planner adds a planning instruction to the request, and it
sorts the reply into internal thoughts, tool calls and the answer for the user.

## Introduction

A model that answers a multi-step question in one shot often calls the wrong
tool, or skips a step it needed. Nothing makes it decompose the problem first,
and nothing separates the reasoning it produces from the answer it delivers.

The planner subsystem solves both. A planner runs at two points in a turn: it
contributes a system instruction before the model call, and it rewrites the
reply after it. Two implementations ship with ADK. `BuiltInPlanner` carries a
`ThinkingConfig` to a model that thinks natively. `PlanReActPlanner` prompts any
model with tagged sections, then splits the tagged reply itself.

Attach a planner to an `LlmAgent` through its `planner` field. An agent with no
planner behaves exactly as before: both flow processors return before they touch
the request or the reply.

## Get started

`PlanReActPlanner` needs no configuration. It makes the model write a numbered
plan before it calls a tool.

```ts
import {FunctionTool, LlmAgent, PlanReActPlanner} from '@google/adk';
import {z} from 'zod';

const checkInventory = new FunctionTool({
  name: 'check_inventory',
  description: 'Checks the available quantity for an item.',
  parameters: z.object({item: z.string().describe('The item to look up.')}),
  execute: () => ({inStock: 42}),
});

const agent = new LlmAgent({
  name: 'planning_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Assist users with store queries using available tools.',
  tools: [checkInventory],
  planner: new PlanReActPlanner(),
});
```

## How a turn runs

The two natural language planning processors sit in the default `LlmAgent`
pipeline, so attaching the planner is all the wiring a user does.

1. Before the model call, `NlPlanningRequestProcessor` reads the agent's
   planner. For a `BuiltInPlanner` it calls `applyThinkingConfig(llmRequest)`,
   which sets `llmRequest.config.thinkingConfig`. For any other planner it
   appends the result of `buildPlanningInstruction()` to
   `llmRequest.config.systemInstruction`, then clears the `thought` flag on
   every part of the request history.
2. After the model replies, `NlPlanningResponseProcessor` calls
   `processPlanningResponse()`. When the planner returns parts, they replace the
   parts the model sent. When the planner writes to the callback context state,
   the processor emits one event carrying that state change.

`PlanReActPlanner` marks the planning and reasoning text as thought parts
(`part.thought === true`) and removes the tag markers, so the user receives
clean text while the session events keep the reasoning.

## Choosing an implementation

| Implementation         | Model requirement                                          | How it works                                                       |
| :--------------------- | :--------------------------------------------------------- | :----------------------------------------------------------------- |
| `BuiltInPlanner`       | A model that supports `ThinkingConfig`, such as Gemini 2.5 | Sets the thinking config on the request. The model plans natively. |
| `PlanReActPlanner`     | Any model                                                  | Prompts for tagged sections and splits the tagged reply.           |
| A custom `BasePlanner` | Any model                                                  | Whatever the two methods do.                                       |

### BuiltInPlanner

| Option           | Type             | Default      | Description                                |
| :--------------- | :--------------- | :----------- | :----------------------------------------- |
| `thinkingConfig` | `ThinkingConfig` | _(required)_ | The model's native thinking configuration. |

```ts
import {BuiltInPlanner, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'thinking_agent',
  model: 'gemini-2.5-flash',
  planner: new BuiltInPlanner({
    thinkingConfig: {includeThoughts: true, thinkingBudget: 1024},
  }),
});
```

Set the thinking config here or in the agent's `generateContentConfig`. When
both carry one, the planner wins, and the agent logs a warning at construction.

Unlike other planners, `BuiltInPlanner` keeps the `thought` flags a previous
turn left in the history, because a native thinking model reads them.

### PlanReActPlanner

`PlanReActPlanner` takes no options. It prompts the model to open each section
with a tag, and each tag is exported as a constant.

| Tag                                     | Stage                       | Result                                |
| :-------------------------------------- | :-------------------------- | :------------------------------------ |
| `PLANNING_TAG` (`/*PLANNING*/`)         | The first plan              | A thought part, with the tag removed  |
| `REPLANNING_TAG` (`/*REPLANNING*/`)     | A revised plan              | A thought part, with the tag removed  |
| `REASONING_TAG` (`/*REASONING*/`)       | Analysis between tool calls | A thought part, with the tag removed  |
| `ACTION_TAG` (`/*ACTION*/`)             | The tool calls              | A thought part, with the tag removed  |
| `FINAL_ANSWER_TAG` (`/*FINAL_ANSWER*/`) | The answer for the user     | A plain part, delivered as the answer |

The planner splits a text part on the **last** `FINAL_ANSWER_TAG` it holds. The
text before that tag becomes one thought part, and the text after it becomes the
answer. A part whose text does not start with a planning tag is left alone, so a
tag quoted in the middle of a sentence does not turn the sentence into a
thought.

The planner keeps the model's first group of function calls and drops any part
that follows the group. It also drops a function call with no name.

## Writing your own planner

Implement the two methods. Both may return their result directly or as a
promise.

```ts
import type {
  BasePlanner,
  Context,
  LlmRequest,
  ReadonlyContext,
} from '@google/adk';
import type {Part} from '@google/genai';

const SAFETY_CHECK = '[SAFETY_CHECK]';

class StrictStepPlanner implements BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string {
    return `Before you call a tool, write ${SAFETY_CHECK} and explain why the call is safe.`;
  }

  processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] {
    for (const part of responseParts) {
      if (part.text?.includes(SAFETY_CHECK)) {
        part.thought = true;
      }
    }
    return responseParts;
  }
}
```

## Limitations

- `BuiltInPlanner` needs a model that supports `ThinkingConfig`. The API returns
  an error for a model that does not. ADK does not check the model first.
- A small model sometimes omits the tags `PlanReActPlanner` asked for. The
  planner then passes the text through as ordinary output instead of splitting
  it into a thought and an answer.
