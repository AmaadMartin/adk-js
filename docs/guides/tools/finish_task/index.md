# FinishTaskTool

Gives a task-mode `LlmAgent` the `finish_task` tool it completes its turn with.
The tool declares the agent's output schema as its parameters, checks the
model's arguments against that schema, and answers with a retry message when
they do not match. You never construct it: a task-mode agent creates one.

## Introduction

An agent in `task` mode runs a multi-round loop instead of ending after one
reply. Something has to say when the task is done and what it produced, and
`finish_task` is that signal. The workflow layer watches for the call, and on a
successful response promotes the call's arguments to the node's output.

That makes the arguments a contract, not a message, so the tool enforces the
agent's `outputSchema` on them. A wrong-typed value would otherwise flow
straight into the node output and fail somewhere further downstream, where the
model can no longer correct it. Enforcing it here keeps the failure local: the
tool answers with a validation error, the loop keeps running, and the model gets
another turn.

The check is two-stage. The tool first reports any required key the arguments
omit, then parses the value against the schema. The first stage is the floor:
`parseWithSchema` returns a value unvalidated for a schema it cannot compile, so
without it such a schema would be checked not at all.

## Get started

Declare a task-mode agent with an output schema. The tool comes with it.

```ts
import {LlmAgent} from '@google/adk';
import {z} from 'zod/v4';

const reporter = new LlmAgent({
  name: 'reporter',
  model: 'gemini-2.5-flash',
  mode: 'task',
  instruction: 'Summarise the incident, then finish the task.',
  outputSchema: z.object({summary: z.string(), severity: z.number().int()}),
});
```

The agent declares `finish_task` to the model with those two fields as its
parameters, and appends `FINISH_TASK_INSTRUCTION` to the request so the model
knows not to call it early.

## What a validation failure returns

A call carrying `severity: 'high'` is answered with an error payload rather than
an exception:

```
Invoking `finish_task()` failed due to validation errors:
severity: Invalid input: expected number, received string
You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters with correct types.
```

The payload is data, so the model reads it as a tool response and can call
`finish_task` again. Only `FINISH_TASK_SUCCESS_RESULT` (`'Task completed.'`)
ends the task, so a validation failure leaves the loop running.

## Non-object schemas and the `result` wrapper

The GenAI API requires object-typed tool parameters, so a schema that is not an
object is wrapped under one key. `getOutputWrapperKey` reports which:

```ts
import {getOutputWrapperKey} from '@google/adk';
import {z} from 'zod/v4';

getOutputWrapperKey(z.object({summary: z.string()})); // undefined
getOutputWrapperKey(z.array(z.string())); // 'result'
getOutputWrapperKey(); // undefined — the default schema is an object
```

An agent declaring `outputSchema: z.array(z.string())` therefore takes its
output under `result`:

```json
{
  "type": "object",
  "properties": {"result": {"type": "array", "items": {"type": "string"}}},
  "required": ["result"]
}
```

`extractOutput` reverses the wrapping, so a caller reading the node output sees
the array itself rather than the wrapper.

Wrapping moves the schema into a property, which would take its `$defs` block
with it and leave every `#/$defs/...` pointer dangling. The tool lifts `$defs`
and `$schema` back to the root of the parameters document, so the pointers still
resolve.

The decision keys off the schema's declared `type` alone, matching adk-python. A
schema that lists `properties` but declares no `type` counts as a non-object and
is wrapped.

## Declaring and validating against different schemas

The constructor takes the schema twice. The first is what the model is shown,
the second is what its arguments are checked against. `LlmAgent` passes its
converted `outputSchema` and then `outputSchemaSource` — the schema as you wrote
it — because rendering a Zod schema into the genai dialect drops refinements:

```ts
import {FinishTaskTool} from '@google/adk';
import {z} from 'zod/v4';

const declared = z.object({count: z.number().int()});
const tool = new FinishTaskTool(
  declared,
  declared.refine((value) => value.count % 2 === 0, 'count must be even'),
);
```

Passing one schema uses it for both. The declaration always comes from the
first, so checking against a stricter second does not change what the model
sees.
