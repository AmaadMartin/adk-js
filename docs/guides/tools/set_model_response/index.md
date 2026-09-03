# SetModelResponseTool

Lets an agent return structured output on a model that cannot accept an output
schema and tools in the same request. The agent's `outputSchema` becomes the
parameters of a `set_model_response` tool, and the tool validates what the model
puts in it.

## Introduction

Vertex AI with a Gemini 2.0 or later model accepts a response schema and tools
together, so ADK sets `config.responseSchema` and the model answers in JSON. Any
other combination rejects that request. For those, `LlmAgent` declares a
`set_model_response` tool instead: the model calls it with the answer as the
call arguments.

`SetModelResponseTool` is what makes that path safe. A function call is
model-generated text, so its arguments can violate the schema the model was
given. The tool validates them, and on failure it returns an error naming the
bad fields rather than throwing. The model reads that error as an ordinary
function response and calls again, so a malformed answer costs one extra turn
instead of ending the turn with bad data.

You do not construct the tool. `LlmAgent` creates it when the model needs it,
which is whenever the agent has both an `outputSchema` and at least one tool and
`canUseOutputSchemaWithTools` returns false for the model.

## Get started

Give the agent an output schema and a tool. Nothing else is needed.

```ts
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod/v4';

const lookupTool = new FunctionTool({
  name: 'lookup',
  description: 'Looks a person up by name.',
  execute: () => ({age: 25, city: 'Seattle'}),
});

const agent = new LlmAgent({
  name: 'extractor',
  model: 'gemini-1.5-pro',
  tools: [lookupTool],
  outputKey: 'person',
  outputSchema: z.object({
    name: z.string().describe("A person's name"),
    age: z.number().describe("A person's age"),
    tags: z.array(z.string()).default([]),
  }),
});
```

The model calls `lookup`, then calls `set_model_response({name, age})`. The
agent's last event carries the validated object as JSON text, and `outputKey`
receives the validated value. `tags` may be absent, because a field with a
default is not advertised to the model as required.

## What the model sees

The tool's parameters follow the shape of the output schema.

| Output schema                                                 | Parameters                             |
| ------------------------------------------------------------- | -------------------------------------- |
| An object schema                                              | One parameter per field                |
| An array of objects                                           | A single required `items` parameter    |
| Anything else (an array of primitives, a record, a primitive) | A single required `response` parameter |

Field descriptions and defaults reach the declaration, at the top level and
inside nested objects and array items, so the model sees the same guidance it
would get from a native response schema.

## Validation and retry

The tool validates the arguments against the schema as you supplied it, not the
converted form, so Zod refinements and defaults are enforced.

On success it publishes the validated value on
`event.actions.setModelResponse`, and the agent turns that into its final model
event. On failure it publishes nothing and returns:

```
{
  error: 'Validation Error found:\nage: Invalid input: expected number, received string\nRecall the set_model_response function correctly, fix the errors, and call it again with all required fields using the correct types.'
}
```

Each line before the retry sentence is one failing field, written as
`path: message`. A failure inside an array element keeps its index, so the first
element's `id` field reads `0.id`.

Because the value is published only on success, a failed call leaves the agent
loop running and the model gets another turn.

## Limits

A schema written as a genai `Schema` is validated only when it can be compiled
to a validator. `parseWithSchema` returns such a value unchecked rather than
rejecting it, so a schema using constructs Zod cannot express is passed through.

The live API path does not use this tool. An agent using `outputSchema` with
tools over a live connection produces no structured output.
