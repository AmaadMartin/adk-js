# BasePlanner

`BasePlanner` is the interface a planning strategy implements. A planner adds a
system instruction to the request that goes to the model, and it post-processes
the parts that come back. Reach for it when you want the model to plan before it
acts, and you want that policy in one place instead of spread over prompts.

## Introduction

Planning is two edits to one turn. Before the call, something has to tell the
model how to plan. After the call, something has to decide what to do with the
parts the model produced — keep the reasoning, drop it, or rewrite it. Those two
edits belong together, because a planner that asks for tagged output must also
know how to read that output back.

`BasePlanner` is the seam for that pair. `buildPlanningInstruction` receives a
`ReadonlyContext` and the `LlmRequest` under construction, and returns the
instruction to append. `processPlanningResponse` receives a `Context` and the
model's response parts, and returns the parts to keep. Both members may return
`undefined`, which means "nothing to contribute" — a caller treats it as a
no-op, not as an error.

The two contexts differ on purpose. The request side gets `ReadonlyContext`,
because building an instruction must not change the invocation. The response
side gets `Context`, so a planner can write to `state` and have the change ride
out on the event that the caller emits.

`@google/adk` ships no concrete planner today, and no agent field or flow calls
one. This class is the base that a planner extends, and `isBasePlanner` is how a
caller finds one. Both are usable now by code that drives a planner itself, as
the example below does.

## Get started

A planner that asks the model to plan, then removes the model's thoughts from
the answer.

```ts
import {
  BasePlanner,
  Context,
  InvocationContext,
  LlmRequest,
  ReadonlyContext,
} from '@google/adk';
import {Part} from '@google/genai';

class ThoughtStrippingPlanner extends BasePlanner {
  buildPlanningInstruction(
    readonlyContext: ReadonlyContext,
    llmRequest: LlmRequest,
  ): string | undefined {
    if (llmRequest.contents.length === 0) {
      return undefined;
    }
    return `Plan before you act, ${readonlyContext.agentName}.`;
  }

  processPlanningResponse(
    callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    return responseParts.filter((part) => !part.thought);
  }
}

function plan(invocationContext: InvocationContext, llmRequest: LlmRequest) {
  const planner = new ThoughtStrippingPlanner();

  const instruction = planner.buildPlanningInstruction(
    new ReadonlyContext(invocationContext),
    llmRequest,
  );

  const parts: Part[] = [{text: 'thinking', thought: true}, {text: 'answer'}];
  const kept = planner.processPlanningResponse(
    new Context({invocationContext}),
    parts,
  );

  return {instruction, parts: kept ?? parts};
}
```

## Detect a planner

Use the `isBasePlanner` type guard, not `instanceof`. When two copies of
`@google/adk` load in one runtime, an object built by one copy fails
`instanceof` against the class from the other. The guard checks a registry
symbol, so it holds across copies.

```ts
import {BasePlanner, isBasePlanner} from '@google/adk';

function asPlanner(candidate: unknown): BasePlanner | undefined {
  return isBasePlanner(candidate) ? candidate : undefined;
}
```

`isBasePlanner` never throws. It returns `false` for `null`, `undefined`,
primitives, and plain objects.

## What a subclass must honour

- **Return `undefined` for "no change".** The caller keeps the original
  instruction or the original parts.
- **An empty array is not `undefined`.** Returning `[]` from
  `processPlanningResponse` means the planner consumed every part. Do not
  conflate the two.
- **Treat `llmRequest` and `responseParts` as readonly.** The types do not
  enforce it. To change the parts, return a new array, as the example does.
- **Implement both members.** They are `abstract`, so a subclass that omits one
  fails to compile.
