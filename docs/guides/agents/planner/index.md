# BasePlanner

A planner tells an `LlmAgent` to produce a plan before it answers. It adds a
system instruction to every model request for that agent, and it inspects the
parts the model returns. Reach for a planner when the planning rule belongs to
the agent rather than to one prompt.

## Introduction

`instruction` on an `LlmAgent` is static text. It cannot see the request the
flow assembled, and it cannot touch the reply. A planner sits on both sides of
the model call, so it can decide what to ask for and then classify what came
back.

The contract has two methods:

- `buildPlanningInstruction` runs before the model call. Its return value is
  appended to `llmRequest.config.systemInstruction`. Returning `undefined`
  appends nothing.
- `processPlanningResponse` runs after the model call. It receives the parts
  the model returned and may return replacement parts. Returning `undefined`
  keeps the model's own parts.

Both methods are synchronous.

A planner is the tool for reasoning that should not reach the user. ADK treats
a `Part` whose `thought` is `true` as internal reasoning and keeps it out of
user-facing text. A planner marks such parts in `processPlanningResponse`. The
parts still reach event consumers, so a user interface can show the plan if it
chooses to.

Compare with the neighbouring pieces:

- A **`beforeModelCallback`** also mutates the request, but it cannot classify
  the reply. Use a planner when you need both halves.
- An **output schema** constrains the shape of the final answer. A planner
  shapes the reasoning that precedes it.

## Get started

Attach any object that implements `BasePlanner` to the agent's `planner` field.

```ts
import type {
  BasePlanner,
  Context,
  LlmRequest,
  ReadonlyContext,
} from '@google/adk';
import {LlmAgent} from '@google/adk';
import type {Part} from '@google/genai';

const SAFETY_CHECK = '[SAFETY_CHECK]';

class SafetyCheckPlanner implements BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string | undefined {
    return `Before you call any tool, write '${SAFETY_CHECK}' followed by your verification that the action is safe and authorized.`;
  }

  processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    for (const part of responseParts) {
      if (part.text?.includes(SAFETY_CHECK)) {
        part.thought = true;
      }
    }
    return responseParts;
  }
}

const agent = new LlmAgent({
  name: 'planning_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Assist users with store queries using the available tools.',
  planner: new SafetyCheckPlanner(),
});
```

The safety check now appears on the event as a thought part. It does not appear
in the agent's user-facing text.

## What the flow guarantees

`LlmAgent` wires two processors into its default pipeline: one before the model
call and one after it. They give the following guarantees.

- **An agent with no planner is unaffected.** Both processors return before they
  touch the request or the response.
- **The instruction is appended, not replaced.** An existing system instruction
  is kept, and the planner's instruction follows it after a blank line.
- **Thought markers from earlier turns are cleared.** The request processor
  clears `thought` on every part of the request contents, so the model does not
  see its own reasoning from a previous turn. This only runs when the agent has
  a planner.
- **Ordering is fixed.** The planning processor runs after the contents
  processor, so the contents it clears are the assembled ones. It runs before
  the code execution processor, which rewrites contents for data files.
- **Parts are mutated in place.** A planner may set `thought` on the array it
  was handed and return that same array.

## Writing session state

`processPlanningResponse` receives a `Context`. Writing to `callbackContext.state`
makes the flow emit one extra event carrying the state delta. The event is
emitted only when the planner wrote something.

```ts
processPlanningResponse(
  callbackContext: Context,
  responseParts: Part[],
): Part[] | undefined {
  callbackContext.state.set('last_plan', responseParts[0]?.text ?? '');
  return responseParts;
}
```

## Failure modes

A planner is your code, called synchronously by the flow. ADK does not wrap it.
An exception thrown from either method propagates out of the processor and is
handled by the flow's error path, so a broken planner fails the model call
rather than degrading silently.

Supplying your own `responseProcessors` to `LlmAgent` replaces the default list.
The planning response processor is part of that default, so a custom list must
include `NL_PLANNING_RESPONSE_PROCESSOR` if the planner should still see the
reply. The request side works the same way with `requestProcessors` and
`NL_PLANNING_REQUEST_PROCESSOR`.
